import type { Project } from '@/types';
import { ProjectPayloadValidationError } from '@/lib/projectPayload';
import type { Json } from './database';
import { getCollaborationSupabaseClient } from './supabaseClient';

export const SHARED_PROJECT_METADATA_PAYLOAD_VERSION = 1;

export type SharedProjectMetadataSnapshotRow = {
  project_id: string;
  metadata_payload: Json;
  payload_version: number;
  version: number;
  published_by_user_id: string;
  published_at: string;
};

export type SharedProjectMetadataSnapshotChange = {
  metadataVersion?: number;
  publishedAt?: string;
  publishedByUserId?: string;
};

type SharedProjectMetadataPayload = {
  projectName: string;
  address: string;
  date: string;
  inspector: string;
  gcName: string;
  gcSignoff: string;
  facadeLevelStart: number | null;
  facadeLevelEnd: number | null;
};

const PAYLOAD_KEYS = new Set<keyof SharedProjectMetadataPayload>([
  'projectName',
  'address',
  'date',
  'inspector',
  'gcName',
  'gcSignoff',
  'facadeLevelStart',
  'facadeLevelEnd',
]);

export class SharedProjectMetadataConflictError extends Error {
  readonly code = 'SHARED_PROJECT_METADATA_CONFLICT';

  constructor() {
    super('This project has newer team details. Pull shared data before syncing local changes.');
    this.name = 'SharedProjectMetadataConflictError';
  }
}

function metadataRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectPayloadValidationError('Shared project metadata must be an object.');
  }
  const input = value as Record<string, unknown>;
  const unsupportedKey = Object.keys(input).find(
    (key) => !PAYLOAD_KEYS.has(key as keyof SharedProjectMetadataPayload)
  );
  if (unsupportedKey) {
    throw new ProjectPayloadValidationError(`Shared project metadata.${unsupportedKey} is unsupported.`);
  }
  return input;
}

function requiredString(
  value: unknown,
  path: string,
  options?: { allowEmpty?: boolean; maxLength?: number }
) {
  if (typeof value !== 'string' || (!options?.allowEmpty && value.trim().length === 0)) {
    throw new ProjectPayloadValidationError(`${path} must be a string${options?.allowEmpty ? '' : ' with a value'}.`);
  }
  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    throw new ProjectPayloadValidationError(`${path} must be ${options.maxLength} characters or fewer.`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, path: string) {
  if (value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProjectPayloadValidationError(`${path} must be a finite number or null.`);
  }
  if (Math.abs(value) > 10_000) {
    throw new ProjectPayloadValidationError(`${path} is outside the supported range.`);
  }
  return value;
}

function validDate(value: unknown, path: string) {
  const input = requiredString(value, path);
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new ProjectPayloadValidationError(`${path} must be a valid date.`);
  }
  return parsed;
}

function parseSharedProjectMetadataPayload(value: Json, payloadVersion: number) {
  if (payloadVersion !== SHARED_PROJECT_METADATA_PAYLOAD_VERSION) {
    throw new ProjectPayloadValidationError(`Unsupported shared project metadata payload version ${payloadVersion}.`);
  }
  const input = metadataRecord(value);
  return {
    projectName: requiredString(input.projectName, 'Shared project metadata.projectName', { maxLength: 200 }).trim(),
    address: requiredString(input.address, 'Shared project metadata.address', { allowEmpty: true, maxLength: 500 }),
    date: validDate(input.date, 'Shared project metadata.date'),
    inspector: requiredString(input.inspector, 'Shared project metadata.inspector', { allowEmpty: true, maxLength: 200 }),
    gcName: requiredString(input.gcName, 'Shared project metadata.gcName', { allowEmpty: true, maxLength: 200 }),
    gcSignoff: requiredString(input.gcSignoff, 'Shared project metadata.gcSignoff', { allowEmpty: true, maxLength: 500 }),
    facadeLevelStart: optionalFiniteNumber(
      input.facadeLevelStart,
      'Shared project metadata.facadeLevelStart'
    ),
    facadeLevelEnd: optionalFiniteNumber(
      input.facadeLevelEnd,
      'Shared project metadata.facadeLevelEnd'
    ),
  };
}

export function createSharedProjectMetadataPayload(project: Project): Json {
  const projectDate = new Date(project.date);
  if (Number.isNaN(projectDate.getTime())) {
    throw new ProjectPayloadValidationError('Shared project metadata.date must be a valid date.');
  }
  const payload: SharedProjectMetadataPayload = {
    projectName: project.projectName.trim(),
    address: project.address,
    date: projectDate.toISOString(),
    inspector: project.inspector,
    gcName: project.gcName,
    gcSignoff: project.gcSignoff,
    facadeLevelStart: project.facadeLevelStart ?? null,
    facadeLevelEnd: project.facadeLevelEnd ?? null,
  };
  parseSharedProjectMetadataPayload(payload, SHARED_PROJECT_METADATA_PAYLOAD_VERSION);
  return payload;
}

