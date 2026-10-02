import { localAccountKey } from '@/lib/localAccount';
import { withBrowserLock } from '@/lib/browserLocks';
import type { Project } from '@/types';
import { getCollaborationSupabaseClient } from './supabaseClient';
import {
  COLLABORATION_ATTACHMENT_BUCKET,
  buildCollaborationAttachmentPath,
} from './storage';
import {
  COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION,
  createCompactSharedSnapshotPayload,
  createEmptySharedSnapshotAssetManifest,
  type SharedSnapshotAssetManifest,
  type SharedSnapshotAssetReference,
} from './sharedSnapshotPayload';
import { isCollaborationCapacityError, retryCollaborationOperation } from './request';

export class SharedAttachmentIntegrityError extends Error {
  readonly code = '22023';
}

export type SharedAttachmentMetadataRow = {
  storage_bucket: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  deleted_at: string | null;
  updated_at: string;
};

export type SharedSnapshotAssetUpload = {
  attachmentId: string;
  areaId: string | null;
  checkpointId: string | null;
  dataUrl: string;
  fileName: string;
  reference: SharedSnapshotAssetReference;
};

export type SharedSnapshotAssetPlan = {
  attachmentCount: number;
  assets: SharedSnapshotAssetManifest;
  uploads: SharedSnapshotAssetUpload[];
};

type DataUrlInfo = {
  mimeType: string;
  sizeBytes: number;
};

function parseDataUrlInfo(dataUrl: string, fallbackMimeType: string): DataUrlInfo {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) {
    throw new Error('Shared attachment data is not in a supported data URL format.');
  }

  const mimeType = match[1] || fallbackMimeType || 'application/octet-stream';
  const payload = match[3];
  if (!match[2]) {
    return {
      mimeType,
      sizeBytes: new TextEncoder().encode(decodeURIComponent(payload)).byteLength,
    };
  }

  const normalized = payload.replace(/\s/g, '');
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return {
    mimeType,
    sizeBytes: Math.max(0, Math.floor((normalized.length * 3) / 4) - padding),
  };
}

function dataUrlToBlob(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) {
    throw new Error('Shared attachment data is not in a supported data URL format.');
  }

  const mimeType = match[1] || 'application/octet-stream';
  if (!match[2]) {
    return new Blob([new TextEncoder().encode(decodeURIComponent(match[3]))], { type: mimeType });
  }
  const binary = atob(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

async function blobToDataUrl(blob: Blob) {
  if (typeof FileReader !== 'undefined') {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error('Shared attachment could not be converted for local storage.'));
      };
      reader.onerror = () => reject(reader.error ?? new Error('Shared attachment could not be read.'));
      reader.onabort = () => reject(new Error('Shared attachment download was cancelled.'));
      reader.readAsDataURL(blob);
    });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function extensionForMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/heic') return 'heic';
  if (normalized === 'image/heif') return 'heif';
  if (normalized === 'application/pdf') return 'pdf';
  const subtype = normalized.split('/')[1]?.replace(/[^a-z0-9]/g, '');
  return subtype || 'bin';
}

function referenceFromMetadata(row: SharedAttachmentMetadataRow): SharedSnapshotAssetReference {
  return {
    bucket: row.storage_bucket,
    path: row.storage_path,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: /^([a-f0-9]{64})-/.exec(row.file_name)?.[1],
  };
}

function runWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
) {
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const workerCount = Math.min(Math.max(concurrency, 1), values.length);
  return Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!failed && nextIndex < values.length) {
        const value = values[nextIndex];
        nextIndex += 1;
        try {
          await worker(value);
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
    })
  ).then(() => {
    // Drain requests already in flight before allowing a subsequent transfer.
    if (failed) throw firstError;
  });
}

export function projectHasSharedSnapshotAttachments(project: Project) {
  if ((project.facadeElevationDrawings?.length ?? 0) > 0) return true;
  return project.areas.some((area) =>
    area.locations.some((location) =>
      location.items.some((item) =>
        item.checkpoints.some((checkpoint) =>
          checkpoint.photos.length > 0 || (checkpoint.files?.length ?? 0) > 0
        )
      )
    )
  );
}

