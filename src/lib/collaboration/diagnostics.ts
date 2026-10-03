import { getPendingSharedAreaSyncs, getPendingSharedProjectMetadataSyncs, getPendingSharedProjectRecoveryIds, getSharedProjectRecoveryMetadata } from '@/lib/db';
import type { Json } from './database';
import { getAllowedCollaborationEmailDescription, getCollaborationRuntimeConfig } from './config';
import { COLLABORATION_AVATAR_BUCKET } from './profileAvatars';
import { getCollaborationSupabaseClient } from './supabaseClient';
import { COLLABORATION_ATTACHMENT_BUCKET } from './storage';

export type CollaborationHealthStatus = 'ok' | 'warning' | 'error';

export type CollaborationHealthCheck = {
  key: string;
  label: string;
  status: CollaborationHealthStatus;
  message: string;
};

export type CollaborationHealthReport = {
  checkedAt: Date;
  checks: CollaborationHealthCheck[];
};

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const ZERO_DATE = '1970-01-01T00:00:00.000Z';

function getErrorText(error: unknown) {
  if (!error) return '';
  if (error instanceof Error) return error.message;
  if (typeof error === 'object') {
    const maybeError = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
    return [maybeError.message, maybeError.details, maybeError.hint, maybeError.code]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join(' ');
  }
  return String(error);
}

function isMissingSchemaObject(error: unknown) {
  const text = getErrorText(error).toLowerCase();
  return (
    text.includes('pgrst202') ||
    text.includes('could not find the function') ||
    text.includes('schema cache') ||
    text.includes('relation') && text.includes('does not exist')
  );
}

function ok(key: string, label: string, message: string): CollaborationHealthCheck {
  return { key, label, status: 'ok', message };
}

function warning(key: string, label: string, message: string): CollaborationHealthCheck {
  return { key, label, status: 'warning', message };
}

function error(key: string, label: string, message: string): CollaborationHealthCheck {
  return { key, label, status: 'error', message };
}

// Match the exact application guard, never SQLSTATE 42501 alone: missing
// EXECUTE grants and database permission failures use the same SQLSTATE.
const expectedProbeDenials: Record<string, string[]> = {
  generate_join_code: ['Shared projects require an authenticated user.', 'You do not have access to invite users to this project.'],
  join_by_code: ['Shared projects require an authenticated user.', 'Your signed-in account does not match the shared-project email.', 'Shared projects require an allowed email address.', 'This shared project code is invalid or expired.'],
  publish_snapshot: ['Shared project publishing requires an authenticated user.', 'You do not have access to publish this shared project.'],
  publish_metadata_snapshot: ['Shared project metadata syncing requires an authenticated user.', 'You do not have access to sync this shared project metadata.'],
  publish_area_snapshot: ['Update and sign in on this device before syncing team areas.'],
  backup_snapshot: ['Shared project backups require an authenticated user.', 'You do not have access to back up this shared project.'],
  claim_area: ['Sign in on this device before claiming an area.'],
  release_area: ['Sign in on the claiming device before releasing an area.'],
  transfer_ownership: ['Shared projects require an authenticated user.', 'Ownership transfer requires an allowed email address.', 'Shared project was not found.'],
};

function isExpectedProbeDenial(key: string, value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const input = value as { code?: unknown; message?: unknown };
  return (input.code === '42501' || input.code === '22023')
    && typeof input.message === 'string'
    && (expectedProbeDenials[key] ?? []).includes(input.message);
}

export function summarizeDiagnosticQueue(key: string, label: string, records: { lastError: string | null; blockedByConflict?: boolean }[]) {
  const failed = records.filter((record) => record.lastError || record.blockedByConflict);
  if (failed.length) return warning(key, label, `${records.length} pending; ${failed.length} need attention. ${failed[0].lastError ?? 'Review conflicting team updates.'} Work remains saved on this device. Review team sync or sign in and retry; do not clear local data.`);
  if (records.length) return warning(key, label, `${records.length} pending. Keep this device online and signed in until uploads are confirmed.`);
  return ok(key, label, 'No pending work on this device.');
}

async function checkLocalQueues(): Promise<CollaborationHealthCheck[]> {
  try {
    const [areas, metadata, recoveryIds] = await Promise.all([
      getPendingSharedAreaSyncs(), getPendingSharedProjectMetadataSyncs(),
      // Include deferred retries, not just uploads due this instant.
      getPendingSharedProjectRecoveryIds(new Date(8640000000000000)),
    ]);
    const recoveries = await Promise.all(recoveryIds.map(getSharedProjectRecoveryMetadata));
    return [summarizeDiagnosticQueue('sync_queue', 'Device team sync queue', [...areas, ...metadata]),
      summarizeDiagnosticQueue('recovery_queue', 'Device recovery backup queue', recoveries.filter((record) => record !== undefined))];
  } catch (caughtError) {
    return [error('local_queues', 'Device queues', `Cannot inspect saved work: ${getErrorText(caughtError)}. Do not clear local data.`)];
  }
}

