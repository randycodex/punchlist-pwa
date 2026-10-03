import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types';

const {
  attachmentIsMock,
  attachmentOrMock,
  attachmentOrderMock,
  attachmentRangeMock,
  attachmentRetryMock,
  attachmentUpsertMock,
  fromMock,
  storageFromMock,
  storageDownloadMock,
  storageUploadMock,
} = vi.hoisted(() => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  const attachmentIsMock = vi.fn(() => query);
  const attachmentOrMock = vi.fn(() => query);
  const attachmentOrderMock = vi.fn(() => query);
  const attachmentRangeMock = vi.fn<(from: number, to: number) => typeof query>(() => query);
  const attachmentRetryMock = vi.fn();
  const attachmentUpsertMock = vi.fn();
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.is = attachmentIsMock;
  query.or = attachmentOrMock;
  query.order = attachmentOrderMock;
  query.range = attachmentRangeMock;
  query.retry = attachmentRetryMock;
  query.upsert = attachmentUpsertMock;

  const storageUploadMock = vi.fn();
  const storageDownloadMock = vi.fn();
  return {
    attachmentIsMock,
    attachmentOrMock,
    attachmentOrderMock,
    attachmentRangeMock,
    attachmentRetryMock,
    attachmentUpsertMock,
    fromMock: vi.fn(() => query),
    storageFromMock: vi.fn(() => ({ upload: storageUploadMock, download: storageDownloadMock })),
    storageDownloadMock,
    storageUploadMock,
  };
});

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    from: fromMock,
    storage: { from: storageFromMock },
  }),
}));

import { buildSharedSnapshotAssetPlan, prepareCompactSharedSnapshotPayload } from '@/lib/collaboration/sharedSnapshotAssets';

const timestamp = new Date('2026-07-17T12:00:00.000Z');

