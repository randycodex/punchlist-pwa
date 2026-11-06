import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createArea, createCheckpoint, createItem, createLocation, createPhotoAttachment, createProject,
  getPendingSharedAreaSyncsForProject, getProject, saveCheckpointInspectionChange, saveProjectPreserveTimestamps,
} from '@/lib/db';
import { getAreaStats, type Checkpoint } from '@/types';
import { buildProjectReviewList } from '@/features/projects/reviewList';
import { listCaptureDrafts, restoreCaptureDraft, saveRecoverablePhotos } from '@/features/inspection/captureRecovery';

async function fixture(initial: Partial<Checkpoint> = {}) {
  const project = createProject('Automatic issue trial');
  project.sharedProjectId = `team-${project.id}`;
  project.sharedSnapshotPublishedAt = new Date();
  const area = createArea(project.id, '306', 0);
  const room = createLocation(area.id, 'Kitchen', 0);
  const item = createItem(room.id, 'Cabinets', 0);
  const checkpoint = Object.assign(createCheckpoint(item.id, 'Hardware', 0), initial);
  const untouched = createCheckpoint(item.id, 'Finish', 1);
  item.checkpoints.push(checkpoint, untouched);
  room.items.push(item);
  area.locations.push(room);
  project.areas.push(area);
  await saveProjectPreserveTimestamps(project);
  const read = async () => (await getProject(project.id))!.areas[0].locations[0].items[0].checkpoints[0];
  return { project, area, checkpoint, untouched, read };
}

const openIssue = { status: 'needsReview', issueState: 'open', fixStatus: 'pending' };
afterEach(() => { vi.restoreAllMocks(); });

describe('automatic issues from inspection captures', () => {
  it.each([
    { status: 'pending' as const },
    { status: 'ok' as const },
    { isCustom: true },
  ])('opens an issue when a photo is added to an unflagged checkpoint: %j', async (initial) => {
    const { project, area, checkpoint, untouched, read } = await fixture(initial);
    const photo = createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=', 'data:image/jpeg;base64,dGh1bWI=');
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, {}, [photo]);
    const saved = await read();
    expect(saved).toMatchObject(openIssue);
    expect(saved.photos).toEqual([photo]);
    const stored = (await getProject(project.id))!;
    expect(stored.areas[0].locations[0].items[0].checkpoints[1]).toEqual(untouched);
    expect(getAreaStats(stored.areas[0]).issues).toBe(1);
    expect(buildProjectReviewList(stored)).toEqual([expect.objectContaining({ id: checkpoint.id, issueState: 'open', photoCount: 1 })]);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(1);
  });

  it.each(['pending', 'ok'] as const)('opens an issue for a new note on a %s checkpoint', async (status) => {
    const { project, area, checkpoint, read } = await fixture({ status });
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments: 'Adjust hinge' });
    expect(await read()).toMatchObject({ ...openIssue, comments: 'Adjust hinge' });
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(1);
  });

  it.each(['', ' \n\t'])('does not open an issue for an empty note: %j', async (comments) => {
    const { project, area, checkpoint, read } = await fixture();
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments });
    expect(await read()).toMatchObject({ status: 'pending', issueState: 'none', comments });
  });

  it.each([
    { issueState: 'resolved' as const, fixStatus: 'fixed' as const },
    { issueState: 'verified' as const, fixStatus: 'verified' as const },
    { issueState: undefined, fixStatus: 'fixed' as const },
    { issueState: undefined, fixStatus: 'verified' as const },
  ])('preserves existing issue resolution when adding notes or photos: %j', async (state) => {
    const { project, area, checkpoint, read } = await fixture({ ...state, status: 'needsReview', isCustom: true });
    const photo = createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=');
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments: 'Repair evidence' }, [photo]);
    expect(await read()).toMatchObject({ ...state, status: 'needsReview', comments: 'Repair evidence' });
    expect((await read()).photos).toHaveLength(1);
  });

  it('does not reopen a manually cleared issue when the same capture is retried', async () => {
    const { project, area, checkpoint, read } = await fixture();
    const photo = createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=');
    const note = { comments: 'Adjust hinge' };
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, note, [photo]);
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { status: 'pending', issueState: 'none', fixStatus: 'pending' });
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, note, [photo]);
    expect(await read()).toMatchObject({ status: 'pending', issueState: 'none', comments: note.comments });
    expect((await read()).photos).toHaveLength(1);
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments: 'A new finding' });
    expect(await read()).toMatchObject(openIssue);
  });

  it('keeps an issue after its photo or note is removed, until explicitly cleared', async () => {
    const { project, area, checkpoint, read } = await fixture();
    const photo = createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=');
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments: 'Adjust hinge' }, [photo]);
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments: '' }, [], { removePhotoIds: [photo.id] });
    expect(await read()).toMatchObject({ ...openIssue, comments: '', photos: [], deletedPhotoIds: [photo.id] });
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { status: 'ok', issueState: 'none', fixStatus: 'pending' });
    expect(await read()).toMatchObject({ status: 'ok', issueState: 'none' });
  });

  it('keeps concurrent note and photo saves on the same checkpoint with one issue', async () => {
    const { project, area, checkpoint, read } = await fixture();
    const photo = createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=');
    await Promise.all([
      saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments: 'Adjust hinge' }),
      saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, {}, [photo]),
    ]);
    expect(await read()).toMatchObject({ ...openIssue, comments: 'Adjust hinge', photos: [photo] });
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(1);
  });

  it('rolls back issue and photo together on queue failure, retaining the photo for recovery', async () => {
    const { project, area, checkpoint, read } = await fixture();
    const photo = createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=');
    const original = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      if (this.name === 'sharedAreaSyncQueue') throw new DOMException('Storage full', 'QuotaExceededError');
      return original.apply(this, args);
    });
    await expect(saveRecoverablePhotos(project.id, area.id, checkpoint.id, [photo])).rejects.toThrow('Storage full');
    failure.mockRestore();
    expect(await read()).toMatchObject({ status: 'pending', issueState: 'none', photos: [] });
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(0);
    const [draft] = await listCaptureDrafts(project.id, area.id);
    expect(draft).toMatchObject({ kind: 'photo', photo });
    await restoreCaptureDraft(draft);
    expect(await read()).toMatchObject({ ...openIssue, photos: [photo] });
    expect(await listCaptureDrafts(project.id, area.id)).toHaveLength(0);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(1);
  });
});
