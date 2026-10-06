import { validateProjectIdentity } from '@/lib/projectPayload';
import type { Area, Project, PhotoAttachment, FileAttachment } from '@/types';
import type { Json } from './database';
import type { CollaborationSnapshotBackup, CollaborationSnapshotBackupReason } from './types';
import {
  clearPendingSharedAreaSyncsForProject,
  getPendingSharedAreaSyncsForProject,
  listSharedProjectRecoveries,
  getSharedProjectRecoveryMetadata,
  getSharedProjectRecoveryPreview,
  getSharedProjectRecoveryProject,
  type PendingSharedAreaSyncRecord,
  type UnreadableAttachment,
} from '@/lib/db';
import { getCollaborationSupabaseClient } from './supabaseClient';
import { createCollaborationRealtimeChannel } from './realtimeChannel';
import {
  getSharedSnapshotProjectName,
  parseSharedSnapshotPayload,
  type SharedSnapshotAssetManifest,
} from './sharedSnapshotPayload';
import {
  hydrateSharedSnapshotAssets,
  prepareCompactSharedSnapshotPayload,
  projectHasSharedSnapshotAttachments,
} from './sharedSnapshotAssets';
import {
  parseSharedProjectAreaSnapshot,
  type SharedProjectAreaSnapshotRow,
} from './sharedProjectAreas';
import {
  applySharedProjectMetadataSnapshot,
  getSharedProjectMetadataSnapshot,
  isMissingSharedProjectMetadataTableError,
} from './sharedProjectMetadata';
import { settlePendingSharedProjectMetadataSync } from './sharedProjectMetadataSyncQueue';
import { retryCollaborationOperation } from './request';
import { fillUploadedAttachmentRecoveryCopies } from './uploadedAttachmentRecovery';

type SnapshotResult = {
  project: Project;
  publishedAt: string;
};

type SnapshotMetadata = {
  publishedAt: string;
};

type SnapshotChange = {
  publishedAt?: string;
};

const SHARED_SNAPSHOT_CLOCK_SKEW_MS = 2_000;

export class SharedProjectPublishConflictError extends Error {
  readonly code = 'SHARED_PROJECT_PUBLISH_CONFLICT';
  readonly publishedAt?: string;

  constructor(publishedAt?: string) {
    super('Shared project has newer published data. Review shared data before publishing again.');
    this.name = 'SharedProjectPublishConflictError';
    this.publishedAt = publishedAt;
  }
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function retargetProject(project: Project, localProject: Project): Project {
  const nextProjectId = localProject.id;
  return {
    ...project,
    id: nextProjectId,
    sharedProjectId: localProject.sharedProjectId,
    sharedProjectLinkedAt: localProject.sharedProjectLinkedAt ?? project.sharedProjectLinkedAt,
    sharedSnapshotPublishedAt: localProject.sharedSnapshotPublishedAt ?? project.sharedSnapshotPublishedAt,
    sharedMetadataVersion: project.sharedMetadataVersion ?? localProject.sharedMetadataVersion,
    sharedMetadataPublishedAt: project.sharedMetadataPublishedAt ?? localProject.sharedMetadataPublishedAt,
    oneDriveFolderName: localProject.oneDriveFolderName || project.oneDriveFolderName,
    areas: project.areas.map((area): Area => ({
      ...area,
      projectId: nextProjectId,
    })),
  };
}

function isMissingBackupProjectNameError(error: { code?: string; message?: string } | null) {
  const message = error?.message?.toLowerCase() ?? '';
  return error?.code === '42703'
    || error?.code === 'PGRST204'
    || message.includes('project_name');
}

function isMissingAreaSnapshotsTableError(error: { code?: string; message?: string } | null) {
  const message = error?.message?.toLowerCase() ?? '';
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('shared_project_area_snapshots');
}

function laterTimestamp(left: string, right: string) {
  const leftMs = new Date(left).getTime();
  const rightMs = new Date(right).getTime();
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs > leftMs ? right : left;
}

async function listChangedSharedProjectAreaSnapshots(
  sharedProjectId: string,
  baselinePublishedAt: string
): Promise<SharedProjectAreaSnapshotRow[]> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) throw new Error('Collaboration is not configured.');
  const { data, error } = await supabase
    .from('shared_project_area_snapshots')
    .select('project_id, area_id, area_payload, payload_version, version, published_by_user_id, published_at')
    .eq('project_id', sharedProjectId)
    .gt('published_at', baselinePublishedAt)
    .order('published_at', { ascending: true });
  if (error) {
    if (isMissingAreaSnapshotsTableError(error)) return [];
    throw error;
  }
  return data ?? [];
}