export async function buildSharedSnapshotAssetPlan(
  project: Project,
  existingMetadata: SharedAttachmentMetadataRow[] = []
): Promise<SharedSnapshotAssetPlan> {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before preparing shared attachments.');
  }
  const sharedProjectId = project.sharedProjectId;

  const assets = createEmptySharedSnapshotAssetManifest();
  const uploads: SharedSnapshotAssetUpload[] = [];
  const activeMetadata = existingMetadata.filter((row) => !row.deleted_at);
  const metadataByPath = new Map(
    activeMetadata.map((row) => [`${row.storage_bucket}:${row.storage_path}`, row])
  );
  const metadataByAttachmentId = new Map<string, SharedAttachmentMetadataRow[]>();
  const projectPathPrefix = `${sharedProjectId}/`;
  for (const row of activeMetadata) {
    if (
      row.storage_bucket !== COLLABORATION_ATTACHMENT_BUCKET
      || !row.storage_path.startsWith(projectPathPrefix)
    ) {
      continue;
    }

    const attachmentPath = row.storage_path.slice(projectPathPrefix.length);
    const separatorIndex = attachmentPath.indexOf('/');
    if (separatorIndex <= 0) continue;
    const attachmentId = attachmentPath.slice(0, separatorIndex);
    const rows = metadataByAttachmentId.get(attachmentId) ?? [];
    rows.push(row);
    metadataByAttachmentId.set(attachmentId, rows);
  }
  for (const rows of metadataByAttachmentId.values()) {
    rows.sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime());
  }
  let attachmentCount = 0;

  async function planReference(input: {
    attachmentId: string;
    areaId: string | null;
    checkpointId: string | null;
    dataUrl: string | undefined;
    fallbackMimeType: string;
    fileName: (mimeType: string) => string;
    existingPredicate: (row: SharedAttachmentMetadataRow) => boolean;
  }): Promise<SharedSnapshotAssetReference | null> {
    if (!input.dataUrl) {
      const existing = metadataByAttachmentId
        .get(input.attachmentId)
        ?.find(input.existingPredicate);
      return existing ? referenceFromMetadata(existing) : null;
    }

    const info = parseDataUrlInfo(input.dataUrl, input.fallbackMimeType);
    const bytes = await dataUrlToBlob(input.dataUrl).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const fileName = `${sha256}-${input.fileName(info.mimeType)}`;
    const path = buildCollaborationAttachmentPath({
      projectId: sharedProjectId,
      attachmentId: input.attachmentId,
      fileName,
    });
    const reference: SharedSnapshotAssetReference = {
      bucket: COLLABORATION_ATTACHMENT_BUCKET,
      path,
      mimeType: info.mimeType,
      sizeBytes: info.sizeBytes,
      sha256,
    };
    const existing = metadataByPath.get(`${reference.bucket}:${path}`);
    if (
      !existing
      || existing.storage_bucket !== reference.bucket
      || existing.mime_type !== reference.mimeType
      || Number(existing.size_bytes) !== reference.sizeBytes
    ) {
      uploads.push({
        attachmentId: input.attachmentId,
        areaId: input.areaId,
        checkpointId: input.checkpointId,
        dataUrl: input.dataUrl,
        fileName,
        reference,
      });
    }
    return reference;
  }

  for (const drawing of project.facadeElevationDrawings ?? []) {
    attachmentCount += 1;
    const reference = await planReference({
      attachmentId: drawing.id,
      areaId: null,
      checkpointId: null,
      dataUrl: drawing.dataUrl,
      fallbackMimeType: drawing.mimeType,
      fileName: () => `${drawing.updatedAt.getTime()}-${drawing.fileName}`,
      existingPredicate: () => true,
    });
    if (!reference) throw new SharedAttachmentIntegrityError(`Drawing ${drawing.id} has no saved content. Restore it before syncing.`);
    if (reference) {
      assets.drawings[drawing.id] = reference;
    }
  }

  for (const area of project.areas) {
    for (const location of area.locations) {
      for (const item of location.items) {
        for (const checkpoint of item.checkpoints) {
          for (const photo of checkpoint.photos) {
            attachmentCount += 1;
            const image = await planReference({
              attachmentId: photo.id,
              areaId: area.id,
              checkpointId: checkpoint.id,
              dataUrl: photo.imageData,
              fallbackMimeType: 'image/jpeg',
              fileName: (mimeType) => `photo.${extensionForMimeType(mimeType)}`,
              existingPredicate: (row) => !/(^|-)thumbnail\./i.test(row.file_name),
            });
            const thumbnail = await planReference({
              attachmentId: photo.id,
              areaId: area.id,
              checkpointId: checkpoint.id,
              dataUrl: photo.thumbnail,
              fallbackMimeType: 'image/jpeg',
              fileName: (mimeType) => `thumbnail.${extensionForMimeType(mimeType)}`,
              existingPredicate: (row) => /(^|-)thumbnail\./i.test(row.file_name),
            });
            if (!image) throw new SharedAttachmentIntegrityError(`Photo ${photo.id} has no full image. Restore it before syncing.`);
            const resolvedImage = image;
            if (resolvedImage) {
              assets.photos[photo.id] = {
                image: resolvedImage,
                thumbnail: thumbnail && thumbnail.path !== resolvedImage.path ? thumbnail : undefined,
              };
            }
          }

          for (const file of checkpoint.files ?? []) {
            attachmentCount += 1;
            const reference = await planReference({
              attachmentId: file.id,
              areaId: area.id,
              checkpointId: checkpoint.id,
              dataUrl: file.data,
              fallbackMimeType: file.mimeType,
              fileName: () => file.name,
              existingPredicate: () => true,
            });
            if (!reference) throw new SharedAttachmentIntegrityError(`File ${file.id} has no saved content. Restore it before syncing.`);
            if (reference) {
              assets.files[file.id] = reference;
            }
          }
        }
      }
    }
  }

  return { attachmentCount, assets, uploads };
}

