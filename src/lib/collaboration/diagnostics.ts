import type { Json } from './database';
import { getAllowedCollaborationEmailDescription, getCollaborationRuntimeConfig } from './config';
import { getCollaborationSupabaseClient } from './supabaseClient';

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
  const { error: probeError } = await probe();
  if (!probeError) {
    return ok(key, label, 'Table is reachable.');
  }

  if (isMissingSchemaObject(probeError)) {
    return error(key, label, getErrorText(probeError) || 'Table is missing or not visible in the schema cache.');
  }

  return warning(key, label, getErrorText(probeError) || 'Table exists, but access was blocked by current permissions.');
}

async function checkRpc(
  key: string,
  label: string,
  probe: () => PromiseLike<{ error: unknown }>
): Promise<CollaborationHealthCheck> {
  const { error: probeError } = await probe();
  if (!probeError) {
    return ok(key, label, 'Function responded.');
  }

  if (isMissingSchemaObject(probeError)) {
    return error(key, label, getErrorText(probeError) || 'Function is missing or not visible in the schema cache.');
  }

  return ok(key, label, 'Function exists. Probe stopped before changing data.');
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

  checks.push(await checkTable('shared_projects', 'Shared projects table', () => supabase.from('shared_projects').select('id').limit(1)));
  checks.push(await checkTable('project_members', 'Project members table', () => supabase.from('project_members').select('id').limit(1)));
  checks.push(await checkTable('area_claims', 'Area claims table', () => supabase.from('area_claims').select('id').limit(1)));
  checks.push(await checkTable('snapshots', 'Latest snapshot table', () => supabase.from('shared_project_snapshots').select('project_id').limit(1)));
  checks.push(await checkTable('backup_history', 'Backup history table', () => supabase.from('shared_project_snapshot_history').select('id').limit(1)));

  checks.push(await checkRpc('list_my_shared_projects', 'My shared projects function', () => supabase.rpc('list_my_shared_projects')));
  checks.push(await checkRpc('generate_join_code', 'Invite code function', () => supabase.rpc('generate_shared_project_join_code', {
    p_project_id: ZERO_UUID,
  })));
  checks.push(await checkRpc('join_by_code', 'Join by code function', () => supabase.rpc('join_shared_project_by_code', {
    p_join_code: '0000000000',
    p_member_email: 'diagnostic@uai-ny.com',
    p_member_display_name: 'Diagnostic',
  })));
  checks.push(await checkRpc('publish_snapshot', 'Publish snapshot function', () => supabase.rpc('publish_shared_project_snapshot', {
    p_project_id: ZERO_UUID,
    p_project_payload: {} as Json,
    p_payload_version: 1,
    p_base_published_at: null,
  })));
  checks.push(await checkRpc('backup_snapshot', 'Backup function', () => supabase.rpc('capture_shared_project_backup', {
    p_project_id: ZERO_UUID,
    p_project_payload: {} as Json,
    p_payload_version: 1,
    p_reason: 'manual',
    p_note: 'Diagnostic probe',
  })));
  checks.push(await checkRpc('claim_area', 'Area lock claim function', () => supabase.rpc('claim_shared_project_area', {
    p_project_id: ZERO_UUID,
    p_area_id: ZERO_UUID,
    p_expires_at: ZERO_DATE,
  })));
  checks.push(await checkRpc('release_area', 'Area lock release function', () => supabase.rpc('release_shared_project_area', {
    p_project_id: ZERO_UUID,
    p_area_id: ZERO_UUID,
  })));
  checks.push(await checkRpc('transfer_ownership', 'Ownership transfer function', () => supabase.rpc('transfer_shared_project_ownership', {
    p_project_id: ZERO_UUID,
    p_new_owner_email: 'diagnostic@uai-ny.com',
  })));

  return { checkedAt: new Date(), checks };
}