function omitChangedAreaAssets(
  project: Project,
  assets: SharedSnapshotAssetManifest,
  changedAreaIds: ReadonlySet<string>
): SharedSnapshotAssetManifest {
  if (changedAreaIds.size === 0) return assets;
  const omittedPhotoIds = new Set<string>();
  const omittedFileIds = new Set<string>();
  for (const area of project.areas) {
    if (!changedAreaIds.has(area.id)) continue;
    for (const location of area.locations) {
      for (const item of location.items) {
        for (const checkpoint of item.checkpoints) {
          checkpoint.photos.forEach((photo) => omittedPhotoIds.add(photo.id));
          (checkpoint.files ?? []).forEach((file) => omittedFileIds.add(file.id));
        }
      }
    }
  }
  return {
    photos: Object.fromEntries(
      Object.entries(assets.photos).filter(([id]) => !omittedPhotoIds.has(id))
    ),
    files: Object.fromEntries(
      Object.entries(assets.files).filter(([id]) => !omittedFileIds.has(id))
    ),
    drawings: assets.drawings,
  };
}

async function prepareSnapshotTransfer(project: Project, uploadedByUserId: string) {
  validateProjectIdentity(project);
  if (!projectHasSharedSnapshotAttachments(project)) {
    return {
      payload: toJson(project),
      payloadVersion: 1,
    };
  }

  const compact = await prepareCompactSharedSnapshotPayload(project, uploadedByUserId);
  return {
    payload: toJson(compact.payload),
    payloadVersion: compact.payloadVersion,
  };
}

export function isSharedProjectPublishConflictError(error: unknown): error is SharedProjectPublishConflictError {
  if (error instanceof SharedProjectPublishConflictError) return true;
  if (!error || typeof error !== 'object') return false;

  const maybeError = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const code = typeof maybeError.code === 'string' ? maybeError.code : '';
  const message = [maybeError.message, maybeError.details, maybeError.hint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();

  return code === '40001'
    || code === 'PT409'
    || code === 'SHARED_PROJECT_METADATA_CONFLICT'
    || message.includes('newer published data')
    || message.includes('newer team details')
    || message.includes('pull shared data before publishing');
}

export function isSharedProjectPublishStale(project: Project, remotePublishedAt: string) {
  const remotePublishedMs = new Date(remotePublishedAt).getTime();
  if (!Number.isFinite(remotePublishedMs)) return false;

  const basePublishedAt = project.sharedSnapshotPublishedAt;
  if (!basePublishedAt) return true;

  const basePublishedMs = new Date(basePublishedAt).getTime();
  if (!Number.isFinite(basePublishedMs)) return true;

  // Both timestamps come from the collaboration database, so allowing clock
  // skew here can admit a genuinely newer server revision. UI freshness checks
  // still keep their tolerance for local device clocks below.
  return remotePublishedMs > basePublishedMs;
}

export async function getSharedProjectPublishConflict(project: Project): Promise<SnapshotMetadata | null> {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before publishing shared data.');
  }

  const metadata = await getSharedProjectSnapshotMetadata(project.sharedProjectId);
  if (!metadata) return null;

  return isSharedProjectPublishStale(project, metadata.publishedAt) ? metadata : null;
}

