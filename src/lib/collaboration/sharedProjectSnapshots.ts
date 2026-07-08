import type { Area, Project } from '@/types';
import type { Json } from './database';
import type { CollaborationSnapshotBackup, CollaborationSnapshotBackupReason } from './types';
import { getCollaborationSupabaseClient } from './supabaseClient';

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

function reviveProjectDates(project: Project): Project {
  return {
    ...project,
    date: new Date(project.date),
    createdAt: new Date(project.createdAt),
    updatedAt: new Date(project.updatedAt),
    sharedProjectLinkedAt: project.sharedProjectLinkedAt ? new Date(project.sharedProjectLinkedAt) : undefined,
    sharedSnapshotPublishedAt: project.sharedSnapshotPublishedAt
      ? new Date(project.sharedSnapshotPublishedAt)
      : undefined,
    deletedAt: project.deletedAt ? new Date(project.deletedAt) : undefined,
    facadeElevationDrawings: (project.facadeElevationDrawings ?? []).map((drawing) => ({
      ...drawing,
      createdAt: new Date(drawing.createdAt),
      updatedAt: new Date(drawing.updatedAt),
    })),
    areas: project.areas.map((area) => ({
      ...area,
      createdAt: new Date(area.createdAt),
      updatedAt: new Date(area.updatedAt),
      deletedAt: area.deletedAt ? new Date(area.deletedAt) : undefined,
      locations: area.locations.map((location) => ({
        ...location,
        createdAt: new Date(location.createdAt),
        updatedAt: new Date(location.updatedAt),
        items: location.items.map((item) => ({
          ...item,
          createdAt: new Date(item.createdAt),
          updatedAt: new Date(item.updatedAt),
          checkpoints: item.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            createdAt: new Date(checkpoint.createdAt),
            updatedAt: new Date(checkpoint.updatedAt),
            photos: checkpoint.photos.map((photo) => ({
              ...photo,
              createdAt: new Date(photo.createdAt),
            })),
            files: (checkpoint.files ?? []).map((file) => ({
              ...file,
              createdAt: new Date(file.createdAt),
            })),
          })),
        })),
      })),
    })),
  };
}

function retargetProject(project: Project, localProject: Project): Project {
  const nextProjectId = localProject.id;
  return {
    ...project,
    id: nextProjectId,
    sharedProjectId: localProject.sharedProjectId,
    sharedProjectLinkedAt: localProject.sharedProjectLinkedAt ?? project.sharedProjectLinkedAt,
    sharedSnapshotPublishedAt: localProject.sharedSnapshotPublishedAt ?? project.sharedSnapshotPublishedAt,
    oneDriveFolderName: localProject.oneDriveFolderName || project.oneDriveFolderName,
    areas: project.areas.map((area): Area => ({
      ...area,
      projectId: nextProjectId,
    })),
  };
}

function isMissingPublishRpcError(error: { code?: string; message?: string }) {
  const message = error.message?.toLowerCase() ?? '';
  return error.code === 'PGRST202' || message.includes('publish_shared_project_snapshot');
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
    || message.includes('newer published data')
    || message.includes('pull shared data before publishing');
}

export function isSharedProjectPublishStale(project: Project, remotePublishedAt: string) {
  const remotePublishedMs = new Date(remotePublishedAt).getTime();
  if (!Number.isFinite(remotePublishedMs)) return false;

  const basePublishedAt = project.sharedSnapshotPublishedAt;
  if (!basePublishedAt) return true;

  const basePublishedMs = new Date(basePublishedAt).getTime();
  if (!Number.isFinite(basePublishedMs)) return true;

  return remotePublishedMs > basePublishedMs + SHARED_SNAPSHOT_CLOCK_SKEW_MS;
}

export async function getSharedProjectPublishConflict(project: Project): Promise<SnapshotMetadata | null> {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before publishing shared data.');
  }

  const metadata = await getSharedProjectSnapshotMetadata(project.sharedProjectId);
  if (!metadata) return null;

  return isSharedProjectPublishStale(project, metadata.publishedAt) ? metadata : null;
}

async function publishSnapshotWithUpsert(
  project: Project,
  publishedByUserId: string
): Promise<{ publishedAt: string }> {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before publishing shared data.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const conflict = await getSharedProjectPublishConflict(project);
  if (conflict) {
    throw new SharedProjectPublishConflictError(conflict.publishedAt);
  }

  const publishedAt = new Date().toISOString();
  const { error } = await supabase
    .from('shared_project_snapshots')
    .upsert({
      project_id: project.sharedProjectId,
      project_payload: toJson(project),
      payload_version: 1,
      published_by_user_id: publishedByUserId,
      published_at: publishedAt,
    });

  if (error) {
    throw error;
  }

  return { publishedAt };
}

