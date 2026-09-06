import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteProject, createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment, saveProjectPreserveTimestamps, saveCheckpointInspectionChange, getProject } from '@/lib/db';
import { saveRecoverableNote, saveRecoverablePhotos, listCaptureDrafts, restoreCaptureDraft, stageCaptureDraft, clearCaptureDraft, type CaptureDraft } from '@/features/inspection/captureRecovery';
import { inspectOfflineProject, isOfflinePage } from '@/features/offline/sitePreparation';

async function fixture() {
  const project = createProject('Recovery trial');
  project.sharedProjectId = `team-${project.id}`; project.sharedSnapshotPublishedAt = new Date();
  const area = createArea(project.id, '306', 0); const room = createLocation(area.id, 'Kitchen', 0);
  const item = createItem(room.id, 'Cabinets', 0); const checkpoint = createCheckpoint(item.id, 'Hardware', 0);
  item.checkpoints.push(checkpoint); room.items.push(item); area.locations.push(room); project.areas.push(area);
  await saveProjectPreserveTimestamps(project); return { project, area, checkpoint };
}
function failQueue() {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
    if (this.name === 'sharedAreaSyncQueue') throw new DOMException('Storage full', 'QuotaExceededError');
    return original.apply(this, args);
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('interrupted capture recovery', () => {
  it('journals every draft but coalesces typing into one inspection write', async () => {
    const { project, area, checkpoint } = await fixture();
    const original = IDBObjectStore.prototype.put; let projectWrites = 0;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      if (this.name === 'projects') projectWrites += 1;
      return original.apply(this, args);
    });
    const results = await Promise.all(['A', 'Adjust', 'Adjust hinge'].map((value) => saveRecoverableNote(project.id, area.id, checkpoint.id, value, '')));
    expect(results).toEqual([false, false, true]); expect(projectWrites).toBe(1);
    expect((await getProject(project.id))?.areas[0].locations[0].items[0].checkpoints[0].comments).toBe('Adjust hinge');
    expect(await listCaptureDrafts(project.id, area.id)).toHaveLength(0);
  });
  it('retains a note before a failed inspection commit and restores it from a new journal connection', async () => {
    const { project, area, checkpoint } = await fixture(); const failure = failQueue();
    await expect(saveRecoverableNote(project.id, area.id, checkpoint.id, 'Adjust hinge', '')).rejects.toThrow();
    failure.mockRestore();
    const drafts = await listCaptureDrafts(project.id, area.id); expect(drafts).toHaveLength(1);
    await restoreCaptureDraft(drafts[0]);
    expect((await getProject(project.id))?.areas[0].locations[0].items[0].checkpoints[0].comments).toBe('Adjust hinge');
    expect(await listCaptureDrafts(project.id, area.id)).toHaveLength(0);
  });
  it('preserves newer notes when an interrupted note is restored', async () => {
    const { project, area, checkpoint } = await fixture(); const failure = failQueue();
    await expect(saveRecoverableNote(project.id, area.id, checkpoint.id, 'Recovered finding', '')).rejects.toThrow(); failure.mockRestore();
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments: 'Newer team note' });
    const draft = (await listCaptureDrafts(project.id, area.id))[0];
    await restoreCaptureDraft(draft);
    // Model termination after the canonical write but before journal deletion.
    await stageCaptureDraft(draft);
    await restoreCaptureDraft(draft);
    expect((await getProject(project.id))?.areas[0].locations[0].items[0].checkpoints[0].comments).toBe('Newer team note\nRecovered finding');
  });
  it('retains photo payload and survives a crash after commit before journal cleanup without duplication', async () => {
    const { project, area, checkpoint } = await fixture(); const failure = failQueue();
    const photo = createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=');
    await expect(saveRecoverablePhotos(project.id, area.id, checkpoint.id, [photo])).rejects.toThrow(); failure.mockRestore();
    const draft = (await listCaptureDrafts(project.id, area.id))[0];
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, {}, [photo]);
    await restoreCaptureDraft(draft);
    const photos = (await getProject(project.id))?.areas[0].locations[0].items[0].checkpoints[0].photos;
    expect(photos).toHaveLength(1); expect(photos?.[0].imageData).toBe(photo.imageData);
  });
  it('cannot remove or restore a newer draft through an earlier revision', async () => {
    const { project, area, checkpoint } = await fixture();
    const first: CaptureDraft = { key: `test:${checkpoint.id}`, revision: 'first', projectId: project.id, areaId: area.id, checkpointId: checkpoint.id, savedAt: new Date(), kind: 'note', value: 'Old', baseValue: '' };
    await stageCaptureDraft(first); await stageCaptureDraft({ ...first, revision: 'second', value: 'Latest' });
    await clearCaptureDraft(first);
    expect((await listCaptureDrafts(project.id, area.id))[0].revision).toBe('second');
    await expect(restoreCaptureDraft(first)).rejects.toThrow('already been saved or changed');
  });
  it('purges recovery evidence when its project is permanently deleted', async () => {
    const { project, area, checkpoint } = await fixture(); const failure = failQueue();
    await expect(saveRecoverableNote(project.id, area.id, checkpoint.id, 'Draft to remove', '')).rejects.toThrow(); failure.mockRestore();
    await deleteProject(project.id);
    expect(await listCaptureDrafts(project.id, area.id)).toHaveLength(0);
  });
  it('reports missing local media and shared-edit limitations during preparation', async () => {
    const { project, checkpoint } = await fixture(); checkpoint.photos.push(createPhotoAttachment(checkpoint.id, ''));
    const result = inspectOfflineProject(project); expect(result.missingMedia).toBe(1); expect(result.shared).toBe(true); expect(result.paths).toHaveLength(3);
    expect(isOfflinePage('/api/auth')).toBe(false); expect(isOfflinePage('/project/id/area/area-id')).toBe(true); expect(isOfflinePage('//other.test')).toBe(false);
  });
});

 describe('retained voice recordings', () => {
  it('retains audio through a failed note save and restores without duplicating the transcript', async () => {
    const { project, area, checkpoint } = await fixture();
    const draft: CaptureDraft = { key: `voice:${project.id}:test`, revision: 'voice-test', projectId: project.id, areaId: area.id, checkpointId: checkpoint.id, savedAt: new Date(), kind: 'voice', audio: new Float32Array([0.2, 0.3]), transcript: 'Adjust hinge' };
    await stageCaptureDraft(draft);
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments: 'Existing observation' });
    const failure = failQueue(); await expect(restoreCaptureDraft(draft)).rejects.toThrow(); failure.mockRestore();
    const retained = (await listCaptureDrafts(project.id, area.id))[0];
    expect(retained.kind === 'voice' && retained.audio.length).toBe(2);
    await restoreCaptureDraft(retained);
    await stageCaptureDraft(draft); await restoreCaptureDraft(draft);
    expect((await getProject(project.id))?.areas[0].locations[0].items[0].checkpoints[0].comments).toBe('Existing observation\nAdjust hinge');
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments: 'Existing observation Adjust hinge' });
    await stageCaptureDraft(draft); await restoreCaptureDraft(draft);
    expect((await getProject(project.id))?.areas[0].locations[0].items[0].checkpoints[0].comments).toBe('Existing observation Adjust hinge');
  });
  it('keeps untranscribed audio for retry and purges it when its project is deleted', async () => {
    const { project, area, checkpoint } = await fixture();
    const draft: CaptureDraft = { key: `voice:${project.id}:test`, revision: 'voice-test', projectId: project.id, areaId: area.id, checkpointId: checkpoint.id, savedAt: new Date(), kind: 'voice', audio: new Float32Array([0.2]) };
    await stageCaptureDraft(draft); await expect(restoreCaptureDraft(draft)).rejects.toThrow('Transcribe');
    expect(await listCaptureDrafts(project.id, area.id)).toHaveLength(1);
    await deleteProject(project.id); expect(await listCaptureDrafts(project.id, area.id)).toHaveLength(0);
  });
});