export async function publishSharedProjectSnapshot(project: Project, publishedByUserId: string) {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before publishing shared data.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  await settlePendingSharedProjectMetadataSync(project);

  const conflict = await getSharedProjectPublishConflict(project);
  if (conflict) {
    throw new SharedProjectPublishConflictError(conflict.publishedAt);
  }

  let queuedAreaSyncsAtStart: PendingSharedAreaSyncRecord[] = [];
  try {
    queuedAreaSyncsAtStart = await getPendingSharedAreaSyncsForProject(project.id);
  } catch (queueReadError) {
    console.info('Shared publish queue snapshot was unavailable:', queueReadError);
  }
  const basePublishedAt = project.sharedSnapshotPublishedAt?.toISOString() ?? null;
  const transfer = await prepareSnapshotTransfer(project, publishedByUserId);
  const { data, error } = await supabase.rpc('publish_shared_project_snapshot_v2', {
    p_project_id: project.sharedProjectId,
    p_project_payload: transfer.payload,
    p_payload_version: transfer.payloadVersion,
    p_base_published_at: basePublishedAt,
    p_base_metadata_version: project.sharedMetadataVersion ?? 0,
  });

  if (error) {
    if (isSharedProjectPublishConflictError(error)) {
      throw new SharedProjectPublishConflictError();
    }
    throw error;
  }
  if (typeof data !== 'string' || !Number.isFinite(new Date(data).getTime())) {
    throw new Error('Shared project publishing completed without a valid timestamp.');
  }
  const publishedAt = data;

  project.sharedSnapshotPublishedAt = new Date(publishedAt);
  project.sharedBaselinePublishedAt = new Date(publishedAt);
  try {
    await clearPendingSharedAreaSyncsForProject(project.id, queuedAreaSyncsAtStart);
  } catch (cleanupError) {
    console.info('Published shared data, but local area sync cleanup was skipped:', cleanupError);
  }
  return { publishedAt };
}

export async function captureSharedProjectBackup(
  project: Project,
  reason: CollaborationSnapshotBackupReason,
  note?: string,
  deviceRecoveryId?: string
) {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before backing up shared data.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const userId = sessionData.session?.user.id;
  if (!userId) {
    throw new Error('Enable shared projects before backing up shared data.');
  }

  // Keep one action identity across transport retries. Device recoveries
  // continue supplying their persisted identity across reloads.
  const backupOperationId = deviceRecoveryId ?? crypto.randomUUID();
  const transfer = await prepareSnapshotTransfer(project, userId);
  const data = await retryCollaborationOperation(async () => {
    const args = {
      p_project_id: project.sharedProjectId!,
      p_project_payload: transfer.payload,
      p_payload_version: transfer.payloadVersion,
      p_reason: reason,
      p_note: note ?? null,
    };
    const result = await supabase.rpc('capture_shared_project_device_backup', {
      ...args, p_device_recovery_id: backupOperationId,
    });
    if (result.error) throw result.error;
    return result.data;
  });

  return data;
}

