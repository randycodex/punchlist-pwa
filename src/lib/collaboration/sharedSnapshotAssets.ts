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
  };
}

function runWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), values.length);
  return Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex];
        nextIndex += 1;
        await worker(value);
      }
    })
  ).then(() => undefined);
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

export function buildSharedSnapshotAssetPlan(
  project: Project,
  existingMetadata: SharedAttachmentMetadataRow[] = []
): SharedSnapshotAssetPlan {
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

  function planReference(input: {
    attachmentId: string;
    areaId: string | null;
    checkpointId: string | null;
    dataUrl: string | undefined;
    fallbackMimeType: string;
    fileName: (mimeType: string) => string;
    existingPredicate: (row: SharedAttachmentMetadataRow) => boolean;
  }): SharedSnapshotAssetReference | null {
    if (!input.dataUrl) {
      const existing = metadataByAttachmentId
        .get(input.attachmentId)
        ?.find(input.existingPredicate);
      return existing ? referenceFromMetadata(existing) : null;
    }

    const info = parseDataUrlInfo(input.dataUrl, input.fallbackMimeType);
    const fileName = input.fileName(info.mimeType);
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
    const reference = planReference({
      attachmentId: drawing.id,
      areaId: null,
      checkpointId: null,
      dataUrl: drawing.dataUrl,
      fallbackMimeType: drawing.mimeType,
      fileName: () => `${drawing.updatedAt.getTime()}-${drawing.fileName}`,
      existingPredicate: () => true,
    });
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
            const image = planReference({
              attachmentId: photo.id,
              areaId: area.id,
              checkpointId: checkpoint.id,
              dataUrl: photo.imageData,
              fallbackMimeType: 'image/jpeg',
              fileName: (mimeType) => `photo.${extensionForMimeType(mimeType)}`,
              existingPredicate: (row) => !row.file_name.toLowerCase().startsWith('thumbnail.'),
            });
            const thumbnail = planReference({
              attachmentId: photo.id,
              areaId: area.id,
              checkpointId: checkpoint.id,
              dataUrl: photo.thumbnail,
              fallbackMimeType: 'image/jpeg',
              fileName: (mimeType) => `thumbnail.${extensionForMimeType(mimeType)}`,
              existingPredicate: (row) => row.file_name.toLowerCase().startsWith('thumbnail.'),
            });
            const resolvedImage = image ?? thumbnail;
            if (resolvedImage) {
              assets.photos[photo.id] = {
                image: resolvedImage,
                thumbnail: thumbnail && thumbnail.path !== resolvedImage.path ? thumbnail : undefined,
              };
            }
          }

          for (const file of checkpoint.files ?? []) {
            attachmentCount += 1;
            const reference = planReference({
              attachmentId: file.id,
              areaId: area.id,
              checkpointId: checkpoint.id,
              dataUrl: file.data,
              fallbackMimeType: file.mimeType,
              fileName: () => file.name,
              existingPredicate: () => true,
            });
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
  uploadedByUserId: string
) {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before publishing shared data.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase
    .from('shared_attachments')
    .select('storage_bucket, storage_path, file_name, mime_type, size_bytes, deleted_at, updated_at')
    .eq('project_id', project.sharedProjectId)
    .is('deleted_at', null);
  if (error) throw error;

  const plan = buildSharedSnapshotAssetPlan(project, data ?? []);
  const uploadConcurrency = plan.uploads.some((upload) => upload.reference.sizeBytes > 5 * 1024 * 1024)
    ? 1
    : 2;
  await runWithConcurrency(plan.uploads, uploadConcurrency, async (upload) => {
    const blob = dataUrlToBlob(upload.dataUrl);
    const { error: uploadError } = await supabase.storage
      .from(upload.reference.bucket)
      .upload(upload.reference.path, blob, {
        cacheControl: '3600',
        contentType: upload.reference.mimeType,
        upsert: true,
      });
    if (uploadError) throw uploadError;

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
      }, { onConflict: 'storage_bucket,storage_path' });
    if (metadataError) throw metadataError;
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
  resolve: (reference: SharedSnapshotAssetReference) => Promise<string>
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

  const downloaded = new Map<string, string>();
  await runWithConcurrency([...references.entries()], 3, async ([key, entry]) => {
    try {
      downloaded.set(key, await resolve(entry.reference));
    } catch (error) {
      if (!entry.required) return;
      throw error;
    }
  });

  function getDownloaded(reference: SharedSnapshotAssetReference | undefined) {
    if (!reference) return undefined;
    return downloaded.get(`${reference.bucket}:${reference.path}`);
  }

  for (const drawing of project.facadeElevationDrawings ?? []) {
    const reference = assets.drawings[drawing.id];
    if (reference) drawing.dataUrl = getDownloaded(reference) ?? '';
  }
  for (const area of project.areas) {
    for (const location of area.locations) {
      for (const item of location.items) {
        for (const checkpoint of item.checkpoints) {
          for (const photo of checkpoint.photos) {
            const references = assets.photos[photo.id];
            if (!references) continue;
            photo.imageData = getDownloaded(references.image) ?? '';
            photo.thumbnail = getDownloaded(references.thumbnail);
          }
          for (const file of checkpoint.files ?? []) {
            const reference = assets.files[file.id];
            if (reference) file.data = getDownloaded(reference) ?? '';
          }
        }
      }
    }
  }

  return project;
}

export async function hydrateSharedSnapshotAssets(
  project: Project,
  assets: SharedSnapshotAssetManifest,
  sharedProjectId: string
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
      const { data, error } = await supabase.storage
        .from(reference.bucket)
        .download(reference.path);
      if (error || !data) {
        throw error ?? new Error(`Shared attachment ${reference.path} could not be downloaded.`);
      }
      return blobToDataUrl(data);
    }
  );
}
