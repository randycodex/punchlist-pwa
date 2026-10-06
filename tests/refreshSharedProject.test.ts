import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { newer, pull } = vi.hoisted(() => ({ newer: vi.fn(), pull: vi.fn() }));
vi.mock('@/lib/collaboration/sharedProjectSnapshots', () => ({ hasNewerSharedProjectRevisions: newer }));
vi.mock('@/features/collaboration/manualSharedPull', () => ({ getPendingSharedPullState: pull }));
import { refreshSharedProject } from '@/features/sync/refreshSharedProject';
import { createArea, createProject, deleteProject, getProject, saveAreaNotes, saveProjectPreserveTimestamps } from '@/lib/db';
import { stageCaptureDraft } from '@/lib/captureJournal';

let id: string;
let areaId: string;
beforeEach(async () => {
  vi.resetAllMocks();
  const project = createProject('Browser sharing');
  id = project.id;
  project.sharedProjectId = crypto.randomUUID();
  project.sharedSnapshotPublishedAt = new Date('2026-10-01T00:00:00Z');
  project.sharedBaselinePublishedAt = project.sharedSnapshotPublishedAt;
  project.areas = [createArea(id, 'Unit 201', 0)];
  areaId = project.areas[0].id;
  await saveProjectPreserveTimestamps(project);
  newer.mockResolvedValue(true);
  pull.mockImplementation(async (local) => ({
    resolutionProject: { ...local, areas: local.areas.map((area: typeof local.areas[number]) => ({ ...area, notes: 'Saved in another browser', sharedVersion: 2 })) },
    hasNewerLocalChanges: false, conflictingAreaNames: [], preservedLocalAreaCount: 0, preservedLocalProjectMetadata: false,
  }));
});
afterEach(async () => { await deleteProject(id); });

describe('automatic Team refresh', () => {
  it('downloads a newer clean copy from another browser without releasing any locks', async () => {
    expect(await refreshSharedProject(id)).toBe('updated');
    expect((await getProject(id))?.areas[0].notes).toBe('Saved in another browser');
  });
  it('does not download unchanged work', async () => {
    newer.mockResolvedValue(false);
    expect(await refreshSharedProject(id)).toBe('current');
    expect(pull).not.toHaveBeenCalled();
  });
  it('keeps unsent local edits and asks for review', async () => {
    await saveAreaNotes(id, areaId, 'Unsent local note');
    expect(await refreshSharedProject(id)).toBe('review');
    expect(pull).not.toHaveBeenCalled();
    expect((await getProject(id))?.areas[0].notes).toBe('Unsent local note');
  });
  it('keeps edits saved during a download', async () => {
    const implementation = pull.getMockImplementation()!;
    pull.mockImplementation(async (local) => {
      const result = await implementation(local);
      await saveAreaNotes(id, areaId, 'New local work during download');
      return result;
    });
    expect(await refreshSharedProject(id)).toBe('deferred');
    expect((await getProject(id))?.areas[0].notes).toBe('New local work during download');
  });
  it('keeps notes staged during a download even before the project is saved', async () => {
    const implementation = pull.getMockImplementation()!;
    pull.mockImplementation(async (local) => {
      const result = await implementation(local);
      await stageCaptureDraft({ key: `area-note:${id}:${areaId}`, revision: 'draft', projectId: id, areaId,
        checkpointId: '', savedAt: new Date(), kind: 'area-note', value: 'Retained note', baseValue: '' });
      return result;
    });
    expect(await refreshSharedProject(id)).toBe('deferred');
    expect((await getProject(id))?.areas[0].notes).toBe('');
  });
  it('defers when navigation or account switching changes permission during download', async () => {
    let allowed = true;
    const implementation = pull.getMockImplementation()!;
    pull.mockImplementation(async (local) => { const result = await implementation(local); allowed = false; return result; });
    expect(await refreshSharedProject(id, () => allowed)).toBe('deferred');
    expect((await getProject(id))?.areas[0].notes).toBe('');
  });
  it('keeps a detected conflict for explicit review', async () => {
    const implementation = pull.getMockImplementation()!;
    pull.mockImplementation(async (local) => ({ ...await implementation(local), conflictingAreaNames: ['Unit 201'] }));
    expect(await refreshSharedProject(id)).toBe('review');
    expect((await getProject(id))?.areas[0].notes).toBe('');
  });
});
