import type { Area, FacadeElevationDrawing, Project } from '@/types';
import type { Json } from './database';
import { getCollaborationSupabaseClient } from './supabaseClient';
import {
  hydrateSharedSnapshotAssets,
  prepareCompactSharedSnapshotPayload,
  projectHasSharedSnapshotAttachments,
} from './sharedSnapshotAssets';
import { parseSharedSnapshotPayload } from './sharedSnapshotPayload';

export type SharedProjectAreaSnapshotRow = {
  project_id: string;
  area_id: string;
  area_payload: Json;
  payload_version: number;
  version: number;
  published_by_user_id: string;
  published_at: string;
};

export type SharedProjectAreaSnapshotChange = {
  areaId?: string;
  areaVersion?: number;
  publishedAt?: string;
  publishedByUserId?: string;
};

export class SharedProjectAreaConflictError extends Error {
  readonly code = 'SHARED_PROJECT_AREA_CONFLICT';

  constructor() {
    super('This area has newer team data. Pull shared data before syncing local changes.');
    this.name = 'SharedProjectAreaConflictError';
  }
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function referencedDrawingIds(area: Area) {
  const ids = new Set<string>();
  if (area.elevationDrawingId) ids.add(area.elevationDrawingId);
  for (const location of area.locations) {
    for (const item of location.items) {
      for (const checkpoint of item.checkpoints) {
        if (checkpoint.elevationMarker?.drawingId) {
          ids.add(checkpoint.elevationMarker.drawingId);
        }
      }
    }
  }
  return ids;
}

function scopeProjectToArea(project: Project, area: Area, nextVersion: number): Project {
  const drawingIds = referencedDrawingIds(area);
  return {
    ...project,
    areas: [{ ...area, sharedVersion: nextVersion }],
    facadeElevationDrawings: project.facadeElevationDrawings?.filter((drawing) => drawingIds.has(drawing.id)),
  };
}

export function isSharedProjectAreaConflictError(error: unknown): error is SharedProjectAreaConflictError {
  if (error instanceof SharedProjectAreaConflictError) return true;
  if (!error || typeof error !== 'object') return false;
  const input = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const code = typeof input.code === 'string' ? input.code : '';
  const message = [input.message, input.details, input.hint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  return code === '40001'
    || code === 'PT409'
    || message.includes('newer team area data')
    || message.includes('area has newer team data');
}

export async function publishSharedProjectAreaSnapshot(input: {
  project: Project;
  areaId: string;
  baseVersion: number;
  basePublishedAt: string;
  clientId: string;
  publishedByUserId: string;
}) {
  const { project, areaId, baseVersion, basePublishedAt, clientId, publishedByUserId } = input;
  if (!project.sharedProjectId) {
    throw new Error('Share this project before syncing area data.');
  }
  if (!project.sharedSnapshotPublishedAt) {
    throw new Error('Publish the shared project once before syncing individual areas.');
  }
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new Error('Shared area base version is invalid.');
  }
  if (!Number.isFinite(new Date(basePublishedAt).getTime())) {
    throw new Error('Shared area base timestamp is invalid.');
  }
  const area = project.areas.find((entry) => entry.id === areaId);
  if (!area) {
    throw new Error('Could not find this area before syncing shared data.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const scopedProject = scopeProjectToArea(project, area, baseVersion + 1);
  const transfer = projectHasSharedSnapshotAttachments(scopedProject)
    ? await prepareCompactSharedSnapshotPayload(scopedProject, publishedByUserId, { areaId })
    : { payload: scopedProject, payloadVersion: 1 };
  const { data, error } = await supabase.rpc('publish_shared_project_area_snapshot', {
    p_project_id: project.sharedProjectId,
    p_area_id: areaId,
    p_area_payload: toJson(transfer.payload),
    p_payload_version: transfer.payloadVersion,
    p_base_version: baseVersion,
    p_base_published_at: basePublishedAt,
    p_client_id: clientId,
  });
  if (error) {
    if (isSharedProjectAreaConflictError(error)) {
      throw new SharedProjectAreaConflictError();
    }
    throw error;
  }

  const result = data?.[0];
  const publishedAtMs = typeof result?.published_at === 'string'
    ? new Date(result.published_at).getTime()
    : Number.NaN;
  if (
    !result
    || !Number.isSafeInteger(result.area_version)
    || result.area_version < 1
    || !Number.isFinite(publishedAtMs)
  ) {
    throw new Error('Shared area sync completed without a valid revision.');
  }
  return {
    areaVersion: result.area_version,
    publishedAt: result.published_at,
  };
}

export async function parseSharedProjectAreaSnapshot(
  row: SharedProjectAreaSnapshotRow,
  localProjectId: string,
  sharedProjectId: string
): Promise<{ area: Area; drawings: FacadeElevationDrawing[] }> {
  if (row.project_id !== sharedProjectId || row.area_id.length === 0) {
    throw new Error('Shared area snapshot does not belong to this project.');
  }
  const parsed = parseSharedSnapshotPayload(row.area_payload, row.payload_version);
  const hydrated = await hydrateSharedSnapshotAssets(
    parsed.project,
    parsed.assets,
    sharedProjectId
  );
  const area = hydrated.areas.find((entry) => entry.id === row.area_id);
  if (!area) {
    throw new Error('Shared area snapshot is missing its area payload.');
  }
  return {
    area: {
      ...area,
      projectId: localProjectId,
      sharedVersion: row.version,
      sharedPublishedAt: new Date(row.published_at),
    },
    drawings: hydrated.facadeElevationDrawings ?? [],
  };
}

export function subscribeToSharedProjectAreaSnapshotChanges(
  sharedProjectId: string,
  onChange: (change: SharedProjectAreaSnapshotChange) => void,
  areaId?: string
) {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) return () => {};

  const channel = supabase
    .channel(`shared-project-area-snapshot:${sharedProjectId}:${areaId ?? 'all'}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'shared_project_area_snapshots',
        filter: `project_id=eq.${sharedProjectId}`,
      },
      (payload) => {
        const row = typeof payload === 'object' && payload !== null && 'new' in payload
          ? (payload as { new?: Record<string, unknown> }).new
          : undefined;
        if (areaId && row?.area_id !== areaId) return;
        onChange({
          areaId: typeof row?.area_id === 'string' ? row.area_id : undefined,
          areaVersion: typeof row?.version === 'number' ? row.version : undefined,
          publishedAt: typeof row?.published_at === 'string' ? row.published_at : undefined,
          publishedByUserId: typeof row?.published_by_user_id === 'string'
            ? row.published_by_user_id
            : undefined,
        });
      }
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
