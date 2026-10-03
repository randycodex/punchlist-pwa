import { describe, expect, it, vi } from 'vitest';
import { checkRpc, summarizeDiagnosticQueue, summarizeDiagnosticRealtime, runCollaborationHealthCheck } from '@/lib/collaboration/diagnostics';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), channels: vi.fn(), recoveryIds: vi.fn(),
}));
vi.mock('@/lib/collaboration/config', () => ({
  getCollaborationRuntimeConfig: () => ({ supabaseUrl: 'https://example.test', uaiEmailDomain: 'example.test', allowedEmails: [] }),
  getAllowedCollaborationEmailDescription: () => 'example.test',
}));
vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
    from: () => ({ select: () => ({ limit: async () => ({ error: null }) }) }),
    storage: { from: () => ({ list: async () => ({ error: null }) }) },
    rpc: mocks.rpc, getChannels: mocks.channels,
  }),
}));
vi.mock('@/lib/db', () => ({
  getPendingSharedAreaSyncs: async () => [],
  getPendingSharedProjectMetadataSyncs: async () => [],
  getPendingSharedProjectRecoveryIds: mocks.recoveryIds,
  getSharedProjectRecoveryMetadata: async () => ({ lastError: 'Backup upload timed out' }),
}));

describe('collaboration diagnostics', () => {
  it('probes the current backup RPC with inert inputs and includes deferred failure signals', async () => {
    mocks.rpc.mockResolvedValue({ error: { code: '42501', message: 'You do not have access to back up this shared project.' } });
    mocks.channels.mockReturnValue([{ state: 'errored' }]);
    mocks.recoveryIds.mockResolvedValue(['deferred-backup']);
    const report = await runCollaborationHealthCheck();
    expect(mocks.rpc).toHaveBeenCalledWith('capture_shared_project_device_backup', expect.objectContaining({
      p_project_id: '00000000-0000-0000-0000-000000000000',
      p_device_recovery_id: '00000000-0000-0000-0000-000000000000',
      p_project_payload: {},
    }));
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'capture_shared_project_backup')).toBe(false);
    expect(mocks.rpc).toHaveBeenCalledWith('join_shared_project_by_code', expect.objectContaining({ p_join_code: '' }));
    expect(mocks.recoveryIds.mock.calls.at(-1)?.[0].getTime()).toBe(8640000000000000);
    expect(report.checks.find((check) => check.key === 'recovery_queue')?.message).toContain('Backup upload timed out');
    expect(report.checks.find((check) => check.key === 'realtime')?.status).toBe('warning');
  });
  it('keeps the report when subscription inspection throws', async () => {
    mocks.channels.mockImplementation(() => { throw new Error('Socket unavailable'); });
    const report = await runCollaborationHealthCheck();
    expect(report.checks.find((check) => check.key === 'realtime')?.status).toBe('error');
    expect(report.checks.find((check) => check.key === 'backup_snapshot')?.status).toBe('ok');
  });
  it('accepts the precise deliberately invalid backup guard without claiming backups work', async () => {
    const result = await checkRpc('backup_snapshot', 'Backup', async () => ({ error: {
      code: '42501', message: 'You do not have access to back up this shared project.',
    } }));
    expect(result.status).toBe('ok');
    expect(result.message).toContain('unverified');
  });
  it.each([
    { code: '42501', message: 'permission denied for function capture_shared_project_device_backup' },
    { code: '57014', message: 'canceling statement due to statement timeout' },
    { code: 'PT503', message: 'The project is syncing another change. Retry shortly.' },
    { code: 'PGRST202', message: 'Could not find the function' },
    { code: '22023', message: 'Unexpected bad server configuration' },
  ])('reports actual RPC failures: $code $message', async (error) => {
    expect((await checkRpc('backup_snapshot', 'Backup', async () => ({ error }))).status).toBe('error');
  });
  it('does not accept a guard from a different RPC', async () => {
    expect((await checkRpc('list_my_shared_projects', 'List', async () => ({ error: {
      code: '42501', message: 'You do not have access to back up this shared project.',
    } }))).status).toBe('error');
  });
  it('reports thrown transport failure', async () => {
    expect((await checkRpc('backup_snapshot', 'Backup', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))).status).toBe('error');
  });
  it('does not report unexpected success from an invalid write probe as healthy', async () => {
    expect((await checkRpc('backup_snapshot', 'Backup', async () => ({ error: null }))).status).toBe('warning');
  });
  it('reports successful read responses', async () => {
    expect((await checkRpc('list_my_shared_projects', 'List', async () => ({ error: null }))).status).toBe('ok');
  });
  it('makes pending and failed recovery work actionable', () => {
    expect(summarizeDiagnosticQueue('backup', 'Backup', []).status).toBe('ok');
    expect(summarizeDiagnosticQueue('backup', 'Backup', [{ lastError: null }]).status).toBe('warning');
    const failed = summarizeDiagnosticQueue('backup', 'Backup', [{ lastError: 'Upload timed out' }]);
    expect(failed.message).toContain('Upload timed out');
    expect(failed.message).toContain('do not clear local data');
    expect(summarizeDiagnosticQueue('sync', 'Sync', [{ lastError: null, blockedByConflict: true }]).message).toContain('Review conflicting');
  });
  it('distinguishes absent, failed, reconnecting and joined realtime subscriptions', () => {
    expect(summarizeDiagnosticRealtime([]).status).toBe('warning');
    expect(summarizeDiagnosticRealtime(['errored', 'joined']).status).toBe('warning');
    expect(summarizeDiagnosticRealtime(['joining']).status).toBe('warning');
    expect(summarizeDiagnosticRealtime(['joined']).message).toContain('delivery remains unverified');
  });
});
