import { expect, it, vi } from 'vitest';
import {
  createArea, createCheckpoint, createItem, createLocation, createPhotoAttachment,
  createProject, getProject, getProjectForArea,
} from '@/lib/db';

it('reads saved media without indexes and leaves queued team changes intact', async () => {
  const project = createProject('Safari recovery');
  const area = createArea(project.id, 'Area 1', 0);
  const location = createLocation(area.id, 'Room', 0);
  const item = createItem(location.id, 'Item', 0);
  const checkpoint = createCheckpoint(item.id, 'Finish', 0);
  const photo = createPhotoAttachment(checkpoint.id, 'data:image/png;base64,YQ==');
  checkpoint.photos.push({ ...photo, imageData: '' });
  item.checkpoints.push(checkpoint);
  location.items.push(item);
  area.locations.push(location);
  project.areas.push(area);

  const request = indexedDB.open('punchlist-db', 9);
  await new Promise<void>((resolve, reject) => {
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('projects', { keyPath: 'id' }).put(project);
      // Simulate a Safari database whose records remain but media indexes are absent.
      db.createObjectStore('checkpointMedia', { keyPath: ['projectId', 'checkpointId'] }).put({
        projectId: project.id,
        areaId: area.id,
        checkpointId: checkpoint.id,
        photos: [{ ...photo, imageData: new Blob([Uint8Array.of(97)], { type: 'image/png' }) }],
        files: [],
      });
      db.createObjectStore('elevationDrawings', { keyPath: ['projectId', 'id'] });
      db.createObjectStore('sharedAreaSyncQueue', { keyPath: 'key' }).put({
        key: `${project.id}:shared:area`,
        localProjectId: project.id,
        sharedProjectId: 'shared',
        areaId: area.id,
      });
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });

  const blobRead = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValueOnce(
    new DOMException('The object can not be found here.', 'NotFoundError')
  );
  const full = await getProject(project.id);
  blobRead.mockRestore();
  const selectedArea = await getProjectForArea(project.id, area.id);
  expect(full?.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe(photo.imageData);
  expect(selectedArea?.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe(photo.imageData);

  const unreadableBlob = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(
    new DOMException('The object can not be found here.', 'NotFoundError')
  );
  await expect(getProject(project.id)).rejects.toThrow('Could not finish opening saved photos and files');
  unreadableBlob.mockRestore();

  const verify = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('punchlist-db');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const pending = await new Promise<number>((resolve, reject) => {
    const count = verify.transaction('sharedAreaSyncQueue').objectStore('sharedAreaSyncQueue').count();
    count.onsuccess = () => resolve(count.result);
    count.onerror = () => reject(count.error);
  });
  expect(pending).toBe(1);
  verify.close();
});