export async function publishSharedProjectSnapshot(project: Project, publishedByUserId: string) {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before publishing shared data.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const conflict = await getSharedProjectPublishConflict(project);
  if (conflict) {
    throw new SharedProjectPublishConflictError(conflict.publishedAt);
  }

  const basePublishedAt = project.sharedSnapshotPublishedAt?.toISOString() ?? null;
  const { data, error } = await supabase.rpc('publish_shared_project_snapshot', {
    p_project_id: project.sharedProjectId,
    p_project_payload: toJson(project),
    p_payload_version: 1,
    p_base_published_at: basePublishedAt,
  });

  let publishedAt: string;
  if (error) {
    if (isSharedProjectPublishConflictError(error)) {
      throw new SharedProjectPublishConflictError();
    }
    if (!isMissingPublishRpcError(error)) {
      throw error;
    }
    const fallbackResult = await publishSnapshotWithUpsert(project, publishedByUserId);
    publishedAt = fallbackResult.publishedAt;
  } else {
    publishedAt = typeof data === 'string' ? data : new Date().toISOString();
  }

  project.sharedSnapshotPublishedAt = new Date(publishedAt);
  return { publishedAt };
}

export async function captureSharedProjectBackup(
  project: Project,
  reason: CollaborationSnapshotBackupReason,
  note?: string
) {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before backing up shared data.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase.rpc('capture_shared_project_backup', {
    p_project_id: project.sharedProjectId,
    p_project_payload: toJson(project),
    p_payload_version: 1,
    p_reason: reason,
    p_note: note ?? null,
  });

  if (error) {
    throw error;
  }

  return data;
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
    .select('project_payload, published_at')
    .eq('project_id', localProject.sharedProjectId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error('No shared data has been published for this project yet.');
  }

  const revivedProject = reviveProjectDates(data.project_payload as unknown as Project);
  const retargetedProject = retargetProject(revivedProject, localProject);
  return {
    project: {
      ...retargetedProject,
      sharedSnapshotPublishedAt: new Date(data.published_at),
    },
    publishedAt: data.published_at,
  };
}

export async function getSharedProjectSnapshotMetadata(sharedProjectId: string): Promise<SnapshotMetadata | null> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase
    .from('shared_project_snapshots')
    .select('published_at')
    .eq('project_id', sharedProjectId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? { publishedAt: data.published_at } : null;
}

function reviveBackup(row: {
  id: string;
  project_id: string;
  project_payload: Json;
  captured_by_user_id: string;
  captured_at: string;
  reason: CollaborationSnapshotBackupReason;
  note: string | null;
}): CollaborationSnapshotBackup {
  const payload = row.project_payload as unknown as Partial<Project>;
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: payload.projectName ?? 'Shared project backup',
    capturedByUserId: row.captured_by_user_id,
    capturedAt: new Date(row.captured_at),
    reason: row.reason,
    note: row.note ?? undefined,
  };
}

export async function listSharedProjectBackups(sharedProjectId: string): Promise<CollaborationSnapshotBackup[]> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase
    .from('shared_project_snapshot_history')
    .select('id, project_id, project_payload, captured_by_user_id, captured_at, reason, note')
    .eq('project_id', sharedProjectId)
    .order('captured_at', { ascending: false })
    .limit(50);

  if (error) {
    throw error;
  }

  return (data ?? []).map(reviveBackup);
}

export async function getSharedProjectBackupSnapshot(localProject: Project, backupId: string): Promise<SnapshotResult> {
  if (!localProject.sharedProjectId) {
    throw new Error('This project is not linked to a shared project.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase
    .from('shared_project_snapshot_history')
    .select('project_payload, captured_at')
    .eq('id', backupId)
    .eq('project_id', localProject.sharedProjectId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error('Could not find this shared project backup.');
  }

  const revivedProject = reviveProjectDates(data.project_payload as unknown as Project);
  const retargetedProject = retargetProject(revivedProject, localProject);
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
  const localUpdatedMs = new Date(localProject.updatedAt).getTime();
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

  const channel = supabase
    .channel(`shared-project-snapshot:${sharedProjectId}`)
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
