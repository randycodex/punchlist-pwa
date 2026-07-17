import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types';

const {
  attachmentIsMock,
  attachmentOrMock,
  attachmentUpsertMock,
  fromMock,
  storageFromMock,
  storageUploadMock,
} = vi.hoisted(() => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  const attachmentIsMock = vi.fn();
  const attachmentOrMock = vi.fn(() => query);
  const attachmentUpsertMock = vi.fn();
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.is = attachmentIsMock;
  query.or = attachmentOrMock;
  query.upsert = attachmentUpsertMock;

  const storageUploadMock = vi.fn();
  return {
    attachmentIsMock,
    attachmentOrMock,
    attachmentUpsertMock,
    fromMock: vi.fn(() => query),
    storageFromMock: vi.fn(() => ({ upload: storageUploadMock })),
    storageUploadMock,
  };
});

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    from: fromMock,
    storage: { from: storageFromMock },
  }),
}));

import { prepareCompactSharedSnapshotPayload } from '@/lib/collaboration/sharedSnapshotAssets';

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
    attachmentIsMock.mockReset();
    attachmentOrMock.mockClear();
    attachmentUpsertMock.mockReset();
    storageUploadMock.mockReset();
    attachmentIsMock.mockResolvedValue({ data: [], error: null });
    attachmentUpsertMock.mockResolvedValue({ error: null });
    storageUploadMock.mockResolvedValue({ error: null });
  });

  it('uploads attachment bytes before returning a compact version-2 payload', async () => {
    const prepared = await prepareCompactSharedSnapshotPayload(project(), 'user-1');

    expect(prepared.payloadVersion).toBe(2);
    expect(prepared.uploadedAssetCount).toBe(1);
    expect(storageFromMock).toHaveBeenCalledWith('punchlist-attachments');
    expect(storageUploadMock).toHaveBeenCalledWith(
      'shared-project-1/photo-1/photo.jpg',
      expect.any(Blob),
      expect.objectContaining({ contentType: 'image/jpeg', upsert: true })
    );
    expect(attachmentUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'shared-project-1',
        checkpoint_id: 'checkpoint-1',
        uploaded_by_user_id: 'user-1',
        storage_path: 'shared-project-1/photo-1/photo.jpg',
      }),
      { onConflict: 'storage_bucket,storage_path' }
    );

    const compactPhoto = prepared.payload.project.areas[0].locations[0].items[0].checkpoints[0].photos[0];
    expect(compactPhoto.imageData).toBe('');
  });

  it('limits area publishes to the selected area and project-level attachment metadata', async () => {
    await prepareCompactSharedSnapshotPayload(project(), 'user-1', { areaId: 'area-1' });

    expect(attachmentOrMock).toHaveBeenCalledWith('area_id.eq.area-1,area_id.is.null');
  });
});