export function applySharedProjectMetadataSnapshot(
  project: Project,
  row: SharedProjectMetadataSnapshotRow
): Project {
  const metadata = parseSharedProjectMetadataPayload(row.metadata_payload, row.payload_version);
  const publishedAt = new Date(row.published_at);
  if (Number.isNaN(publishedAt.getTime())) {
    throw new ProjectPayloadValidationError('Shared project metadata publishedAt must be a valid date.');
  }
  if (!Number.isSafeInteger(row.version) || row.version < 1) {
    throw new ProjectPayloadValidationError('Shared project metadata version must be a positive integer.');
  }

  return {
    ...project,
    ...metadata,
    sharedMetadataVersion: row.version,
    sharedMetadataPublishedAt: publishedAt,
    updatedAt: new Date(Math.max(project.updatedAt.getTime(), publishedAt.getTime())),
  };
}

export function isMissingSharedProjectMetadataTableError(
  error: { code?: string; message?: string } | null
) {
  const message = error?.message?.toLowerCase() ?? '';
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('shared_project_metadata_snapshots');
}

export function isSharedProjectMetadataConflictError(
  error: unknown
): error is SharedProjectMetadataConflictError {
  if (error instanceof SharedProjectMetadataConflictError) return true;
  if (!error || typeof error !== 'object') return false;
  const input = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const code = typeof input.code === 'string' ? input.code : '';
  const message = [input.message, input.details, input.hint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  return code === '40001'
    || message.includes('project metadata has newer team data')
    || message.includes('project has newer team details');
}

export async function getSharedProjectMetadataSnapshot(
  sharedProjectId: string
): Promise<SharedProjectMetadataSnapshotRow | null> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) throw new Error('Collaboration is not configured.');
  const { data, error } = await supabase
    .from('shared_project_metadata_snapshots')
    .select('project_id, metadata_payload, payload_version, version, published_by_user_id, published_at')
    .eq('project_id', sharedProjectId)
    .maybeSingle();
  if (error) {
    if (isMissingSharedProjectMetadataTableError(error)) return null;
    throw error;
  }
  return data;
}

export async function publishSharedProjectMetadataSnapshot(input: {
  project: Project;
  baseVersion: number;
  clientId: string;
}) {
  const { project, baseVersion, clientId } = input;
  if (!project.sharedProjectId) {
    throw new Error('Share this project before syncing project details.');
  }
  if (!project.sharedSnapshotPublishedAt) {
    throw new Error('Publish the shared project once before syncing project details.');
  }
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new Error('Shared project metadata base version is invalid.');
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) throw new Error('Collaboration is not configured.');
  const { data, error } = await supabase.rpc('publish_shared_project_metadata_snapshot', {
    p_project_id: project.sharedProjectId,
    p_metadata_payload: createSharedProjectMetadataPayload(project),
    p_payload_version: SHARED_PROJECT_METADATA_PAYLOAD_VERSION,
    p_base_version: baseVersion,
    p_client_id: clientId,
  });
  if (error) {
    if (isSharedProjectMetadataConflictError(error)) {
      throw new SharedProjectMetadataConflictError();
    }
    throw error;
  }

  const result = data?.[0];
  const publishedAtMs = typeof result?.published_at === 'string'
    ? new Date(result.published_at).getTime()
    : Number.NaN;
  if (
    !result
    || !Number.isSafeInteger(result.metadata_version)
    || result.metadata_version < 1
    || !Number.isFinite(publishedAtMs)
  ) {
    throw new Error('Shared project metadata sync completed without a valid revision.');
  }
  return {
    metadataVersion: result.metadata_version,
    publishedAt: result.published_at,
  };
}

export function subscribeToSharedProjectMetadataSnapshotChanges(
  sharedProjectId: string,
  onChange: (change: SharedProjectMetadataSnapshotChange) => void
) {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) return () => {};

  const channel = supabase
    .channel(`shared-project-metadata-snapshot:${sharedProjectId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'shared_project_metadata_snapshots',
        filter: `project_id=eq.${sharedProjectId}`,
      },
      (payload) => {
        const row = typeof payload === 'object' && payload !== null && 'new' in payload
          ? (payload as { new?: Record<string, unknown> }).new
          : undefined;
        onChange({
          metadataVersion: typeof row?.version === 'number' ? row.version : undefined,
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