function project(): Project {
  return {
    id: 'local-project-1',
    sharedProjectId: 'shared-project-1',
    projectName: 'Storage project',
    address: '',
    date: timestamp,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas: [{
      id: 'area-1',
      projectId: 'local-project-1',
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
            name: 'Checkpoint',
            status: 'pending',
            fixStatus: 'pending',
            issueState: 'none',
            comments: '',
            sortOrder: 0,
            photos: [{
              id: 'photo-1',
              checkpointId: 'checkpoint-1',
              imageData: 'data:image/jpeg;base64,cGhvdG8=',
              createdAt: timestamp,
            }],
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

describe('shared snapshot attachment transfer', () => {
  beforeEach(() => {
    fromMock.mockClear();
    storageFromMock.mockClear();
    attachmentIsMock.mockClear();
    attachmentOrMock.mockClear();
    attachmentOrderMock.mockClear();
    attachmentRangeMock.mockClear();
    attachmentRetryMock.mockReset();
    attachmentUpsertMock.mockReset();
    storageUploadMock.mockReset();
    storageDownloadMock.mockReset();
    storageDownloadMock.mockResolvedValue({ data: new Blob([atob("cGhvdG8=")]), error: null });
    attachmentRetryMock.mockResolvedValue({ data: [], error: null });
    attachmentUpsertMock.mockResolvedValue({ error: null });
    storageUploadMock.mockResolvedValue({ error: null });
  });

  it('uploads attachment bytes before returning a compact version-2 payload', async () => {
    const prepared = await prepareCompactSharedSnapshotPayload(project(), 'user-1');

    expect(prepared.payloadVersion).toBe(2);
    expect(prepared.uploadedAssetCount).toBe(1);
    expect(storageFromMock).toHaveBeenCalledWith('punchlist-attachments');
    expect(storageUploadMock).toHaveBeenCalledWith(
      expect.stringMatching(/^shared-project-1\/photo-1\/[a-f0-9]{64}-photo\.jpg$/),
      expect.any(Blob),
      expect.objectContaining({ contentType: 'image/jpeg', upsert: false })
    );
    expect(attachmentUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'shared-project-1',
        checkpoint_id: 'checkpoint-1',
        uploaded_by_user_id: 'user-1',
        storage_path: expect.stringMatching(/^shared-project-1\/photo-1\/[a-f0-9]{64}-photo\.jpg$/),
      }),
      { onConflict: 'storage_bucket,storage_path', ignoreDuplicates: true }
    );

    const compactPhoto = prepared.payload.project.areas[0].locations[0].items[0].checkpoints[0].photos[0];
    expect(compactPhoto.imageData).toBe('');
  });

  it.each([
    { status: 409, statusCode: 'ResourceAlreadyExists' },
    { status: 409, statusCode: 'KeyAlreadyExists' },
    { status: 409, statusCode: '409' },
    { status: 400, statusCode: 'Duplicate' },
    { status: 400, statusCode: '400', message: 'The resource already exists' },
  ])('verifies existing bytes before registering a duplicate response %j', async (error) => {
    storageUploadMock.mockResolvedValue({ error });
    await prepareCompactSharedSnapshotPayload(project(), 'user-1');
    expect(storageDownloadMock).toHaveBeenCalledTimes(1);
    expect(attachmentUpsertMock).toHaveBeenCalledTimes(1);
  });

  it('reconciles an upload committed before its response was lost', async () => {
    storageUploadMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ error: { status: 409, statusCode: 'ResourceAlreadyExists' } });
    await prepareCompactSharedSnapshotPayload(project(), 'user-1');
    expect(storageUploadMock).toHaveBeenCalledTimes(2);
    expect(storageDownloadMock).toHaveBeenCalledTimes(1);
    expect(attachmentUpsertMock).toHaveBeenCalledTimes(1);
  });

  it('repairs missing metadata on a later transfer without overwriting bytes', async () => {
    attachmentUpsertMock.mockResolvedValueOnce({ error: { code: '42501', message: 'Denied' } });
    await expect(prepareCompactSharedSnapshotPayload(project(), 'user-1')).rejects.toMatchObject({ code: '42501' });
    storageUploadMock.mockResolvedValue({ error: { status: 409, statusCode: 'ResourceAlreadyExists' } });
    await prepareCompactSharedSnapshotPayload(project(), 'user-1');
    expect(storageDownloadMock).toHaveBeenCalledTimes(1);
    expect(attachmentUpsertMock).toHaveBeenCalledTimes(2);
    for (const call of storageUploadMock.mock.calls) expect(call[2].upsert).toBe(false);
  });

  it('rejects mismatched bytes and unrelated errors without registering metadata', async () => {
    storageUploadMock.mockResolvedValue({ error: { status: 409, statusCode: 'ResourceAlreadyExists' } });
    storageDownloadMock.mockResolvedValue({ data: new Blob(['wrong']), error: null });
    await expect(prepareCompactSharedSnapshotPayload(project(), 'user-1')).rejects.toThrow('verification');
    expect(attachmentUpsertMock).not.toHaveBeenCalled();
    storageUploadMock.mockResolvedValue({ error: { status: 400, statusCode: '400', message: 'Invalid request' } });
    await expect(prepareCompactSharedSnapshotPayload(project(), 'user-1')).rejects.toMatchObject({ message: 'Invalid request' });
    expect(storageDownloadMock).toHaveBeenCalledTimes(1);
  });

  it('retries duplicate verification without issuing another upload', async () => {
    storageUploadMock.mockResolvedValue({ error: { status: 409, statusCode: 'ResourceAlreadyExists' } });
    storageDownloadMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ data: new Blob([atob('cGhvdG8=')]), error: null });
    await prepareCompactSharedSnapshotPayload(project(), 'user-1');
    expect(storageUploadMock).toHaveBeenCalledTimes(1);
    expect(storageDownloadMock).toHaveBeenCalledTimes(2);
    expect(attachmentUpsertMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates identical bucket/path entries within one attachment plan', async () => {
    const input = project();
    const checkpoint = input.areas[0].locations[0].items[0].checkpoints[0];
    checkpoint.photos.push(structuredClone(checkpoint.photos[0]));
    const plan = await buildSharedSnapshotAssetPlan(input);
    expect(plan.attachmentCount).toBe(2);
    expect(plan.uploads).toHaveLength(1);
  });

  it('serializes overlapping area publish and full backup preparation and rereads metadata', async () => {
    const plan = await buildSharedSnapshotAssetPlan(project());
    const upload = plan.uploads[0];
    let saved = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    storageUploadMock.mockImplementation(async () => { await gate; return { error: null }; });
    attachmentUpsertMock.mockImplementation(async () => { saved = true; return { error: null }; });
    attachmentRetryMock.mockImplementation(async () => ({ data: saved ? [{
      storage_bucket: upload.reference.bucket, storage_path: upload.reference.path,
      file_name: upload.fileName, mime_type: upload.reference.mimeType,
      size_bytes: upload.reference.sizeBytes, deleted_at: null, updated_at: timestamp.toISOString(),
    }] : [], error: null }));
    const area = prepareCompactSharedSnapshotPayload(project(), 'user-1', { areaId: 'area-1' });
    const backup = prepareCompactSharedSnapshotPayload(project(), 'user-1');
    await vi.waitFor(() => expect(storageUploadMock).toHaveBeenCalledTimes(1));
    expect(attachmentRetryMock).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([area, backup]);
    expect(storageUploadMock).toHaveBeenCalledTimes(1);
    expect(attachmentRetryMock).toHaveBeenCalledTimes(2);
  });

  it('limits area publishes to the selected area and project-level attachment metadata', async () => {
    await prepareCompactSharedSnapshotPayload(project(), 'user-1', { areaId: 'area-1' });

    expect(attachmentOrMock).toHaveBeenCalledWith('area_id.eq.area-1,area_id.is.null');
  });

  it('retries a dropped attachment upload before abandoning the safety backup', async () => {
    storageUploadMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ error: null });

    const prepared = await prepareCompactSharedSnapshotPayload(project(), 'user-1');

    expect(prepared.uploadedAssetCount).toBe(1);
    expect(storageUploadMock).toHaveBeenCalledTimes(2);
    expect(attachmentUpsertMock).toHaveBeenCalledTimes(1);
  });

  it('reads all 1,518 metadata rows before deciding a saved attachment needs uploading', async () => {
    const input = project();
    const plan = await buildSharedSnapshotAssetPlan(input);
    const saved = plan.uploads[0];
    const rows = Array.from({ length: 1_518 }, (_, index) => ({
      storage_bucket: 'punchlist-attachments',
      storage_path: `shared-project-1/other-${index}/photo.jpg`,
      file_name: 'photo.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 5,
      deleted_at: null,
      updated_at: timestamp.toISOString(),
    }));
    rows[1_517] = {
      ...rows[1_517],
      storage_path: saved.reference.path,
      file_name: saved.fileName,
      size_bytes: saved.reference.sizeBytes,
    };
    attachmentRetryMock.mockImplementation(async () => {
      const [from, to] = attachmentRangeMock.mock.lastCall!;
      return { data: rows.slice(from, to + 1), error: null };
    });

    const prepared = await prepareCompactSharedSnapshotPayload(input, 'user-1', { areaId: 'area-1' });

    expect(attachmentRangeMock.mock.calls).toEqual([[0, 499], [500, 999], [1_000, 1_499], [1_500, 1_999]]);
    expect(attachmentOrMock).toHaveBeenCalledTimes(4);
    expect(attachmentIsMock).toHaveBeenCalledTimes(4);
    expect(attachmentRetryMock.mock.calls).toEqual([[false], [false], [false], [false]]);
    expect(attachmentOrderMock.mock.calls).toEqual(Array.from({ length: 4 }, () => [
      ['storage_bucket', { ascending: true }], ['storage_path', { ascending: true }],
    ]).flat());
    expect(prepared.uploadedAssetCount).toBe(0);
    expect(storageUploadMock).not.toHaveBeenCalled();
    expect(attachmentUpsertMock).not.toHaveBeenCalled();
  });

  it('fails before uploading when an intermediate metadata page cannot be read', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      storage_bucket: 'punchlist-attachments',
      storage_path: `shared-project-1/other-${index}/photo.jpg`,
      file_name: 'photo.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 5,
      deleted_at: null,
      updated_at: timestamp.toISOString(),
    }));
    const error = { code: '42501', message: 'Attachment metadata access was denied.' };
    attachmentRetryMock
      .mockResolvedValueOnce({ data: rows, error: null })
      .mockResolvedValueOnce({ data: null, error });

    await expect(prepareCompactSharedSnapshotPayload(project(), 'user-1')).rejects.toBe(error);

    expect(attachmentRangeMock.mock.calls).toEqual([[0, 499], [500, 999]]);
    expect(storageUploadMock).not.toHaveBeenCalled();
    expect(attachmentUpsertMock).not.toHaveBeenCalled();
  });

  it('retries a failed metadata page without restarting earlier pages', async () => {
    const input = project();
    const saved = (await buildSharedSnapshotAssetPlan(input)).uploads[0];
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      storage_bucket: 'punchlist-attachments',
      storage_path: `shared-project-1/other-${index}/photo.jpg`,
      file_name: 'photo.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 5,
      deleted_at: null,
      updated_at: timestamp.toISOString(),
    }));
    attachmentRetryMock
      .mockResolvedValueOnce({ data: firstPage, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Failed to fetch' } })
      .mockResolvedValueOnce({ data: [{
        ...firstPage[0],
        storage_path: saved.reference.path,
        file_name: saved.fileName,
        size_bytes: saved.reference.sizeBytes,
      }], error: null });

    const prepared = await prepareCompactSharedSnapshotPayload(input, 'user-1');

    expect(attachmentRangeMock.mock.calls).toEqual([[0, 499], [500, 999], [500, 999]]);
    expect(attachmentRetryMock.mock.calls).toEqual([[false], [false], [false]]);
    expect(prepared.uploadedAssetCount).toBe(0);
    expect(storageUploadMock).not.toHaveBeenCalled();
  });
});

