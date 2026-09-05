import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment, saveProjectPreserveTimestamps, saveCheckpointInspectionChange, getProject, getPendingSharedAreaSyncsForProject, saveProjectAreaMetadataOnly } from '@/lib/db';
import { parseProjectPayload, serializeProjectPayload } from '@/lib/projectPayload';
import { isAreaInspectionComplete } from '@/types';
import { nextInspectionPosition } from '@/features/inspection/inspectionPosition';

async function fixture() {
  const project = createProject('Inspection trial');
  project.sharedProjectId = `team-${project.id}`;
  project.sharedSnapshotPublishedAt = new Date();
  const area = createArea(project.id, '306', 0);
  const location = createLocation(area.id, 'Kitchen', 0);
  const item = createItem(location.id, 'Cabinets', 0);
  const first = createCheckpoint(item.id, 'Hardware', 0);
  const second = createCheckpoint(item.id, 'Finish', 1);
  item.checkpoints.push(first, second); location.items.push(item); area.locations.push(location); project.areas.push(area);
  await saveProjectPreserveTimestamps(project);
  return { project, area, location, item, first, second };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('field inspection persistence', () => {
  it('saves concurrent notes without losing either checkpoint and queues the area', async () => {
    const { project, area, first, second } = await fixture();
    await Promise.all([
      saveCheckpointInspectionChange(project.id, area.id, first.id, { comments: 'Adjust hinge' }),
      saveCheckpointInspectionChange(project.id, area.id, second.id, { comments: 'Touch up finish' }),
    ]);
    const stored = await getProject(project.id);
    expect(stored?.areas[0].locations[0].items[0].checkpoints.map((entry) => entry.comments)).toEqual(['Adjust hinge', 'Touch up finish']);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(1);
  });

  it('rolls back the note if the team queue write fails, and retries identical text', async () => {
    const { project, area, first } = await fixture();
    const localEvents = new EventTarget();
    const statuses: string[] = [];
    localEvents.addEventListener('punchlist-local-save-status', (event) => statuses.push((event as CustomEvent).detail.status));
    vi.stubGlobal('window', localEvents);
    const original = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      if (this.name === 'sharedAreaSyncQueue') throw new DOMException('Storage full', 'QuotaExceededError');
      return original.apply(this, args);
    });
    await expect(saveCheckpointInspectionChange(project.id, area.id, first.id, { comments: 'Keep this note' })).rejects.toThrow('Storage full');
    expect((await getProject(project.id))?.areas[0].locations[0].items[0].checkpoints[0].comments).toBe('');
    failure.mockRestore();
    await saveProjectPreserveTimestamps(createProject('Unrelated write'));
    expect(statuses.at(-1)).toBe('error');
    await saveCheckpointInspectionChange(project.id, area.id, first.id, { comments: 'Keep this note' });
    expect((await getProject(project.id))?.areas[0].locations[0].items[0].checkpoints[0].comments).toBe('Keep this note');
    expect(statuses.at(-1)).toBe('saved');
  });

  it('preserves explicit room review through backup and team payload parsing', async () => {
    const { project, location } = await fixture();
    location.reviewedAt = new Date().toISOString();
    const restored = parseProjectPayload(JSON.parse(serializeProjectPayload(project)));
    expect(restored.areas[0].locations[0].reviewedAt).toBe(location.reviewedAt);
    expect(restored.areas[0].locations[0].items[0].checkpoints[0].status).toBe('pending');
  });

  it('does not duplicate a captured photo when the same save is retried', async () => {
    const { project, area, first } = await fixture();
    const photo = createPhotoAttachment(first.id, 'data:image/jpeg;base64,cGhvdG8=', 'data:image/jpeg;base64,dGh1bWI=');
    await saveCheckpointInspectionChange(project.id, area.id, first.id, {}, [photo]);
    await saveCheckpointInspectionChange(project.id, area.id, first.id, {}, [photo]);
    const storedPhotos = (await getProject(project.id))?.areas[0].locations[0].items[0].checkpoints[0].photos;
    expect(storedPhotos).toHaveLength(1);
    expect(storedPhotos?.[0].imageData).toBe(photo.imageData);
  });

  it('stores room review without marking untouched checkpoints OK', async () => {
    const { project, area, location, first } = await fixture();
    expect(isAreaInspectionComplete(area)).toBe(false);
    location.reviewedAt = new Date().toISOString();
    await saveProjectAreaMetadataOnly(project, area.id);
    const stored = (await getProject(project.id))!.areas[0];
    expect(isAreaInspectionComplete(stored)).toBe(true);
    expect(stored.locations[0].items[0].checkpoints[0].status).toBe(first.status);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(1);
  });

  it('advances in walking order and stops at the end', async () => {
    const { area, location, item } = await fixture();
    const secondRoom = createLocation(area.id, 'Bedroom', 1);
    const secondItem = createItem(secondRoom.id, 'Door', 0);
    secondRoom.items.push(secondItem); area.locations.push(secondRoom);
    const position = { areaId: area.id, locationId: location.id, itemId: item.id };
    expect(nextInspectionPosition(area, position, 'item')?.itemId).toBe(secondItem.id);
    const last = nextInspectionPosition(area, position, 'room')!;
    expect(last.locationId).toBe(secondRoom.id);
    expect(nextInspectionPosition(area, last, 'room')).toBeNull();
  });
});
