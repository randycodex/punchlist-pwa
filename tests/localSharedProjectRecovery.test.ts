import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeSharedProjectRecoveryBackup, captureLocalProjectSaveToken,
  createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment,
  deleteProject, deleteProjectIfUnchanged, getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject, getPendingSharedProjectRecoveryIds,
  getProject, getSharedProjectRecoveryMetadata, getSharedProjectRecoveryPreview,
  getSharedProjectRecoveryProject, listSharedProjectRecoveries, recordSharedProjectRecoveryBackupFailure,
  saveAreaNotes, saveDownloadedProjectIfUnchanged, saveProjectPreserveTimestamps,
  saveProjectMetadataWithSharedSync, saveReviewedSharedProject,
} from '@/lib/db';
import { listCaptureDrafts, stageCaptureDraft, type CaptureDraft } from '@/lib/captureJournal';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture() {
  const project = createProject('Local team recovery');
  project.sharedProjectId = crypto.randomUUID();
  project.sharedSnapshotPublishedAt = new Date('2026-10-02T12:00:00Z');
  const area = createArea(project.id, 'Unit 203', 0);
  const location = createLocation(area.id, 'Room', 0);
  const item = createItem(location.id, 'Item', 0);
  const checkpoint = createCheckpoint(item.id, 'Finish', 0);
  checkpoint.comments = 'Original inspection';
  checkpoint.photos.push(createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=', 'data:image/jpeg;base64,dGh1bWI='));
  checkpoint.files.push({ id: crypto.randomUUID(), checkpointId: checkpoint.id, name: 'Report.pdf', mimeType: 'application/pdf', size: 4, data: 'data:application/pdf;base64,ZmlsZQ==', createdAt: new Date() });
  item.checkpoints.push(checkpoint); location.items.push(item); area.locations.push(location); project.areas.push(area);
  project.facadeElevationDrawings = [{ id: crypto.randomUUID(), orientation: 'north', name: 'North', fileName: 'north.png', mimeType: 'image/png', size: 7, dataUrl: 'data:image/png;base64,ZHJhd2luZw==', createdAt: new Date(), updatedAt: new Date() }];
  await saveProjectPreserveTimestamps(project);
  await saveAreaNotes(project.id, area.id, 'Local work');
  const source = (await getProject(project.id))!;
  source.projectName = 'Local edited project';
  await saveProjectMetadataWithSharedSync(source);
  return { project: (await getProject(project.id))!, area, checkpoint };
}

async function rawRecord<T>(storeName: string, id: IDBValidKey, databaseName = 'punchlist-db') {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).get(id);
      request.onsuccess = () => resolve(request.result as T); request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

describe('durable local team recovery', () => {
  it('applies offline with an immutable copy of source JSON, original photo bytes, files, drawings and queue evidence', async () => {
    const { project, area, checkpoint } = await fixture();
    const draft: CaptureDraft = { key: `note:${project.id}:${checkpoint.id}`, revision: crypto.randomUUID(), projectId: project.id, areaId: area.id, checkpointId: checkpoint.id, kind: 'note', value: 'Unsaved draft', baseValue: '', savedAt: new Date() };
    await stageCaptureDraft(draft);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline'); }));
    const resolution = structuredClone(project);
    resolution.projectName = 'Team version';
    resolution.areas[0].locations[0].items[0].checkpoints[0].photos = [];
    resolution.areas[0].locations[0].items[0].checkpoints[0].files = [];
    resolution.facadeElevationDrawings = [];
    expect(await saveReviewedSharedProject(resolution, project, [], false)).toBe(true);
    const records = await listSharedProjectRecoveries(project.sharedProjectId!);
    expect(records).toEqual([expect.objectContaining({ projectName: 'Local edited project', reason: 'before_pull', uploadStatus: 'pending', cloudBackupId: null })]);
    const id = records[0].id;
    const raw = await rawRecord<{ mediaRecords: Array<{ photos: Array<{ imageData: Blob }> }>; areaSyncRecords: unknown[]; metadataSyncRecords: unknown[] }>('sharedProjectRecovery', id);
    expect(raw.mediaRecords[0].photos[0].imageData).toBeInstanceOf(Blob);
    expect(await raw.mediaRecords[0].photos[0].imageData.text()).toBe('photo');
    expect(raw.areaSyncRecords).toHaveLength(1);
    expect(raw.metadataSyncRecords).toHaveLength(1);
    expect(await getSharedProjectRecoveryProject(id)).toEqual(project);
    expect((await getProject(project.id))?.projectName).toBe('Team version');
    expect(await listCaptureDrafts(project.id, area.id)).toEqual([draft]);
    const preview = await getSharedProjectRecoveryPreview(id);
    expect(preview?.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('');
    expect(preview?.facadeElevationDrawings?.[0].dataUrl).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates no copy and keeps current edits when the reviewed source is stale', async () => {
    const { project, area } = await fixture();
    await saveAreaNotes(project.id, area.id, 'Typed after review');
    expect(await saveReviewedSharedProject(project, project, [], false)).toBe(false);
    expect(await listSharedProjectRecoveries(project.sharedProjectId!)).toEqual([]);
    expect((await getProject(project.id))?.areas[0].notes).toBe('Typed after review');
  });

  it('rolls back apply and queues when local recovery storage runs out of space', async () => {
    const { project, area } = await fixture();
    const originalAreas = await getPendingSharedAreaSyncsForProject(project.id);
    const originalMetadata = await getPendingSharedProjectMetadataSyncForProject(project.id);
    let attemptedRecoveryId = '';
    const add = IDBObjectStore.prototype.add;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'sharedProjectRecoveryMetadata') {
        attemptedRecoveryId = (value as { id: string }).id;
        throw new DOMException('Storage full', 'QuotaExceededError');
      }
      return add.call(this, value, key);
    });
    const resolution = structuredClone(project); resolution.projectName = 'Changed';
    try { await expect(saveReviewedSharedProject(resolution, project, [area.id], true)).rejects.toThrow('Storage full'); }
    finally { failure.mockRestore(); }
    expect(await getProject(project.id)).toEqual(project);
    expect(await listSharedProjectRecoveries(project.sharedProjectId!)).toEqual([]);
    expect(await rawRecord('sharedProjectRecovery', attemptedRecoveryId)).toBeUndefined();
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual(originalAreas);
    expect(await getPendingSharedProjectMetadataSyncForProject(project.id)).toEqual(originalMetadata);
  });

  it('rolls back the safety copy too if applying downloaded photos fails', async () => {
    const { project, area } = await fixture();
    const put = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'checkpointMedia') throw new Error('Media write failed');
      return put.call(this, value, key);
    });
    const resolution = structuredClone(project); resolution.projectName = 'Changed';
    try { await expect(saveReviewedSharedProject(resolution, project, [area.id], true)).rejects.toThrow('Media write failed'); }
    finally { failure.mockRestore(); }
    expect(await getProject(project.id)).toEqual(project);
    expect(await listSharedProjectRecoveries(project.sharedProjectId!)).toEqual([]);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(1);
  });

  it('does not replace a project when its stored source photo cannot be retained', async () => {
    const { project, checkpoint } = await fixture();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('punchlist-db');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('checkpointMedia', 'readwrite');
        transaction.objectStore('checkpointMedia').delete([project.id, checkpoint.id]);
        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
    const resolution = structuredClone(project); resolution.projectName = 'Changed';
    await expect(saveReviewedSharedProject(resolution, project, [], false)).rejects.toThrow('saved photo is unavailable');
    expect((await getProject(project.id))?.projectName).toBe(project.projectName);
    expect(await listSharedProjectRecoveries(project.sharedProjectId!)).toEqual([]);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(1);
  });

  it('keeps metadata lists lightweight and retries without changing immutable content', async () => {
    const { project } = await fixture();
    await saveReviewedSharedProject(project, project, [], false);
    const id = (await listSharedProjectRecoveries(project.sharedProjectId!))[0].id;
    const source = await getSharedProjectRecoveryProject(id);
    const retryAt = new Date(Date.now() + 60_000);
    await recordSharedProjectRecoveryBackupFailure(id, 'Connection interrupted', retryAt);
    expect(await getSharedProjectRecoveryMetadata(id)).toMatchObject({ attemptCount: 1, nextAttemptAt: retryAt, lastError: 'Connection interrupted' });
    expect(await getPendingSharedProjectRecoveryIds()).not.toContain(id);
    expect(await getPendingSharedProjectRecoveryIds(retryAt)).toContain(id);
    const getAll = IDBObjectStore.prototype.getAll;
    const noMedia = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, query, count) {
      if (this.name === 'sharedProjectRecovery') throw new Error('Lists must not read full snapshots');
      return getAll.call(this, query, count);
    });
    expect(await listSharedProjectRecoveries(project.sharedProjectId!)).toHaveLength(1);
    noMedia.mockRestore();
    await expect(acknowledgeSharedProjectRecoveryBackup(id, '')).rejects.toThrow('confirmed backup ID');
    await acknowledgeSharedProjectRecoveryBackup(id, 'cloud-1');
    await acknowledgeSharedProjectRecoveryBackup(id, 'cloud-2');
    await recordSharedProjectRecoveryBackupFailure(id, 'Late failure', retryAt);
    expect(await getSharedProjectRecoveryMetadata(id)).toMatchObject({ uploadStatus: 'uploaded', cloudBackupId: 'cloud-1', attemptCount: 1, lastError: null });
    expect(await getPendingSharedProjectRecoveryIds(retryAt)).not.toContain(id);
    expect(await getSharedProjectRecoveryProject(id)).toEqual(source);
  });

  it('captures a safety copy atomically before a local recovery restore clears queues', async () => {
    const { project } = await fixture();
    const token = await captureLocalProjectSaveToken(project.id);
    const restored = structuredClone(project); restored.projectName = 'Restored';
    expect(await saveDownloadedProjectIfUnchanged(restored, token, { resetSharedQueues: true, captureRecovery: true })).toBe(true);
    const metadata = (await listSharedProjectRecoveries(project.sharedProjectId!))[0];
    expect(metadata.reason).toBe('restore');
    expect(await getSharedProjectRecoveryProject(metadata.id)).toEqual(project);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual([]);
    expect(await getPendingSharedProjectMetadataSyncForProject(project.id)).toBeUndefined();
    expect(await saveDownloadedProjectIfUnchanged(project, token, { resetSharedQueues: true, captureRecovery: true })).toBe(false);
    expect(await listSharedProjectRecoveries(project.sharedProjectId!)).toHaveLength(1);
  });

  it('protects unuploaded recoveries from automatic cleanup and deletes them with explicit permanent deletion', async () => {
    const { project } = await fixture();
    await saveReviewedSharedProject(project, project, [], false);
    const id = (await listSharedProjectRecoveries(project.sharedProjectId!))[0].id;
    const current = (await getProject(project.id))!;
    expect(await deleteProjectIfUnchanged(project.id, current)).toBe(false);
    expect(await getSharedProjectRecoveryProject(id)).toEqual(project);
    await deleteProject(project.id);
    expect(await getProject(project.id)).toBeUndefined();
    expect(await getSharedProjectRecoveryProject(id)).toBeUndefined();
    expect(await getSharedProjectRecoveryMetadata(id)).toBeUndefined();
  });

  it('isolates recovery snapshots and upload status between account workspaces', async () => {
    const values = new Map<string, string>([['punchlist:legacy-data-owner', 'legacy-owner']]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    vi.resetModules();
    const firstAccount = await import('@/lib/localAccount');
    const accountA = `a-${crypto.randomUUID()}`; const accountB = `b-${crypto.randomUUID()}`;
    firstAccount.configureLocalAccount(accountA, 'a@example.com', 'legacy-owner');
    const first = await import('@/lib/db');
    const project = first.createProject('Account A'); project.sharedProjectId = crypto.randomUUID(); project.sharedSnapshotPublishedAt = new Date();
    // Upgrade an existing v9 workspace in place, retaining its project record.
    const previousDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(firstAccount.localAccountKey('punchlist-db'), 9);
      request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' }).put(project);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    previousDatabase.close();
    expect(await first.getProject(project.id)).toEqual(project);
    await first.saveReviewedSharedProject(project, project, [], false);
    const id = (await first.listSharedProjectRecoveries(project.sharedProjectId))[0].id;
    vi.resetModules();
    const secondAccount = await import('@/lib/localAccount');
    secondAccount.configureLocalAccount(accountB, 'b@example.com', 'legacy-owner');
    const second = await import('@/lib/db');
    expect(await second.getSharedProjectRecoveryProject(id)).toBeUndefined();
    expect(await second.getPendingSharedProjectRecoveryIds()).toEqual([]);
    await second.acknowledgeSharedProjectRecoveryBackup(id, 'different-account');
    expect((await first.getSharedProjectRecoveryMetadata(id))?.uploadStatus).toBe('pending');
    vi.resetModules();
  });
});