export function summarizeDiagnosticRealtime(states: string[]): CollaborationHealthCheck {
  if (!states.length) return warning('realtime', 'Team realtime', 'No active subscriptions to inspect. Open a team project; delivery remains unverified.');
  if (states.some((state) => state !== 'joined')) return warning('realtime', 'Team realtime', `Channel states: ${states.join(', ')}. Team updates may be delayed; check connection and use Sync Team Projects.`);
  return ok('realtime', 'Team realtime', `${states.length} channels joined. Cross-device event delivery remains unverified.`);
}

async function checkTable(
  key: string,
  label: string,
  probe: () => PromiseLike<{ error: unknown }>
): Promise<CollaborationHealthCheck> {
  try {
    const { error: probeError } = await probe();
    if (!probeError) {
      return ok(key, label, 'Table is reachable.');
    }

    if (isMissingSchemaObject(probeError)) {
      return error(key, label, getErrorText(probeError) || 'Table is missing or not visible in the schema cache.');
    }

    return error(key, label, `Table check failed: ${getErrorText(probeError)}. Check session, table grants and service availability.`);
  } catch (caughtError) {
    return error(key, label, getErrorText(caughtError) || 'Table check did not finish; check connectivity.');
  }
}

export async function checkRpc(
  key: string,
  label: string,
  probe: () => PromiseLike<{ error: unknown }>
): Promise<CollaborationHealthCheck> {
  try {
    const { error: probeError } = await probe();
    if (!probeError) {
      return key === 'list_my_shared_projects'
        ? ok(key, label, 'Read-only function responded.')
        : warning(key, label, 'Invalid diagnostic input unexpectedly succeeded. Inspect the function guards before relying on this operation.');
    }

    if (isMissingSchemaObject(probeError)) {
      return error(key, label, getErrorText(probeError) || 'Function is missing or not visible in the schema cache.');
    }

    if (isExpectedProbeDenial(key, probeError)) {
      return ok(key, label, 'Expected diagnostic guard responded; no write path was exercised. Successful authorized use remains unverified.');
    }
    return error(key, label, `Function check failed: ${getErrorText(probeError) || 'Unknown service error'}. Check connectivity, session and server permissions.`);
  } catch (caughtError) {
    return error(key, label, `Function check did not finish: ${getErrorText(caughtError)}. Check connectivity and retry.`);
  }
}

async function checkStorageBucket(
  key: string,
  label: string,
  probe: () => PromiseLike<{ error: unknown }>
): Promise<CollaborationHealthCheck> {
  try {
    const { error: probeError } = await probe();
    if (!probeError) {
      return ok(key, label, 'Private storage bucket is reachable.');
    }

    const message = getErrorText(probeError);
    const normalized = message.toLowerCase();
    if (normalized.includes('bucket') && normalized.includes('not found')) {
      return error(key, label, message || 'Storage bucket is missing.');
    }
    return error(key, label, message || 'Storage access failed; check session, bucket policy and service availability.');
  } catch (caughtError) {
    return error(key, label, getErrorText(caughtError) || 'Storage check did not finish; check connectivity.');
  }
}