export async function prepareCompactSharedSnapshotPayload(
  project: Project,
  uploadedByUserId: string,
  options: { areaId?: string } = {}
) {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before publishing shared data.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  // PostgREST caps an unpaginated response. Large projects must see every saved
  // object before deciding which attachments still need an upload.
  const metadataPageSize = 500;
  const data: SharedAttachmentMetadataRow[] = [];
  for (let offset = 0; ; offset += metadataPageSize) {
    const page = await retryCollaborationOperation(async () => {
      let metadataQuery = supabase
        .from('shared_attachments')
        .select('storage_bucket, storage_path, file_name, mime_type, size_bytes, deleted_at, updated_at')
        .eq('project_id', project.sharedProjectId!);
      if (options.areaId) {
        metadataQuery = metadataQuery.or(`area_id.eq.${options.areaId},area_id.is.null`);
      }
      const result = await metadataQuery
        .is('deleted_at', null)
        .order('storage_bucket', { ascending: true })
        .order('storage_path', { ascending: true })
        .range(offset, offset + metadataPageSize - 1)
        // Keep the explicit per-page policy from multiplying SDK retries.
        .retry(false);
      if (result.error) throw result.error;
      return result.data ?? [];
    });
    data.push(...page);
    if (page.length < metadataPageSize) break;
  }

  const plan = await buildSharedSnapshotAssetPlan(project, data);
  const uploadConcurrency = plan.uploads.some((upload) => upload.reference.sizeBytes > 5 * 1024 * 1024)
    ? 1
    : 2;
  await runWithConcurrency(plan.uploads, uploadConcurrency, async (upload) => {
    const blob = dataUrlToBlob(upload.dataUrl);
    await retryCollaborationOperation(async () => {
      const { error: uploadError } = await supabase.storage
        .from(upload.reference.bucket)
        .upload(upload.reference.path, blob, {
          cacheControl: '3600',
          contentType: upload.reference.mimeType,
          upsert: false,
        });
      if (uploadError && !['409', 'Duplicate'].includes(String(uploadError.statusCode))) throw uploadError;
    });

    await retryCollaborationOperation(async () => {
      const { error: metadataError } = await supabase
        .from('shared_attachments')
        .upsert({
          project_id: project.sharedProjectId!,
          area_id: upload.areaId,
          checkpoint_id: upload.checkpointId,
          uploaded_by_user_id: uploadedByUserId,
          storage_bucket: upload.reference.bucket,
          storage_path: upload.reference.path,
          file_name: upload.fileName,
          mime_type: upload.reference.mimeType,
          size_bytes: upload.reference.sizeBytes,
          deleted_at: null,
        }, { onConflict: 'storage_bucket,storage_path', ignoreDuplicates: true });
      if (metadataError) throw metadataError;
    });
  });

  return {
    payload: createCompactSharedSnapshotPayload(project, plan.assets),
    payloadVersion: COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION,
    uploadedAssetCount: plan.uploads.length,
  };
}

