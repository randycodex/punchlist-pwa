import type { Project } from '@/types';
import type { UnreadableAttachment } from '@/lib/db';
import type { SharedSnapshotAssetManifest, SharedSnapshotAssetReference } from './sharedSnapshotPayload';
import { getCollaborationSupabaseClient } from './supabaseClient';
import { COLLABORATION_ATTACHMENT_BUCKET } from './storage';
import type { CollaborationDatabase } from './database';

type Uploaded = Pick<CollaborationDatabase['public']['Tables']['shared_attachments']['Row'],
  'checkpoint_id' | 'storage_bucket' | 'storage_path' | 'file_name' | 'mime_type' | 'size_bytes'>;

/** An upload may have reached Storage before its area's publication failed. */
export async function fillUploadedAttachmentRecoveryCopies(
  copies: Project, assets: SharedSnapshotAssetManifest, unreadable: UnreadableAttachment[]
) {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase || !copies.sharedProjectId) throw new Error('Collaboration is not configured.');
  const missing = copies.areas.flatMap((area) => area.locations.flatMap((room) => room.items.flatMap((item) =>
    item.checkpoints.filter((checkpoint) => checkpoint.photos.some((photo) => !photo.imageData && !assets.photos[photo.id])
      || checkpoint.files.some((file) => !file.data && !assets.files[file.id])))));
  const checkpointIds = [...new Set(missing.map((checkpoint) => checkpoint.id))];
  if (!checkpointIds.length) return;
  const rows: Uploaded[] = [];
  for (let start = 0; start < checkpointIds.length; start += 80) {
    for (let offset = 0; ; offset += 500) {
      const result = await supabase.from('shared_attachments')
        .select('checkpoint_id, storage_bucket, storage_path, file_name, mime_type, size_bytes')
        .eq('project_id', copies.sharedProjectId).is('deleted_at', null)
        .in('checkpoint_id', checkpointIds.slice(start, start + 80))
        .order('storage_path', { ascending: true }).range(offset, offset + 499).retry(false);
      if (result.error) throw result.error;
      rows.push(...result.data ?? []);
      if ((result.data?.length ?? 0) < 500) break;
    }
  }
  function match(id: string, checkpointId: string, kind: 'photo' | 'file', size?: number, mime?: string): SharedSnapshotAssetReference | undefined {
    const descriptor = unreadable.find((entry) => entry.id === id && entry.checkpointId === checkpointId && entry.kind === kind);
    const expectedSize = descriptor?.size ?? size;
    const expectedMime = descriptor?.mimeType || mime;
    const candidates = rows.filter((row) => row.checkpoint_id === checkpointId
      && row.storage_bucket === COLLABORATION_ATTACHMENT_BUCKET
      && row.storage_path === `${copies.sharedProjectId}/${id}/${row.file_name}`
      && /^[a-f0-9]{64}-/.test(row.file_name)
      && (kind !== 'photo' || /^[a-f0-9]{64}-photo\.[a-z0-9]+$/i.test(row.file_name))
      && (expectedSize === undefined || row.size_bytes === expectedSize)
      && (!expectedMime || row.mime_type === expectedMime));
    // Never choose arbitrarily between different content saved under one ID.
    const hashes = new Set(candidates.map((row) => row.file_name.slice(0, 64)));
    if (hashes.size !== 1) return undefined;
    const row = candidates[0];
    return { bucket: row.storage_bucket, path: row.storage_path, mimeType: row.mime_type,
      sizeBytes: row.size_bytes, sha256: row.file_name.slice(0, 64) };
  }
  for (const checkpoint of missing) {
    for (const photo of checkpoint.photos) {
      if (photo.imageData || assets.photos[photo.id]) continue;
      const image = match(photo.id, checkpoint.id, 'photo');
      if (image) assets.photos[photo.id] = { image };
    }
    for (const file of checkpoint.files) {
      if (file.data || assets.files[file.id]) continue;
      const reference = match(file.id, checkpoint.id, 'file', file.size, file.mimeType);
      if (reference) assets.files[file.id] = reference;
    }
  }
}