it('stops starting attachments after capacity rejection and drains the in-flight upload', async () => {
  const input = project();
  const checkpoint = input.areas[0].locations[0].items[0].checkpoints[0];
  checkpoint.photos = Array.from({ length: 8 }, (_, index) => ({ ...checkpoint.photos[0], id: `photo-${index}` }));
  attachmentRetryMock.mockResolvedValue({ data: [], error: null });
  attachmentUpsertMock.mockResolvedValue({ error: null });
  let finishSecond!: () => void;
  const capacity = { status: 500, message: 'Too many connections issued to the database' };
  storageUploadMock.mockReset();
  storageUploadMock.mockResolvedValueOnce({ error: capacity });
  storageUploadMock.mockImplementationOnce(() => new Promise((resolve) => { finishSecond = () => resolve({ error: null }); }));
  let settled = false;
  const transfer = prepareCompactSharedSnapshotPayload(input, 'user-1').finally(() => { settled = true; });
  const rejected = expect(transfer).rejects.toBe(capacity);
  await vi.waitFor(() => expect(storageUploadMock).toHaveBeenCalledTimes(2));
  expect(settled).toBe(false);
  finishSecond();
  await rejected;
  expect(storageUploadMock).toHaveBeenCalledTimes(2);
});


it('rejects invalid new photo MIME before any storage mutation', async () => {
  const input = project();
  input.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData = 'data:text/html;base64,cGhvdG8=';
  storageUploadMock.mockClear();
  attachmentUpsertMock.mockClear();
  await expect(prepareCompactSharedSnapshotPayload(input, 'user-1')).rejects.toThrow('Unsupported photo');
  expect(storageUploadMock).not.toHaveBeenCalled();
  expect(attachmentUpsertMock).not.toHaveBeenCalled();
});

it('reuses historical out-of-policy metadata without uploading or rejecting it', async () => {
  const input = project();
  input.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData = '';
  const result = await buildSharedSnapshotAssetPlan(input, [{
    storage_bucket: 'punchlist-attachments', storage_path: 'shared-project-1/photo-1/photo.bin',
    file_name: 'photo.bin', mime_type: 'application/octet-stream', size_bytes: 30 * 1024 * 1024,
    deleted_at: null, updated_at: timestamp.toISOString(),
  }]);
  expect(result.uploads).toEqual([]);
  expect(result.assets.photos['photo-1'].image.sizeBytes).toBe(30 * 1024 * 1024);
});