function validateReference(
  reference: SharedSnapshotAssetReference,
  sharedProjectId: string
) {
  if (reference.bucket !== COLLABORATION_ATTACHMENT_BUCKET) {
    throw new Error('Shared attachment points to an unsupported storage bucket.');
  }
  const pathSegments = reference.path.split('/');
  if (
    pathSegments.length < 3
    || pathSegments[0] !== sharedProjectId
    || pathSegments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Shared attachment points outside this shared project.');
  }
}

export async function hydrateSharedSnapshotAssetsWithResolver(
  project: Project,
  assets: SharedSnapshotAssetManifest,
  sharedProjectId: string,
  resolve: (reference: SharedSnapshotAssetReference) => Promise<string>,
  localProject?: Project
) {
  const references = new Map<string, {
    reference: SharedSnapshotAssetReference;
    required: boolean;
  }>();
  function addReference(reference: SharedSnapshotAssetReference, required: boolean) {
    validateReference(reference, sharedProjectId);
    const key = `${reference.bucket}:${reference.path}`;
    const existing = references.get(key);
    references.set(key, { reference, required: required || existing?.required === true });
  }

  Object.values(assets.photos).forEach((photo) => {
    addReference(photo.image, true);
    if (photo.thumbnail) addReference(photo.thumbnail, false);
  });
  Object.values(assets.files).forEach((reference) => addReference(reference, true));
  Object.values(assets.drawings).forEach((reference) => addReference(reference, true));

  // Reuse saved bytes only when they match the server's content hash. An
  // attachment ID alone cannot prove that the team still has the same image.
  const localCandidates = new Map<string, string>();
  function addLocalCandidate(reference: SharedSnapshotAssetReference | undefined, value: string | undefined) {
    if (reference?.sha256 && value) localCandidates.set(`${reference.bucket}:${reference.path}`, value);
  }
  if (localProject?.sharedProjectId === sharedProjectId) {
    for (const drawing of localProject.facadeElevationDrawings ?? []) {
      addLocalCandidate(assets.drawings[drawing.id], drawing.dataUrl);
    }
    for (const area of localProject.areas) {
      for (const location of area.locations) {
        for (const item of location.items) {
          for (const checkpoint of item.checkpoints) {
            for (const photo of checkpoint.photos) {
              const reference = assets.photos[photo.id];
              addLocalCandidate(reference?.image, photo.imageData);
              addLocalCandidate(reference?.thumbnail, photo.thumbnail);
            }
            for (const file of checkpoint.files ?? []) addLocalCandidate(assets.files[file.id], file.data);
          }
        }
      }
    }
  }

  const downloaded = new Map<string, string>();
  await runWithConcurrency([...references.entries()], 3, async ([key, entry]) => {
    const candidate = localCandidates.get(key);
    if (candidate) {
      try {
        await verifyAssetContent(entry.reference, dataUrlToBlob(candidate));
        downloaded.set(key, candidate);
        return;
      } catch {
        // A changed or damaged local copy needs the server's verified bytes.
      }
    }
    try {
      const value = await retryCollaborationOperation(() => resolve(entry.reference), { attempts: 2 });
      await verifyAssetContent(entry.reference, dataUrlToBlob(value));
      downloaded.set(key, value);
    } catch (error) {
      if (!entry.required && !isCollaborationCapacityError(error)) return;
      throw error;
    }
  });

  function getDownloaded(reference: SharedSnapshotAssetReference | undefined) {
    if (!reference) return undefined;
    return downloaded.get(`${reference.bucket}:${reference.path}`);
  }

  for (const drawing of project.facadeElevationDrawings ?? []) {
    const reference = assets.drawings[drawing.id];
    if (!reference && !drawing.dataUrl) throw new SharedAttachmentIntegrityError(`Drawing ${drawing.id} is missing from the shared attachment manifest.`);
    if (reference) drawing.dataUrl = getDownloaded(reference) ?? '';
  }
  for (const area of project.areas) {
    for (const location of area.locations) {
      for (const item of location.items) {
        for (const checkpoint of item.checkpoints) {
          for (const photo of checkpoint.photos) {
            const references = assets.photos[photo.id];
            if (!references) {
              if (!photo.imageData) throw new SharedAttachmentIntegrityError(`Photo ${photo.id} is missing from the shared attachment manifest.`);
              continue;
            }
            photo.imageData = getDownloaded(references.image) ?? '';
            photo.thumbnail = getDownloaded(references.thumbnail);
          }
          for (const file of checkpoint.files ?? []) {
            const reference = assets.files[file.id];
            if (!reference && !file.data) throw new SharedAttachmentIntegrityError(`File ${file.id} is missing from the shared attachment manifest.`);
            if (reference) file.data = getDownloaded(reference) ?? '';
          }
        }
      }
    }
  }

  return project;
}

