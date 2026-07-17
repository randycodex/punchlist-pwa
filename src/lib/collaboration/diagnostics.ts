import type { Json } from './database';
import { getAllowedCollaborationEmailDescription, getCollaborationRuntimeConfig } from './config';
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

    return warning(key, label, getErrorText(probeError) || 'Table exists, but access was blocked by current permissions.');
  } catch (caughtError) {
    return warning(key, label, getErrorText(caughtError) || 'Table check did not finish.');
  }
}

async function checkRpc(
  key: string,
  label: string,
  probe: () => PromiseLike<{ error: unknown }>
): Promise<CollaborationHealthCheck> {
  try {
    const { error: probeError } = await probe();
    if (!probeError) {
      return ok(key, label, 'Function responded.');
    }

    if (isMissingSchemaObject(probeError)) {
      return error(key, label, getErrorText(probeError) || 'Function is missing or not visible in the schema cache.');
    }

    return ok(key, label, 'Function exists. Probe stopped before changing data.');
  } catch (caughtError) {
    return warning(key, label, getErrorText(caughtError) || 'Function check did not finish.');
  }
}

async function checkStorageBucket(
  probe: () => PromiseLike<{ error: unknown }>
): Promise<CollaborationHealthCheck> {
  const key = 'attachment_storage';
  const label = 'Shared attachment storage';
  try {
    const { error: probeError } = await probe();
    if (!probeError) {
      return ok(key, label, 'Private attachment bucket is reachable.');
    }

    const message = getErrorText(probeError);
    const normalized = message.toLowerCase();
    if (normalized.includes('bucket') && normalized.includes('not found')) {
      return error(key, label, message || 'Attachment bucket is missing.');
    }
    return warning(key, label, message || 'Attachment storage exists, but access was blocked.');
  } catch (caughtError) {
    return warning(key, label, getErrorText(caughtError) || 'Attachment storage check did not finish.');
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

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) {
    checks.push(error('auth', 'Shared auth session', sessionError.message));
  } else if (sessionData.session) {
    checks.push(ok('auth', 'Shared auth session', sessionData.session.user.email ?? 'Signed in.'));
  } else {
    checks.push(warning('auth', 'Shared auth session', 'Not signed into shared projects in this browser.'));
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
    checkStorageBucket(() => supabase.storage.from(COLLABORATION_ATTACHMENT_BUCKET).list('', { limit: 1 })),

    checkRpc('list_my_shared_projects', 'My shared projects function', () => supabase.rpc('list_my_shared_projects')),
    checkRpc('generate_join_code', 'Invite code function', () => supabase.rpc('generate_shared_project_join_code', {
      p_project_id: ZERO_UUID,
    })),
    checkRpc('join_by_code', 'Join by code function', () => supabase.rpc('join_shared_project_by_code', {
      p_join_code: '0000000000',
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
    })),
    checkRpc('backup_snapshot', 'Backup function', () => supabase.rpc('capture_shared_project_backup', {
      p_project_id: ZERO_UUID,
      p_project_payload: {} as Json,
      p_payload_version: 1,
      p_reason: 'manual',
      p_note: 'Diagnostic probe',
    })),
    checkRpc('claim_area', 'Area lock claim function', () => supabase.rpc('claim_shared_project_area', {
      p_project_id: ZERO_UUID,
      p_area_id: ZERO_UUID,
      p_expires_at: ZERO_DATE,
    })),
    checkRpc('release_area', 'Area lock release function', () => supabase.rpc('release_shared_project_area', {
      p_project_id: ZERO_UUID,
      p_area_id: ZERO_UUID,
    })),
    checkRpc('transfer_ownership', 'Ownership transfer function', () => supabase.rpc('transfer_shared_project_ownership', {
      p_project_id: ZERO_UUID,
      p_new_owner_email: 'diagnostic@uai-ny.com',
    })),
  ]);
  checks.push(...probeChecks);

  return { checkedAt: new Date(), checks };
}