/** Fetch matching saved media without applying any remote inspection or revision. */
export async function getSharedAttachmentRecoveryCopies(localProject: Project, attachmentIds: string[], areaId?: string, unreadable: UnreadableAttachment[] = []): Promise<Project> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase || !localProject.sharedProjectId) throw new Error('Collaboration is not configured.');
  const wanted = new Set(attachmentIds);
  const baseline = await supabase.from('shared_project_snapshots')
    .select('project_payload, payload_version, published_at').eq('project_id', localProject.sharedProjectId).maybeSingle();
  if (baseline.error) throw baseline.error;
  let areaQuery = supabase.from('shared_project_area_snapshots')
    .select('area_payload, payload_version').eq('project_id', localProject.sharedProjectId);
  if (baseline.data) areaQuery = areaQuery.gt('published_at', baseline.data.published_at);
  if (areaId) areaQuery = areaQuery.eq('area_id', areaId);
  const changed = await areaQuery;
  if (changed.error) throw changed.error;
  const photos = new Map<string, PhotoAttachment>();
  const files = new Map<string, FileAttachment>();
  const assets: SharedSnapshotAssetManifest = { photos: {}, files: {}, drawings: {} };
  const sources = [...(baseline.data ? [parseSharedSnapshotPayload(baseline.data.project_payload, baseline.data.payload_version)] : []),
    ...(changed.data ?? []).map((row) => parseSharedSnapshotPayload(row.area_payload, row.payload_version))];
  for (const source of sources) {
    for (const area of source.project.areas) {
      if (areaId && area.id !== areaId) continue;
      for (const room of area.locations) for (const item of room.items) for (const checkpoint of item.checkpoints) {
        for (const photo of checkpoint.photos) if (wanted.has(photo.id)) {
          photos.set(`${checkpoint.id}:${photo.id}`, photo);
          if (source.assets.photos[photo.id]) assets.photos[photo.id] = source.assets.photos[photo.id];
          else delete assets.photos[photo.id];
        }
        for (const file of checkpoint.files ?? []) if (wanted.has(file.id)) {
          files.set(`${checkpoint.id}:${file.id}`, file);
          if (source.assets.files[file.id]) assets.files[file.id] = source.assets.files[file.id];
          else delete assets.files[file.id];
        }
      }
    }
  }
  const copies: Project = { ...localProject, facadeElevationDrawings: undefined,
    areas: localProject.areas.filter((area) => !areaId || area.id === areaId).map((area) => ({ ...area,
      locations: area.locations.map((room) => ({ ...room, items: room.items.map((item) => ({ ...item,
        checkpoints: item.checkpoints.map((checkpoint) => ({ ...checkpoint,
          photos: checkpoint.photos.flatMap((photo) => {
            if (!wanted.has(photo.id)) return [];
            const copy = photos.get(`${checkpoint.id}:${photo.id}`); return [{ ...(copy ?? photo), imageData: copy?.imageData ?? '', thumbnail: copy?.thumbnail }];
          }),
          files: (checkpoint.files ?? []).flatMap((file) => {
            if (!wanted.has(file.id)) return [];
            const copy = files.get(`${checkpoint.id}:${file.id}`); return [{ ...(copy ?? file), data: copy?.data ?? '' }];
          }),
        })),
      })) })),
    })),
  };
  await fillUploadedAttachmentRecoveryCopies(copies, assets, unreadable);
  const photoIds = new Set<string>();
  const fileIds = new Set<string>();
  for (const area of copies.areas) for (const room of area.locations) for (const item of room.items) for (const checkpoint of item.checkpoints) {
    checkpoint.photos = checkpoint.photos.filter((photo) => photo.imageData || assets.photos[photo.id]);
    checkpoint.files = checkpoint.files.filter((file) => file.data || assets.files[file.id]);
    checkpoint.photos.forEach((photo) => photoIds.add(photo.id));
    checkpoint.files.forEach((file) => fileIds.add(file.id));
  }
  Object.keys(assets.photos).forEach((id) => { if (!photoIds.has(id)) delete assets.photos[id]; });
  Object.keys(assets.files).forEach((id) => { if (!fileIds.has(id)) delete assets.files[id]; });
  return hydrateSharedSnapshotAssets(copies, assets, localProject.sharedProjectId);
}