async function verifyAssetContent(reference: SharedSnapshotAssetReference, blob: Blob) {
  if (!reference.sha256) return; // Read legacy snapshots without inventing a checksum.
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== reference.sha256 || blob.size !== reference.sizeBytes) {
    throw new SharedAttachmentIntegrityError('Shared attachment content failed verification. The local project was not replaced.');
  }
}

/** A bounded, disposable cache. Canonical offline media remains in IndexedDB. */
async function downloadVerifiedAsset(reference: SharedSnapshotAssetReference, download: () => Promise<Blob>) {
  const key = `https://punchlist-cache.invalid/${encodeURIComponent(reference.bucket)}/${reference.path}`;
  let cache: Cache | undefined;
  if (reference.sha256 && typeof caches !== 'undefined') {
    try {
      cache = await caches.open(localAccountKey('punchlist-shared-assets-v1'));
      const cached = await cache.match(key);
      if (cached) {
        const blob = await cached.blob();
        try { await verifyAssetContent(reference, blob); return blob; }
        catch { await cache.delete(key); }
      }
    } catch { cache = undefined; }
  }
  const blob = await download();
  await verifyAssetContent(reference, blob);
  if (cache && blob.size <= 1024 * 1024) {
    try {
      const target = cache;
      await withBrowserLock(localAccountKey('shared-asset-cache'), async () => {
        // Serialize eviction and insertion across concurrent downloads/tabs.
        // At most 64 entries of at most 1 MiB; project records are untouched.
        for (const request of (await target.keys()).slice(0, -63)) await target.delete(request);
        await target.put(key, new Response(blob));
      });
    } catch { /* Quota-limited devices can still persist the canonical project. */ }
  }
  return blob;
}

export async function hydrateSharedSnapshotAssets(
  project: Project,
  assets: SharedSnapshotAssetManifest,
  sharedProjectId: string,
  localProject?: Project
) {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  return hydrateSharedSnapshotAssetsWithResolver(
    project,
    assets,
    sharedProjectId,
    async (reference) => {
      const blob = await downloadVerifiedAsset(reference, async () => {
        const { data, error } = await supabase.storage.from(reference.bucket).download(reference.path);
        if (error || !data) throw error ?? new Error(`Shared attachment ${reference.path} could not be downloaded.`);
        return data;
      });
      return blobToDataUrl(blob);
    },
    localProject
  );
}
