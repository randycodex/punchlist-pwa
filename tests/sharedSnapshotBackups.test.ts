import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fromMock,
  limitMock,
  maybeSingleMock,
  selectMock,
} = vi.hoisted(() => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  const limitMock = vi.fn();
  const maybeSingleMock = vi.fn();
  const selectMock = vi.fn<(columns: string) => typeof query>(() => query);
  query.select = selectMock;
  query.eq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.limit = limitMock;
  query.maybeSingle = maybeSingleMock;
  return {
    fromMock: vi.fn(() => query),
    limitMock,
    maybeSingleMock,
    selectMock,
  };
});

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({ from: fromMock }),
}));

import {
  acknowledgeSharedProjectRecoveryBackup,
  createArea,
  createCheckpoint,
  createItem,
  createLocation,
  createPhotoAttachment,
  createProject,
  getProject,
  listSharedProjectRecoveries,
  saveProjectPreserveTimestamps,
  saveReviewedSharedProject,
} from '@/lib/db';
import {
  getSharedProjectBackupPreview,
  getSharedProjectBackupSnapshot,
  listSharedProjectBackups,
} from '@/lib/collaboration/sharedProjectSnapshots';

const backupRow = {
  id: 'backup-1',
  project_id: 'shared-project-1',
  project_name: 'Lean backup',
  captured_by_user_id: 'user-1',
  captured_at: '2026-07-17T12:00:00.000Z',
  reason: 'manual' as const,
  note: null,
};