export async function getSharedProjectSnapshot(localProject: Project): Promise<SnapshotResult> {
  if (!localProject.sharedProjectId) {
    throw new Error('This project is not linked to a shared project.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase
    .from('shared_project_snapshots')
    .select('project_payload, payload_version, published_at')
    .eq('project_id', localProject.sharedProjectId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error('No shared data has been published for this project yet.');
  }

  const parsed = parseSharedSnapshotPayload(data.project_payload, data.payload_version);
  const [changedAreaSnapshots, metadataSnapshot] = await Promise.all([
    listChangedSharedProjectAreaSnapshots(localProject.sharedProjectId, data.published_at),
    getSharedProjectMetadataSnapshot(localProject.sharedProjectId),
  ]);
  const changedAreaIds = new Set(changedAreaSnapshots.map((row) => row.area_id));
  let hydratedProject = await hydrateSharedSnapshotAssets(
    parsed.project,
    omitChangedAreaAssets(parsed.project, parsed.assets, changedAreaIds),
    localProject.sharedProjectId,
    localProject
  );
  let latestPublishedAt = data.published_at;
  const drawingsById = new Map(
    (hydratedProject.facadeElevationDrawings ?? []).map((drawing) => [drawing.id, drawing])
  );
  for (const row of changedAreaSnapshots) {
    const parsedArea = await parseSharedProjectAreaSnapshot(
      row,
      localProject.id,
      localProject.sharedProjectId,
      localProject
    );
    const existingIndex = hydratedProject.areas.findIndex((area) => area.id === parsedArea.area.id);
    if (existingIndex === -1) hydratedProject.areas.push(parsedArea.area);
    else hydratedProject.areas[existingIndex] = parsedArea.area;
    for (const drawing of parsedArea.drawings) drawingsById.set(drawing.id, drawing);
    latestPublishedAt = laterTimestamp(latestPublishedAt, row.published_at);
  }
  hydratedProject = {
    ...hydratedProject,
    facadeElevationDrawings: drawingsById.size > 0 ? [...drawingsById.values()] : undefined,
  };
  if (metadataSnapshot) {
    hydratedProject = applySharedProjectMetadataSnapshot(hydratedProject, metadataSnapshot);
    latestPublishedAt = laterTimestamp(latestPublishedAt, metadataSnapshot.published_at);
  }
  const retargetedProject = retargetProject(hydratedProject, localProject);
  return {
    project: {
      ...retargetedProject,
      sharedBaselinePublishedAt: new Date(data.published_at),
      sharedSnapshotPublishedAt: new Date(latestPublishedAt),
    },
    publishedAt: latestPublishedAt,
  };
}

/** Check all area revisions, even when this browser sent a newer unrelated area. */
export async function hasNewerSharedProjectRevisions(project: Project): Promise<boolean> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase || !project.sharedProjectId) throw new Error('Collaboration is not configured.');
  const snapshot = await supabase.from('shared_project_snapshots').select('published_at')
    .eq('project_id', project.sharedProjectId).maybeSingle();
  if (snapshot.error) throw snapshot.error;
  if (!snapshot.data) return false;
  const baseline = project.sharedBaselinePublishedAt ?? project.sharedSnapshotPublishedAt;
  if (!baseline || new Date(snapshot.data.published_at).getTime() > new Date(baseline).getTime()) return true;
  const areas = await supabase.from('shared_project_area_snapshots').select('area_id, version')
    .eq('project_id', project.sharedProjectId).gt('published_at', snapshot.data.published_at);
  if (areas.error) throw areas.error;
  const localVersions = new Map(project.areas.map((area) => [area.id, area.sharedVersion ?? 0]));
  if (areas.data?.some((area) => area.version > (localVersions.get(area.area_id) ?? 0))) return true;
  const metadata = await supabase.from('shared_project_metadata_snapshots').select('version')
    .eq('project_id', project.sharedProjectId).gt('published_at', snapshot.data.published_at).maybeSingle();
  if (metadata.error) throw metadata.error;
  return (metadata.data?.version ?? 0) > (project.sharedMetadataVersion ?? 0);
}

