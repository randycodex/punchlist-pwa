import { beforeEach, describe, expect, it } from 'vitest';
import {
  createArea,
  createCheckpoint,
  createItem,
  createLocation,
  createPhotoAttachment,
  createProject,
  deleteProject,
  getDurablePendingSyncState,
  getProject,
  getProjectForArea,
  getProjectMetadata,
  persistDurablePendingSyncState,
  saveProject,
  saveProjectArea,
  saveProjectAreaMetadataOnly,
  saveProjectMetadataOnly,
  saveProjectPreserveTimestamps,
} from '@/lib/db';

async function getRawCheckpointMedia(checkpointId: string) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('punchlist-db');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<{ photos: Array<{ imageData: unknown; thumbnail?: unknown }> } | undefined>(
      (resolve, reject) => {
        const transaction = database.transaction('checkpointMedia', 'readonly');
        const request = transaction.objectStore('checkpointMedia').get(checkpointId);
        request.onsuccess = () => resolve(request.result as { photos: Array<{ imageData: unknown; thumbnail?: unknown }> } | undefined);
        request.onerror = () => reject(request.error);
      }
    );
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  await persistDurablePendingSyncState([], false);
});

describe('durable IndexedDB sync metadata', () => {
  it('atomically marks locally saved projects as pending', async () => {
    const project = createProject('Durable project');
    await saveProject(project);

    expect(await getDurablePendingSyncState()).toEqual({
      projectIds: [project.id],
      fullSyncNeeded: false,
    });
  });

  it('does not mark remote or metadata reconciliation writes as local changes', async () => {
    const project = createProject('Remote project');
    await saveProjectPreserveTimestamps(project);
    await saveProjectMetadataOnly(project, { touch: false });

    expect(await getDurablePendingSyncState()).toEqual({
      projectIds: [],
      fullSyncNeeded: false,
    });
  });

  it('records hard deletion as requiring a full sync', async () => {
    const project = createProject('Deleted project');
    await saveProjectPreserveTimestamps(project);
    await deleteProject(project.id);

    expect(await getDurablePendingSyncState()).toEqual({
      projectIds: [],
      fullSyncNeeded: true,
    });
  });

  it('keeps thumbnails with media while leaving project metadata lightweight', async () => {
    const project = createProject('Media project');
    const area = createArea(project.id, 'Apartment 1A', 0);
    const location = createLocation(area.id, 'Living Room', 0);
    const item = createItem(location.id, 'Walls', 0);
    const checkpoint = createCheckpoint(item.id, 'Finish', 0);
    checkpoint.photos.push(
      createPhotoAttachment(
        checkpoint.id,
        'data:image/jpeg;base64,b3JpZ2luYWw=',
        'data:image/jpeg;base64,dGh1bWI='
      )
    );
    item.checkpoints.push(checkpoint);
    location.items.push(item);
    area.locations.push(location);
    project.areas.push(area);

    await saveProject(project);

    const storedMedia = await getRawCheckpointMedia(checkpoint.id);
    const hydrated = await getProject(project.id);
    const metadata = await getProjectMetadata(project.id);
    expect(storedMedia?.photos[0].imageData).toBeInstanceOf(Blob);
    expect(storedMedia?.photos[0].thumbnail).toBeInstanceOf(Blob);
    expect(hydrated?.areas[0].locations[0].items[0].checkpoints[0].photos[0]).toMatchObject({
      imageData: 'data:image/jpeg;base64,b3JpZ2luYWw=',
      thumbnail: 'data:image/jpeg;base64,dGh1bWI=',
    });
    expect(metadata?.areas[0].locations[0].items[0].checkpoints[0].photos[0]).toMatchObject({
      imageData: '',
      thumbnail: undefined,
    });
  });

  it('updates one area without rewriting or dropping media from other areas', async () => {
    const project = createProject('Incremental project');
    for (const [index, areaName] of ['Apartment 1A', 'Apartment 1B'].entries()) {
      const area = createArea(project.id, areaName, index);
      const location = createLocation(area.id, 'Living Room', 0);
      const item = createItem(location.id, 'Walls', 0);
      const checkpoint = createCheckpoint(item.id, 'Finish', 0);
      checkpoint.photos.push(createPhotoAttachment(checkpoint.id, `photo-${index}`, `thumb-${index}`));
      item.checkpoints.push(checkpoint);
      location.items.push(item);
      area.locations.push(location);
      project.areas.push(area);
    }
    await saveProject(project);
    await persistDurablePendingSyncState([], false);

    const firstCheckpoint = project.areas[0].locations[0].items[0].checkpoints[0];
    firstCheckpoint.comments = 'Updated only in the first area';
    firstCheckpoint.updatedAt = new Date('2026-01-02T00:00:00.000Z');
    await saveProjectAreaMetadataOnly(project, project.areas[0].id);

    const restored = await getProject(project.id);
    const firstAreaOnly = await getProjectForArea(project.id, project.areas[0].id);
    expect(restored?.areas[0].locations[0].items[0].checkpoints[0].comments).toBe(
      'Updated only in the first area'
    );
    expect(restored?.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('photo-0');
    expect(restored?.areas[1].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('photo-1');
    expect(firstAreaOnly?.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('photo-0');
    expect(firstAreaOnly?.areas[1].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('');
    expect(await getDurablePendingSyncState()).toEqual({
      projectIds: [project.id],
      fullSyncNeeded: false,
    });
  });

  it('persists area media without scanning away attachments that were not hydrated', async () => {
    const project = createProject('Area media isolation project');
    for (const [index, areaName] of ['Apartment 2A', 'Apartment 2B'].entries()) {
      const area = createArea(project.id, areaName, index);
      const location = createLocation(area.id, 'Bedroom', 0);
      const item = createItem(location.id, 'Ceiling', 0);
      const checkpoint = createCheckpoint(item.id, 'Paint', 0);
      checkpoint.photos.push(createPhotoAttachment(checkpoint.id, `original-photo-${index}`));
      item.checkpoints.push(checkpoint);
      location.items.push(item);
      area.locations.push(location);
      project.areas.push(area);
    }
    await saveProject(project);

    const scopedProject = await getProjectForArea(project.id, project.areas[0].id);
    expect(scopedProject?.areas[1].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('');
    const firstCheckpoint = scopedProject!.areas[0].locations[0].items[0].checkpoints[0];
    firstCheckpoint.photos = [createPhotoAttachment(firstCheckpoint.id, 'updated-first-area-photo')];

    await saveProjectArea(scopedProject!, scopedProject!.areas[0].id);

    const restored = await getProject(project.id);
    expect(restored?.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe(
      'updated-first-area-photo'
    );
    expect(restored?.areas[1].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe(
      'original-photo-1'
    );
  });
});