async function captureDeviceRecovery() {
  const project = createProject('Original device inspection');
  project.sharedProjectId = crypto.randomUUID();
  project.sharedSnapshotPublishedAt = new Date('2026-10-02T12:00:00.000Z');
  const area = createArea(project.id, 'Unit 203', 0);
  const location = createLocation(area.id, 'Bedroom', 0);
  const item = createItem(location.id, 'Window', 0);
  const checkpoint = createCheckpoint(item.id, 'Finish', 0);
  checkpoint.comments = 'Original inspection note';
  checkpoint.photos.push(createPhotoAttachment(
    checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=', 'data:image/jpeg;base64,dGh1bWI='
  ));
  checkpoint.files.push({
    id: crypto.randomUUID(), checkpointId: checkpoint.id, name: 'Report.pdf',
    mimeType: 'application/pdf', size: 4, data: 'data:application/pdf;base64,ZmlsZQ==', createdAt: new Date(),
  });
  item.checkpoints.push(checkpoint);
  location.items.push(item);
  area.locations.push(location);
  project.areas.push(area);
  project.facadeElevationDrawings = [{
    id: crypto.randomUUID(), orientation: 'north', name: 'North', fileName: 'north.png',
    mimeType: 'image/png', size: 7, dataUrl: 'data:image/png;base64,ZHJhd2luZw==',
    createdAt: new Date(), updatedAt: new Date(),
  }];
  await saveProjectPreserveTimestamps(project);
  const source = (await getProject(project.id))!;
  const replacement = structuredClone(source);
  replacement.projectName = 'Downloaded team inspection';
  replacement.areas[0].locations[0].items[0].checkpoints[0].comments = 'Team note';
  replacement.areas[0].locations[0].items[0].checkpoints[0].photos = [];
  replacement.areas[0].locations[0].items[0].checkpoints[0].files = [];
  replacement.facadeElevationDrawings = [];
  expect(await saveReviewedSharedProject(replacement, source, [], false)).toBe(true);
  const [metadata] = await listSharedProjectRecoveries(project.sharedProjectId);
  return { source, replacement: (await getProject(project.id))!, metadata, backupId: `device:${metadata.id}` };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('shared snapshot backup listing', () => {
  beforeEach(() => {
    fromMock.mockClear();
    selectMock.mockClear();
    limitMock.mockReset();
    maybeSingleMock.mockReset();
  });

  it('lists backup metadata without downloading historical project payloads', async () => {
    limitMock.mockResolvedValue({ data: [backupRow], error: null });

    const backups = await listSharedProjectBackups('shared-project-1');

    expect(selectMock).toHaveBeenCalledWith(
      'id, project_id, project_name, captured_by_user_id, captured_at, reason, note'
    );
    expect(selectMock.mock.calls[0][0]).not.toContain('project_payload');
    expect(backups[0]).toMatchObject({ projectName: 'Lean backup' });
  });

  it('falls back to the legacy payload only when project_name is unavailable', async () => {
    limitMock
      .mockResolvedValueOnce({ data: null, error: { code: '42703', message: 'project_name does not exist' } })
      .mockResolvedValueOnce({
        data: [{
          ...backupRow,
          project_name: undefined,
          project_payload: { projectName: 'Legacy backup' },
        }],
        error: null,
      });

    const backups = await listSharedProjectBackups('shared-project-1');

    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(selectMock.mock.calls[1][0]).toContain('project_payload');
    expect(backups[0]).toMatchObject({ projectName: 'Legacy backup' });
  });

  it('loads one backup payload on demand for an impact preview', async () => {
    const project = createProject('Team project');
    project.sharedProjectId = 'shared-project-1';
    maybeSingleMock.mockResolvedValue({
      data: { project_payload: JSON.parse(JSON.stringify(project)), payload_version: 1, captured_at: backupRow.captured_at },
      error: null,
    });

    const preview = await getSharedProjectBackupPreview(project, 'backup-1');

    expect(preview.projectName).toBe('Team project');
    expect(selectMock).toHaveBeenCalledWith('project_payload, payload_version, captured_at');
    expect(fromMock).toHaveBeenCalledWith('shared_project_snapshot_history');
  });

  it('lists the saved device copy when cloud history fails without reading attachment payloads', async () => {
    const { source, metadata, backupId } = await captureDeviceRecovery();
    limitMock.mockResolvedValue({ data: null, error: { message: 'Team service unavailable' } });
    const get = IDBObjectStore.prototype.get;
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      if (this.name === 'sharedProjectRecovery') throw new Error('Listing must not load recovery payloads');
      return get.call(this, key);
    });

    const backups = await listSharedProjectBackups(source.sharedProjectId!);

    expect(backups).toEqual([{
      id: backupId, projectId: source.sharedProjectId, projectName: source.projectName,
      capturedByUserId: '', capturedAt: metadata.capturedAt, reason: 'before_pull',
      storageLocation: 'device', uploadPending: true,
    }]);
    expect(selectMock.mock.calls[0][0]).not.toContain('project_payload');
  });

  it('previews and restores original device bytes after team updates replace the current inspection, without network requests', async () => {
    const { source, replacement, metadata, backupId } = await captureDeviceRecovery();

    const preview = await getSharedProjectBackupPreview(replacement, backupId);
    const result = await getSharedProjectBackupSnapshot(replacement, backupId);

    expect(preview.projectName).toBe(source.projectName);
    const previewCheckpoint = preview.areas[0].locations[0].items[0].checkpoints[0];
    expect(previewCheckpoint.comments).toBe('Original inspection note');
    expect(previewCheckpoint.photos[0].imageData).toBe('');
    expect(previewCheckpoint.files[0].data).toBe('');
    expect(preview.facadeElevationDrawings?.[0].dataUrl).toBe('');
    expect(result.project).toEqual(source);
    expect(result.publishedAt).toBe(metadata.capturedAt.toISOString());
    expect(replacement.areas[0].locations[0].items[0].checkpoints[0].photos).toEqual([]);
    expect(result.project.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData)
      .toBe('data:image/jpeg;base64,cGhvdG8=');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('rejects a device recovery belonging to a different team project', async () => {
    const { replacement, backupId } = await captureDeviceRecovery();
    const otherProject = { ...replacement, sharedProjectId: crypto.randomUUID() };

    await expect(getSharedProjectBackupPreview(otherProject, backupId))
      .rejects.toThrow('Could not find this project recovery copy on this device');
    await expect(getSharedProjectBackupSnapshot(otherProject, backupId))
      .rejects.toThrow('Could not find this project recovery copy on this device');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('deduplicates the device copy only after its acknowledged cloud backup is returned by history', async () => {
    const { source, metadata, backupId } = await captureDeviceRecovery();
    await acknowledgeSharedProjectRecoveryBackup(metadata.id, 'cloud-confirmed');
    limitMock.mockResolvedValueOnce({ data: [], error: null });

    const deviceOnly = await listSharedProjectBackups(source.sharedProjectId!);
    expect(deviceOnly).toEqual([expect.objectContaining({
      id: backupId, storageLocation: 'device', uploadPending: false,
    })]);

    limitMock.mockResolvedValueOnce({
      data: [{ ...backupRow, id: 'cloud-confirmed', project_id: source.sharedProjectId,
        captured_at: metadata.capturedAt.toISOString(), project_name: source.projectName }],
      error: null,
    });
    const cloudOnly = await listSharedProjectBackups(source.sharedProjectId!);

    expect(cloudOnly).toHaveLength(1);
    expect(cloudOnly[0]).toMatchObject({ id: 'cloud-confirmed', projectName: source.projectName });
    expect(cloudOnly[0].storageLocation).toBeUndefined();
  });
});