export async function getSharedProjectSnapshotMetadata(sharedProjectId: string): Promise<SnapshotMetadata | null> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const snapshotResult = await supabase
    .from('shared_project_snapshots')
    .select('published_at')
    .eq('project_id', sharedProjectId)
    .maybeSingle();
  if (snapshotResult.error) throw snapshotResult.error;
  if (!snapshotResult.data) return null;

  // Project sync reads this before and after flushing the queues. Avoid a
  // three-request burst each time, especially when several people sync.
  const areaResult = await supabase
    .from('shared_project_area_snapshots')
    .select('published_at')
    .eq('project_id', sharedProjectId)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const metadataResult = await supabase
    .from('shared_project_metadata_snapshots')
    .select('published_at')
    .eq('project_id', sharedProjectId)
    .maybeSingle();

  if (areaResult.error && !isMissingAreaSnapshotsTableError(areaResult.error)) {
    throw areaResult.error;
  }
  if (metadataResult.error && !isMissingSharedProjectMetadataTableError(metadataResult.error)) {
    throw metadataResult.error;
  }
  const areaPublishedAt = areaResult.data?.published_at;
  const metadataPublishedAt = metadataResult.data?.published_at;
  const latestPublishedAt = [areaPublishedAt, metadataPublishedAt]
    .filter((value): value is string => typeof value === 'string')
    .reduce(laterTimestamp, snapshotResult.data.published_at);
  return {
    publishedAt: latestPublishedAt,
  };
}

function reviveBackup(row: {
  id: string;
  project_id: string;
  project_name?: string | null;
  project_payload?: Json;
  captured_by_user_id: string;
  captured_at: string;
  reason: CollaborationSnapshotBackupReason;
  note: string | null;
}): CollaborationSnapshotBackup {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name?.trim()
      || getSharedSnapshotProjectName(row.project_payload),
    capturedByUserId: row.captured_by_user_id,
    capturedAt: new Date(row.captured_at),
    reason: row.reason,
    note: row.note ?? undefined,
  };
}

async function listCloudSharedProjectBackups(sharedProjectId: string): Promise<CollaborationSnapshotBackup[]> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const currentResult = await supabase
    .from('shared_project_snapshot_history')
    .select('id, project_id, project_name, captured_by_user_id, captured_at, reason, note')
    .eq('project_id', sharedProjectId)
    .order('captured_at', { ascending: false })
    .limit(50);

  if (!currentResult.error) {
    return (currentResult.data ?? []).map((row) => reviveBackup(row));
  }

  if (!isMissingBackupProjectNameError(currentResult.error)) {
    throw currentResult.error;
  }

  // Allow the client to deploy before the project_name migration. This legacy
  // fallback is intentionally removed from the normal path because it downloads
  // every historical project payload just to render the backup list.
  const legacyResult = await supabase
    .from('shared_project_snapshot_history')
    .select('id, project_id, project_payload, captured_by_user_id, captured_at, reason, note')
    .eq('project_id', sharedProjectId)
    .order('captured_at', { ascending: false })
    .limit(50);
  if (legacyResult.error) throw legacyResult.error;
  return (legacyResult.data ?? []).map((row) => reviveBackup(row));
}

export async function listSharedProjectBackups(sharedProjectId: string): Promise<CollaborationSnapshotBackup[]> {
  const recoveries = await listSharedProjectRecoveries(sharedProjectId);
  let cloud: CollaborationSnapshotBackup[];
  try {
    cloud = await listCloudSharedProjectBackups(sharedProjectId);
  } catch (error) {
    if (recoveries.length === 0) throw error;
    // These device copies remain available even when the team service cannot
    // return its history. Loading this list never needs attachment binaries.
    cloud = [];
  }
  const cloudIds = new Set(cloud.map((backup) => backup.id));
  const device: CollaborationSnapshotBackup[] = recoveries
    .filter((backup) => !backup.cloudBackupId || !cloudIds.has(backup.cloudBackupId))
    .map((backup) => ({
      id: `device:${backup.id}`,
      projectId: backup.sharedProjectId,
      projectName: backup.projectName,
      capturedByUserId: '',
      capturedAt: backup.capturedAt,
      reason: backup.reason,
      storageLocation: 'device',
      uploadPending: backup.uploadStatus === 'pending',
    }));
  return [...device, ...cloud].sort((left, right) => right.capturedAt.getTime() - left.capturedAt.getTime()).slice(0, 50);
}

