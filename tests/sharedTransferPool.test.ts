import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SharedTransferPool,
  assetTransferKey,
  getSharedDownloadPool,
  resetSharedTransferPoolsForTests,
} from '@/lib/collaboration/sharedTransferPool';
import {
  buildSharedSnapshotAssetPlan,
  hydrateSharedSnapshotAssetsWithResolver,
  mapWithConcurrency,
} from '@/lib/collaboration/sharedSnapshotAssets';
import {
  COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION,
  createCompactSharedSnapshotPayload,
  parseSharedSnapshotPayload,
} from '@/lib/collaboration/sharedSnapshotPayload';
import type { Project } from '@/types';

const timestamp = new Date('2026-07-17T12:00:00.000Z');
const photoA = 'data:image/jpeg;base64,YQ==';
const photoB = 'data:image/jpeg;base64,Yg==';
const photoC = 'data:image/jpeg;base64,Yw==';

function areaProject(areaId: string, photoId: string, imageData: string): Project {
  return {
    id: 'local-1',
    sharedProjectId: 'shared-1',
    projectName: 'Pool project',
    address: '',
    date: timestamp,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas: [{
      id: areaId,
      projectId: 'local-1',
      name: areaId,
      sortOrder: 0,
      isComplete: false,
      notes: '',
      locations: [{
        id: `${areaId}-loc`,
        areaId,
        name: 'Room',
        sortOrder: 0,
        items: [{
          id: `${areaId}-item`,
          locationId: `${areaId}-loc`,
          name: 'Item',
          sortOrder: 0,
          checkpoints: [{
            id: `${areaId}-cp`,
            itemId: `${areaId}-item`,
            name: 'Checkpoint',
            status: 'pending',
            fixStatus: 'pending',
            issueState: 'none',
            comments: '',
            sortOrder: 0,
            photos: [{ id: photoId, checkpointId: `${areaId}-cp`, imageData, createdAt: timestamp }],
            files: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          }],
          createdAt: timestamp,
          updatedAt: timestamp,
        }],
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('shared transfer pool', () => {
  beforeEach(() => {
    resetSharedTransferPoolsForTests();
  });

  it('limits simultaneous files and in-flight bytes', async () => {
    const pool = new SharedTransferPool({ maxFiles: 2, maxBytes: 10 });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const started: string[] = [];
    const one = pool.schedule('a', 4, async () => { started.push('a'); await firstGate; return 'a'; });
    const two = pool.schedule('b', 4, async () => { started.push('b'); await secondGate; return 'b'; });
    const three = pool.schedule('c', 4, async () => { started.push('c'); return 'c'; });
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
    expect(pool.snapshot()).toMatchObject({ activeFiles: 2, queued: 1, peakActiveFiles: 2 });
    releaseFirst();
    await one;
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']));
    releaseSecond();
    await Promise.all([two, three]);
    expect(pool.snapshot().peakActiveFiles).toBe(2);
    expect(pool.snapshot().peakActiveBytes).toBeLessThanOrEqual(10);
  });

  it('dedupes identical keys and does not leak capacity after failure', async () => {
    const pool = getSharedDownloadPool();
    pool.setLimits({ maxFiles: 2, maxBytes: 1024 });
    pool.resetStats();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    const shared = pool.schedule('photo', 8, async () => {
      runs += 1;
      await gate;
      throw new Error('capacity');
    });
    const joined = pool.schedule('photo', 8, async () => {
      runs += 1;
      return 'unused';
    });
    expect(pool.snapshot().deduped).toBe(1);
    expect(runs).toBe(1);
    release();
    await expect(shared).rejects.toThrow('capacity');
    await expect(joined).rejects.toThrow('capacity');
    await pool.drain();
    expect(pool.snapshot()).toMatchObject({ activeFiles: 0, queued: 0, inflightKeys: 0, failed: 1 });
  });

  it('downloads overlap across areas while respecting global file limits', async () => {
    const pool = getSharedDownloadPool();
    pool.setLimits({ maxFiles: 2, maxBytes: 1024 * 1024 });
    pool.resetStats();
    const areas = [
      areaProject('area-1', 'photo-1', photoA),
      areaProject('area-2', 'photo-2', photoB),
      areaProject('area-3', 'photo-3', photoC),
    ];
    const activeSnapshots: number[] = [];
    const resolve = vi.fn(async (reference: { path: string }) => {
      activeSnapshots.push(pool.snapshot().activeFiles);
      await new Promise((r) => setTimeout(r, 20));
      if (reference.path.includes('photo-1')) return photoA;
      if (reference.path.includes('photo-2')) return photoB;
      return photoC;
    });

    await mapWithConcurrency(areas, 3, async (project) => {
      const plan = await buildSharedSnapshotAssetPlan(project);
      const parsed = parseSharedSnapshotPayload(
        JSON.parse(JSON.stringify(createCompactSharedSnapshotPayload(project, plan.assets))),
        COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION
      );
      await hydrateSharedSnapshotAssetsWithResolver(
        parsed.project,
        parsed.assets,
        'shared-1',
        resolve
      );
    });

    expect(Math.max(...activeSnapshots)).toBeLessThanOrEqual(2);
    expect(pool.snapshot().peakActiveFiles).toBeLessThanOrEqual(2);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('rejects corrupted downloads and leaves the working copy untouched', async () => {
    const remote = areaProject('area-1', 'photo-1', photoA);
    const local = areaProject('area-1', 'photo-1', photoC);
    const plan = await buildSharedSnapshotAssetPlan(remote);
    const parsed = parseSharedSnapshotPayload(
      JSON.parse(JSON.stringify(createCompactSharedSnapshotPayload(remote, plan.assets))),
      COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION
    );
    const resolve = vi.fn(async () => photoB);
    await expect(hydrateSharedSnapshotAssetsWithResolver(
      parsed.project,
      parsed.assets,
      'shared-1',
      resolve,
      local
    )).rejects.toThrow('failed verification');
    expect(local.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe(photoC);
    expect(parsed.project.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('');
  });

  it('converts Blobs to data URLs only after verification', async () => {
    const project = areaProject('area-1', 'photo-1', photoA);
    const plan = await buildSharedSnapshotAssetPlan(project);
    const parsed = parseSharedSnapshotPayload(
      JSON.parse(JSON.stringify(createCompactSharedSnapshotPayload(project, plan.assets))),
      COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION
    );
    const binary = atob('YQ==');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const resolve = vi.fn(async () => blob);
    await hydrateSharedSnapshotAssetsWithResolver(parsed.project, parsed.assets, 'shared-1', resolve);
    expect(parsed.project.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe(photoA);
  });
});

describe('asset transfer key', () => {
  it('joins bucket and path', () => {
    expect(assetTransferKey('punchlist-attachments', 'shared-1/a/b.jpg')).toBe('punchlist-attachments:shared-1/a/b.jpg');
  });
});
