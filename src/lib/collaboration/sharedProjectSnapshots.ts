import type { Area, Project } from '@/types';
import type { Json } from './database';
import { getCollaborationSupabaseClient } from './supabaseClient';

type SnapshotResult = {
  project: Project;
  publishedAt: string;
};

const SHARED_SNAPSHOT_CLOCK_SKEW_MS = 2_000;

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
    deletedAt: project.deletedAt ? new Date(project.deletedAt) : undefined,
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
    oneDriveFolderName: localProject.oneDriveFolderName || project.oneDriveFolderName,
    areas: project.areas.map((area): Area => ({
      ...area,
      projectId: nextProjectId,
    })),
  };
}

export async function publishSharedProjectSnapshot(project: Project, publishedByUserId: string) {
  if (!project.sharedProjectId) {
    throw new Error('Share this project before publishing shared data.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
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
  return {
    project: retargetProject(revivedProject, localProject),
    publishedAt: data.published_at,
  };
}

export function isSharedSnapshotNewer(localProject: Project, publishedAt: string) {
  const publishedMs = new Date(publishedAt).getTime();
  const localUpdatedMs = new Date(localProject.updatedAt).getTime();
  if (!Number.isFinite(publishedMs)) return false;
  if (!Number.isFinite(localUpdatedMs)) return true;
  return publishedMs > localUpdatedMs + SHARED_SNAPSHOT_CLOCK_SKEW_MS;
}