async function getDeviceBackupMetadata(localProject: Project, backupId: string) {
  const id = backupId.slice('device:'.length);
  const backup = await getSharedProjectRecoveryMetadata(id);
  if (!backup || !localProject.sharedProjectId || backup.sharedProjectId !== localProject.sharedProjectId) {
    throw new Error('Could not find this project recovery copy on this device.');
  }
  return backup;
}

async function loadSharedProjectBackup(localProject: Project, backupId: string) {
  if (!localProject.sharedProjectId) {
    throw new Error('This project is not linked to a shared project.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase
    .from('shared_project_snapshot_history')
    .select('project_payload, payload_version, captured_at')
    .eq('id', backupId)
    .eq('project_id', localProject.sharedProjectId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error('Could not find this shared project backup.');
  }

  return data;
}

/** Read backup contents for a comparison without downloading attachment binaries. */
export async function getSharedProjectBackupPreview(localProject: Project, backupId: string): Promise<Project> {
  if (backupId.startsWith('device:')) {
    const backup = await getDeviceBackupMetadata(localProject, backupId);
    const project = await getSharedProjectRecoveryPreview(backup.id);
    if (!project) throw new Error('Could not load this recovery copy on this device.');
    return retargetProject(project, localProject);
  }
  const data = await loadSharedProjectBackup(localProject, backupId);
  return parseSharedSnapshotPayload(data.project_payload, data.payload_version).project;
}

export async function getSharedProjectBackupSnapshot(localProject: Project, backupId: string): Promise<SnapshotResult> {
  if (backupId.startsWith('device:')) {
    const backup = await getDeviceBackupMetadata(localProject, backupId);
    const project = await getSharedProjectRecoveryProject(backup.id);
    if (!project) throw new Error('Could not load this recovery copy on this device.');
    return { project: retargetProject(project, localProject), publishedAt: backup.capturedAt.toISOString() };
  }
  const data = await loadSharedProjectBackup(localProject, backupId);

  const parsed = parseSharedSnapshotPayload(data.project_payload, data.payload_version);
  const hydratedProject = await hydrateSharedSnapshotAssets(
    parsed.project,
    parsed.assets,
    localProject.sharedProjectId!
  );
  const retargetedProject = retargetProject(hydratedProject, localProject);
  return {
    project: {
      ...retargetedProject,
      sharedSnapshotPublishedAt: localProject.sharedSnapshotPublishedAt,
    },
    publishedAt: data.captured_at,
  };
}

export function isSharedSnapshotNewer(localProject: Project, publishedAt: string) {
  const publishedMs = new Date(publishedAt).getTime();
  const comparisonDate = localProject.sharedSnapshotPublishedAt ?? localProject.updatedAt;
  const localUpdatedMs = new Date(comparisonDate).getTime();
  if (!Number.isFinite(publishedMs)) return false;
  if (!Number.isFinite(localUpdatedMs)) return true;
  return publishedMs > localUpdatedMs + SHARED_SNAPSHOT_CLOCK_SKEW_MS;
}

export function hasNewerLocalChangesThanSharedSnapshot(localProject: Project, publishedAt: string) {
  const publishedMs = new Date(publishedAt).getTime();
  const localUpdatedMs = new Date(localProject.updatedAt).getTime();
  if (!Number.isFinite(publishedMs) || !Number.isFinite(localUpdatedMs)) return true;
  return localUpdatedMs > publishedMs + SHARED_SNAPSHOT_CLOCK_SKEW_MS;
}

export function subscribeToSharedProjectSnapshotChanges(
  sharedProjectId: string,
  onChange: (change: SnapshotChange) => void
) {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    return () => {};
  }

  const channel = createCollaborationRealtimeChannel(supabase, `shared-project-snapshot:${sharedProjectId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'shared_project_snapshots',
        filter: `project_id=eq.${sharedProjectId}`,
      },
      (payload) => {
        const row = typeof payload === 'object' && payload !== null && 'new' in payload
          ? (payload as { new?: Record<string, unknown> }).new
          : undefined;
        const publishedAt = typeof row?.published_at === 'string' ? row.published_at : undefined;
        onChange({ publishedAt });
      }
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
