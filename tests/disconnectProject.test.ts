import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ backup: vi.fn(), disconnect: vi.fn() }));
vi.mock('@/lib/collaboration/sharedProjectSnapshots', () => ({ captureSharedProjectBackup: mocks.backup }));
vi.mock('@/lib/collaboration/sharedProjects', async (original) => ({
  ...await original<typeof import('@/lib/collaboration/sharedProjects')>(),
  disconnectSharedProject: mocks.disconnect,
}));
import {
  createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment,
  getProject, saveProjectPreserveTimestamps, saveAreaNotes, saveProjectArea,
  saveProjectMetadataWithSharedSync, getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject, detachSavedSharedProject,
} from '@/lib/db';
import { stageCaptureDraft, listCaptureDrafts } from '@/lib/captureJournal';
import {
  disconnectSavedProject, disconnectProjectAccess, DisconnectProjectError,
  DISCONNECT_BACKUP_TIMEOUT_MS, type DisconnectProjectStage,
} from '@/features/collaboration/disconnectProject';
import { CollaborationRequestTimeoutError } from '@/lib/collaboration/request';

beforeEach(() => {
  mocks.backup.mockReset().mockResolvedValue('saved-backup');
  mocks.disconnect.mockReset().mockResolvedValue({ action: 'left', projectId: 'shared' });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture() {
  const project = createProject('Leave fixture');
  project.sharedProjectId = crypto.randomUUID();
  project.sharedSnapshotPublishedAt = new Date('2026-10-22T12:00:00Z');
  const area = createArea(project.id, 'Unit 1', 0);
  const room = createLocation(area.id, 'Room', 0);
  const item = createItem(room.id, 'Wall', 0);
  const checkpoint = createCheckpoint(item.id, 'Finish', 0);
  checkpoint.photos.push(createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=', 'data:image/jpeg;base64,dGh1bWI='));
  item.checkpoints.push(checkpoint); room.items.push(item); area.locations.push(room); project.areas.push(area);
  await saveProjectPreserveTimestamps(project);
  await saveAreaNotes(project.id, area.id, 'Unsent inspection note');
  const latest = (await getProject(project.id))!;
  latest.address = 'Unsent address';
  await saveProjectMetadataWithSharedSync(latest);
  await stageCaptureDraft({ key: `note:${project.id}:${checkpoint.id}`, revision: crypto.randomUUID(), projectId: project.id, areaId: area.id, checkpointId: checkpoint.id, kind: 'note', value: 'Draft still being edited', baseValue: '', savedAt: new Date() });
  expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(1);
  expect(await getPendingSharedProjectMetadataSyncForProject(project.id)).toBeDefined();
  return { project: (await getProject(project.id))!, area, checkpoint };
}

async function state(projectId: string, areaId: string) {
  return {
    project: await getProject(projectId),
    areas: await getPendingSharedAreaSyncsForProject(projectId),
    metadata: await getPendingSharedProjectMetadataSyncForProject(projectId),
    drafts: await listCaptureDrafts(projectId, areaId),
  };
}

describe('leaving a saved project', () => {
  it('reports the backup stage while it waits and does not request leave until the backup succeeds', async () => {
    const { project } = await fixture();
    let finishBackup!: () => void;
    mocks.backup.mockImplementation(() => new Promise<void>((resolve) => { finishBackup = resolve; }));
    let reachedBackup!: () => void;
    const backupStarted = new Promise<void>((resolve) => { reachedBackup = resolve; });
    const stages: DisconnectProjectStage[] = [];
    const result = disconnectSavedProject(project, { onStage(stage) {
      stages.push(stage); if (stage === 'backup') reachedBackup();
    } });
    await backupStarted;
    expect(stages).toEqual(['loading', 'backup']);
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect((await getProject(project.id))?.sharedProjectId).toBe(project.sharedProjectId);
    finishBackup();
    const finished = await result;
    expect(stages).toEqual(['loading', 'backup', 'disconnect', 'local']);
    expect(finished.action).toBe('left');
    expect(finished.localProject.sharedProjectId).toBeUndefined();
    expect(mocks.backup.mock.calls[0][0].areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('data:image/jpeg;base64,cGhvdG8=');
  });

  it.each([
    new CollaborationRequestTimeoutError('Saving shared backup', 90_000),
    { message: 'canceling statement due to statement timeout', code: '57014' },
    new TypeError('Failed to fetch'),
  ])('keeps photos, unsent queues and drafts intact when backup fails: %s', async (failure) => {
    const { project, area } = await fixture();
    const before = await state(project.id, area.id);
    mocks.backup.mockRejectedValue(failure);
    await expect(disconnectSavedProject(project, { onStage() {} })).rejects.toThrow('We stopped before requesting any access change');
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(await state(project.id, area.id)).toEqual(before);
  });

  it('bounds a stalled backup and ignores a late success without leaving or clearing pending work', async () => {
    const { project, area } = await fixture();
    const before = await state(project.id, area.id);
    let finishBackup!: () => void;
    mocks.backup.mockImplementation(() => new Promise<void>((resolve) => { finishBackup = resolve; }));
    let reachedBackup!: () => void;
    const backupStarted = new Promise<void>((resolve) => { reachedBackup = resolve; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = disconnectSavedProject(project, { onStage(stage) { if (stage === 'backup') reachedBackup(); } });
    const rejected = expect(result).rejects.toThrow('Saving the shared backup timed out');
    await backupStarted;
    await vi.advanceTimersByTimeAsync(DISCONNECT_BACKUP_TIMEOUT_MS);
    await rejected;
    finishBackup();
    await Promise.resolve();
    vi.useRealTimers();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(await state(project.id, area.id)).toEqual(before);
  });

  it('retains edits and newly saved photos made during backup instead of saving the old snapshot over them', async () => {
    const { project, area } = await fixture();
    const unrelated = await fixture();
    const unrelatedBefore = await state(unrelated.project.id, unrelated.area.id);
    mocks.backup.mockImplementation(async () => {
      const newer = (await getProject(project.id))!;
      newer.areas[0].notes = 'Edited while leaving';
      const checkpoint = newer.areas[0].locations[0].items[0].checkpoints[0];
      checkpoint.photos.push(createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,bmV3', 'data:image/jpeg;base64,bmV3'));
      await saveProjectArea(newer, area.id);
      newer.projectName = 'Renamed while leaving';
      await saveProjectMetadataWithSharedSync(newer);
      return 'saved-backup';
    });
    const { localProject } = await disconnectSavedProject(project, { onStage() {} });
    expect(localProject.projectName).toBe('Renamed while leaving');
    expect(localProject.areas[0].notes).toBe('Edited while leaving');
    expect(localProject.areas[0].locations[0].items[0].checkpoints[0].photos.map((photo) => photo.imageData))
      .toEqual(['data:image/jpeg;base64,cGhvdG8=', 'data:image/jpeg;base64,bmV3']);
    expect(await listCaptureDrafts(project.id, area.id)).toHaveLength(1);
    expect(localProject.detachedSharedProjectId).toBe(project.sharedProjectId);
    // Confirmed detach stops team uploads; the actual inspection work stays local.
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual([]);
    expect(await getPendingSharedProjectMetadataSyncForProject(project.id)).toBeUndefined();
    expect(await state(unrelated.project.id, unrelated.area.id)).toEqual(unrelatedBefore);
  });

  it('reports an uncertain leave response without changing local data or queues', async () => {
    const { project, area } = await fixture();
    const before = await state(project.id, area.id);
    mocks.disconnect.mockRejectedValue(new CollaborationRequestTimeoutError());
    await expect(disconnectSavedProject(project, { onStage() {} })).rejects.toThrow('Your access may already have changed');
    expect(mocks.backup).toHaveBeenCalledTimes(1);
    expect(await state(project.id, area.id)).toEqual(before);
  });

  it('rolls back local detach and queue cleanup together when a local write fails', async () => {
    const { project, area } = await fixture();
    const before = await state(project.id, area.id);
    const original = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function(this: IDBObjectStore, key) {
      if (this.name === 'sharedAreaSyncQueue') throw new DOMException('Disk full', 'QuotaExceededError');
      return original.call(this, key);
    });
    await expect(disconnectSavedProject(project, { onStage() {} })).rejects.toThrow('The local disconnect could not be completed');
    expect(await state(project.id, area.id)).toEqual(before);
  });

  it('does not detach a replacement team link', async () => {
    const { project, area } = await fixture();
    const before = await state(project.id, area.id);
    await expect(detachSavedSharedProject(project.id, 'different-team')).rejects.toThrow('team link changed');
    expect(await state(project.id, area.id)).toEqual(before);
  });

  it('keeps backup-before-archive behavior for the project owner', async () => {
    const { project } = await fixture();
    mocks.disconnect.mockResolvedValue({ action: 'archived', projectId: project.sharedProjectId });
    const result = await disconnectSavedProject(project, { onStage() {} });
    expect(result.action).toBe('archived');
    expect(mocks.backup.mock.invocationCallOrder[0]).toBeLessThan(mocks.disconnect.mock.invocationCallOrder[0]);
    expect(result.localProject.areas).toEqual(project.areas);
  });

  it('keeps the local-only recovery path offline and preserves inspection data', async () => {
    const { project } = await fixture();
    const stages: DisconnectProjectStage[] = [];
    const result = await disconnectSavedProject(project, { localOnly: true, onStage: (stage) => { stages.push(stage); } });
    expect(stages).toEqual(['loading', 'local']);
    expect(result.action).toBe('local-only');
    expect(result.localProject.areas).toEqual(project.areas);
    expect(mocks.backup).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it('bounds a stalled directory leave and reports the unconfirmed server outcome', async () => {
    mocks.disconnect.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const result = disconnectProjectAccess('shared');
    const rejected = expect(result).rejects.toThrow('Your access may already have changed');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(mocks.disconnect.mock.calls[0][1].aborted).toBe(true);
  });

  it('does not describe an authorization failure as a timeout', () => {
    expect(new DisconnectProjectError('backup', { message: 'Permission denied' }).message).toContain('Permission denied');
    expect(new DisconnectProjectError('backup', { message: 'Permission denied' }).message).not.toContain('timed out');
  });
});
