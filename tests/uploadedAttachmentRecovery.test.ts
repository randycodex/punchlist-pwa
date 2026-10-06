import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment, createFileAttachment } from '@/lib/db';
import { fillUploadedAttachmentRecoveryCopies } from '@/lib/collaboration/uploadedAttachmentRecovery';
import { createEmptySharedSnapshotAssetManifest } from '@/lib/collaboration/sharedSnapshotPayload';

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/lib/collaboration/supabaseClient', () => ({ getCollaborationSupabaseClient: () => ({ from }) }));
beforeEach(() => from.mockReset());

function fixture() {
  const project = createProject('Device copy'); project.sharedProjectId = crypto.randomUUID();
  const area = createArea(project.id, 'Unit 1010', 0), room = createLocation(area.id, 'Bedroom', 0);
  const item = createItem(room.id, 'Closet Door', 0), checkpoint = createCheckpoint(item.id, 'Finish', 0);
  const photo = createPhotoAttachment(checkpoint.id, ''); checkpoint.photos = [photo];
  item.checkpoints = [checkpoint]; room.items = [item]; area.locations = [room]; project.areas = [area];
  const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), in: vi.fn(), order: vi.fn(), range: vi.fn(), retry: vi.fn() };
  for (const name of ['select', 'eq', 'is', 'in', 'order', 'range'] as const) query[name].mockReturnValue(query);
  from.mockReturnValue(query);
  const hash = 'a'.repeat(64), fileName = `${hash}-photo.png`;
  const row = { checkpoint_id: checkpoint.id, storage_bucket: 'punchlist-attachments',
    storage_path: `${project.sharedProjectId}/${photo.id}/${fileName}`, file_name: fileName, mime_type: 'image/png', size_bytes: 1 };
  query.retry.mockResolvedValue({ data: [row], error: null });
  const unreadable = [{ id: photo.id, checkpointId: checkpoint.id, areaId: area.id, kind: 'photo' as const, size: 1, mimeType: 'image/png' }];
  return { project, checkpoint, photo, row, query, unreadable };
}

describe('recovering an upload whose area publication did not finish', () => {
  it('matches the original photo ID, checkpoint, size and type and requires a verified hash', async () => {
    const { project, photo, row, query, unreadable } = fixture();
    const assets = createEmptySharedSnapshotAssetManifest();
    await fillUploadedAttachmentRecoveryCopies(project, assets, unreadable);
    expect(assets.photos[photo.id].image).toMatchObject({ path: row.storage_path, sha256: 'a'.repeat(64), sizeBytes: 1 });
    expect(query.eq).toHaveBeenCalledWith('project_id', project.sharedProjectId);
    expect(query.in).toHaveBeenCalledWith('checkpoint_id', [photo.checkpointId]);
    expect(photo.imageData).toBe('');
  });

  it.each(['checkpoint', 'project', 'size', 'mime', 'checksum', 'thumbnail'])('rejects a mismatched %s instead of picking another attachment', async (mismatch) => {
    const { project, row, query, unreadable } = fixture();
    if (mismatch === 'checkpoint') row.checkpoint_id = crypto.randomUUID();
    if (mismatch === 'project') row.storage_path = `another-project/${row.storage_path.split('/').slice(1).join('/')}`;
    if (mismatch === 'size') row.size_bytes = 2;
    if (mismatch === 'mime') row.mime_type = 'image/jpeg';
    if (mismatch === 'checksum') { row.file_name = 'photo.png'; row.storage_path = `${row.storage_path.split('/').slice(0, 2).join('/')}/photo.png`; }
    if (mismatch === 'thumbnail') { row.file_name = `${'a'.repeat(64)}-thumbnail.png`; row.storage_path = `${row.storage_path.split('/').slice(0, 2).join('/')}/${row.file_name}`; }
    query.retry.mockResolvedValue({ data: [row], error: null });
    const assets = createEmptySharedSnapshotAssetManifest();
    await fillUploadedAttachmentRecoveryCopies(project, assets, unreadable);
    expect(assets.photos).toEqual({});
  });

  it('keeps an ambiguous attachment unresolved when two different images share its ID', async () => {
    const { project, row, query, unreadable } = fixture();
    const another = { ...row, file_name: `${'b'.repeat(64)}-photo.png`, storage_path: row.storage_path.replace('a'.repeat(64), 'b'.repeat(64)) };
    query.retry.mockResolvedValue({ data: [row, another], error: null });
    const assets = createEmptySharedSnapshotAssetManifest();
    await fillUploadedAttachmentRecoveryCopies(project, assets, unreadable);
    expect(assets.photos).toEqual({});
  });

  it('recovers a named file only with the same file size and MIME type', async () => {
    const { project, checkpoint, row, query } = fixture();
    checkpoint.photos = [];
    const file = createFileAttachment(checkpoint.id, '', 'notes.pdf', 'application/pdf', 3);
    checkpoint.files = [file];
    row.file_name = `${'a'.repeat(64)}-notes.pdf`; row.storage_path = `${project.sharedProjectId}/${file.id}/${row.file_name}`;
    row.mime_type = file.mimeType; row.size_bytes = 3;
    query.retry.mockResolvedValue({ data: [row], error: null });
    const assets = createEmptySharedSnapshotAssetManifest();
    await fillUploadedAttachmentRecoveryCopies(project, assets, []);
    expect(assets.files[file.id]).toMatchObject({ path: row.storage_path, sizeBytes: 3, mimeType: file.mimeType });
  });
});