export async function runCollaborationHealthCheck(): Promise<CollaborationHealthReport> {
  const checks: CollaborationHealthCheck[] = [];
  const config = getCollaborationRuntimeConfig();
  const supabase = getCollaborationSupabaseClient();

  if (!config || !supabase) {
    checks.push(error('config', 'Runtime config', 'Supabase URL or publishable key is missing.'));
    return { checkedAt: new Date(), checks };
  }

  checks.push(ok('config', 'Runtime config', `Using ${config.supabaseUrl}.`));
  checks.push(
    config.uaiEmailDomain || config.allowedEmails.length > 0
      ? ok('email-access', 'Allowed email access', `Allowed: ${getAllowedCollaborationEmailDescription(config)}.`)
      : warning('email-access', 'Allowed email access', 'No allowed email domain or test email is configured.')
  );

  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) {
      checks.push(error('auth', 'Shared auth session', sessionError.message));
    } else if (sessionData.session) {
      checks.push(ok('auth', 'Shared auth session', sessionData.session.user.email ?? 'Signed in.'));
    } else {
      checks.push(warning('auth', 'Shared auth session', 'Not signed into shared projects in this browser.'));
    }
  } catch (caughtError) {
    checks.push(error('auth', 'Shared auth session', `${getErrorText(caughtError)}. Sign in again or check connectivity.`));
  }

  const probeChecks = await Promise.all([
    checkTable('shared_projects', 'Shared projects table', () => supabase.from('shared_projects').select('id').limit(1)),
    checkTable('user_profiles', 'User profiles table', () => supabase.from('user_profiles').select('user_id').limit(1)),
    checkTable('project_members', 'Project members table', () => supabase.from('project_members').select('id').limit(1)),
    checkTable('area_claims', 'Area claims table', () => supabase.from('area_claims').select('id').limit(1)),
    checkTable('shared_attachments', 'Shared attachments table', () => supabase.from('shared_attachments').select('id').limit(1)),
    checkTable('snapshots', 'Latest snapshot table', () => supabase.from('shared_project_snapshots').select('project_id').limit(1)),
    checkTable('area_snapshots', 'Area snapshot table', () => supabase.from('shared_project_area_snapshots').select('project_id').limit(1)),
    checkTable('metadata_snapshots', 'Project metadata table', () => supabase.from('shared_project_metadata_snapshots').select('project_id').limit(1)),
    checkTable('backup_history', 'Backup history table', () => supabase.from('shared_project_snapshot_history').select('id').limit(1)),
    checkStorageBucket(
      'attachment_storage',
      'Shared attachment storage',
      () => supabase.storage.from(COLLABORATION_ATTACHMENT_BUCKET).list('', { limit: 1 })
    ),
    checkStorageBucket(
      'avatar_storage',
      'Profile avatar storage',
      () => supabase.storage.from(COLLABORATION_AVATAR_BUCKET).list('', { limit: 1 })
    ),

    checkRpc('list_my_shared_projects', 'My shared projects function', () => supabase.rpc('list_my_shared_projects')),
    checkRpc('generate_join_code', 'Invite code function', () => supabase.rpc('generate_shared_project_join_code', {
      p_project_id: ZERO_UUID,
    })),
    checkRpc('join_by_code', 'Join by code function', () => supabase.rpc('join_shared_project_by_code', {
      p_join_code: '',
      p_member_email: 'diagnostic@uai-ny.com',
      p_member_display_name: 'Diagnostic',
    })),
    checkRpc('publish_snapshot', 'Publish snapshot function', () => supabase.rpc('publish_shared_project_snapshot_v2', {
      p_project_id: ZERO_UUID,
      p_project_payload: {} as Json,
      p_payload_version: 1,
      p_base_published_at: null,
      p_base_metadata_version: 0,
    })),
    checkRpc('publish_metadata_snapshot', 'Publish project metadata function', () => supabase.rpc('publish_shared_project_metadata_snapshot', {
      p_project_id: ZERO_UUID,
      p_metadata_payload: {} as Json,
      p_payload_version: 1,
      p_base_version: 0,
      p_client_id: ZERO_UUID,
    })),
    checkRpc('publish_area_snapshot', 'Publish area function', () => supabase.rpc('publish_shared_project_area_snapshot', {
      p_project_id: ZERO_UUID,
      p_area_id: ZERO_UUID,
      p_area_payload: {} as Json,
      p_payload_version: 1,
      p_base_version: 0,
      p_base_published_at: ZERO_DATE,
      p_client_id: ZERO_UUID,
      p_device_id: ZERO_UUID,
    })),
    checkRpc('backup_snapshot', 'Idempotent backup function', () => supabase.rpc('capture_shared_project_device_backup', {
      p_device_recovery_id: ZERO_UUID,
      p_project_id: ZERO_UUID,
      p_project_payload: {} as Json,
      p_payload_version: 1,
      p_reason: 'manual',
      p_note: 'Diagnostic probe',
    })),
    checkRpc('claim_area', 'Area lock claim function', () => supabase.rpc('claim_shared_project_area_v2', {
      p_project_id: ZERO_UUID,
      p_area_id: ZERO_UUID,
      p_device_id: ZERO_UUID,
    })),
    checkRpc('release_area', 'Area lock release function', () => supabase.rpc('release_shared_project_area_v2', {
      p_project_id: ZERO_UUID,
      p_area_id: ZERO_UUID,
      p_claim_id: ZERO_UUID,
      p_device_id: ZERO_UUID,
      p_expected_version: 0,
    })),
    checkRpc('transfer_ownership', 'Ownership transfer function', () => supabase.rpc('transfer_shared_project_ownership', {
      p_project_id: ZERO_UUID,
      p_new_owner_email: 'diagnostic@uai-ny.com',
    })),
  ]);
  checks.push(...probeChecks, ...await checkLocalQueues());
  try {
    checks.push(summarizeDiagnosticRealtime(supabase.getChannels().map((channel) => channel.state)));
  } catch (caughtError) {
    checks.push(error('realtime', 'Team realtime', `Cannot inspect subscriptions: ${getErrorText(caughtError)}. Check connection and use Sync Team Projects.`));
  }

  return { checkedAt: new Date(), checks };
}
