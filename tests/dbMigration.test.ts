import { expect, it } from 'vitest';
import type { Project } from '@/types';

const now = new Date('2026-01-01T00:00:00.000Z');

function openLegacyDatabase(project: Project) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('punchlist-db', 4);
    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction!;
      const projects = database.createObjectStore('projects', { keyPath: 'id' });
      projects.createIndex('by-name', 'projectName');
      projects.createIndex('by-date', 'updatedAt');
      const media = database.createObjectStore('checkpointMedia', { keyPath: 'checkpointId' });
      media.createIndex('by-project', 'projectId');
      const drawings = database.createObjectStore('elevationDrawings', { keyPath: 'id' });
      drawings.createIndex('by-project', 'projectId');
      database.createObjectStore('syncMetadata', { keyPath: 'key' });

      transaction.objectStore('projects').put(project);
      transaction.objectStore('checkpointMedia').put({
        checkpointId: 'checkpoint-1',
        projectId: project.id,
        photos: [{
          id: 'photo-1',
          checkpointId: 'checkpoint-1',
          imageData: 'legacy-photo-data',
          createdAt: now,
        }],
        files: [],
      });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

it('migrates legacy checkpoint media into the area index', async () => {
  const project: Project = {
    id: 'legacy-project',
    projectName: 'Legacy project',
    address: '',
    date: now,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas: [{
      id: 'area-1',
      projectId: 'legacy-project',
      name: 'Area',
      sortOrder: 0,
      isComplete: false,
      notes: '',
      locations: [{
        id: 'location-1',
        areaId: 'area-1',
        name: 'Room',
        sortOrder: 0,
        items: [{
          id: 'item-1',
          locationId: 'location-1',
          name: 'Item',
          sortOrder: 0,
          checkpoints: [{
            id: 'checkpoint-1',
            itemId: 'item-1',
            name: 'Finish',
            status: 'pending',
            fixStatus: 'pending',
            issueState: 'none',
            comments: '',
            sortOrder: 0,
            photos: [{
              id: 'photo-1',
              checkpointId: 'checkpoint-1',
              imageData: '',
              createdAt: now,
            }],
            files: [],
            createdAt: now,
            updatedAt: now,
          }],
          createdAt: now,
          updatedAt: now,
        }],
        createdAt: now,
        updatedAt: now,
      }],
      createdAt: now,
      updatedAt: now,
    }],
    createdAt: now,
    updatedAt: now,
  };

  await openLegacyDatabase(project);
  const { getProjectForArea } = await import('@/lib/db');
  const migrated = await getProjectForArea(project.id, 'area-1');

  expect(migrated?.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe(
    'legacy-photo-data'
  );
});
