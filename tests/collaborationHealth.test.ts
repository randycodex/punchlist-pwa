import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fromMock,
  getSessionMock,
  rpcMock,
  storageFromMock,
  state,
} = vi.hoisted(() => {
  const state = { active: 0, maxActive: 0 };
  const delayedResponse = (error: { code: string; message: string } | null = null) => {
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    return new Promise<{ error: { code: string; message: string } | null }>((resolve) => {
      setTimeout(() => {
        state.active -= 1;
        resolve({ error });
      }, 5);
    });
  };

  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.limit = vi.fn(() => delayedResponse());

  return {
    state,
    fromMock: vi.fn(() => query),
    rpcMock: vi.fn((name: string) => {
      const guards: Record<string, string> = {
        generate_shared_project_join_code: 'You do not have access to invite users to this project.',
        join_shared_project_by_code: 'This shared project code is invalid or expired.',
        publish_shared_project_snapshot_v2: 'You do not have access to publish this shared project.',
        publish_shared_project_metadata_snapshot: 'You do not have access to sync this shared project metadata.',
        publish_shared_project_area_snapshot: 'Update and sign in on this device before syncing team areas.',
        capture_shared_project_device_backup: 'You do not have access to back up this shared project.',
        claim_shared_project_area_v2: 'Sign in on this device before claiming an area.',
        release_shared_project_area_v2: 'Sign in on the claiming device before releasing an area.',
        transfer_shared_project_ownership: 'Shared project was not found.',
      };
      return delayedResponse(guards[name] ? { code: name === 'join_shared_project_by_code' ? '22023' : '42501', message: guards[name] } : null);
    }),
    storageFromMock: vi.fn(() => ({ list: vi.fn(() => delayedResponse()) })),
    getSessionMock: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({
  getPendingSharedAreaSyncs: async () => [], getPendingSharedProjectMetadataSyncs: async () => [],
  getPendingSharedProjectRecoveryIds: async () => [], getSharedProjectRecoveryMetadata: vi.fn(),
}));

vi.mock('@/lib/collaboration/config', () => ({
  getCollaborationRuntimeConfig: () => ({ supabaseUrl: 'https://example.supabase.co', uaiEmailDomain: 'uai-ny.com', allowedEmails: [] }),
  getAllowedCollaborationEmailDescription: () => 'uai-ny.com accounts',
}));

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    auth: { getSession: getSessionMock },
    from: fromMock,
    rpc: rpcMock,
    getChannels: () => [{ state: 'joined' }],
    storage: { from: storageFromMock },
  }),
}));

import { runCollaborationHealthCheck } from '@/lib/collaboration/diagnostics';

describe('collaboration health checks', () => {
  beforeEach(() => {
    state.active = 0;
    state.maxActive = 0;
    fromMock.mockClear();
    rpcMock.mockClear();
    storageFromMock.mockClear();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: { user: { email: 'person@uai-ny.com' } } }, error: null });
  });

  it('runs independent database probes in parallel', async () => {
    const report = await runCollaborationHealthCheck();
    expect(report.checks).toHaveLength(27);
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
    for (const key of ['sync_queue', 'recovery_queue']) {
      expect(report.checks.find((check) => check.key === key)?.message).toContain('No pending work');
    }
    expect(report.checks.find((check) => check.key === 'realtime')?.message).toContain('delivery remains unverified');
    expect(rpcMock).toHaveBeenCalledWith('capture_shared_project_device_backup', expect.objectContaining({
      p_project_id: '00000000-0000-0000-0000-000000000000',
      p_device_recovery_id: '00000000-0000-0000-0000-000000000000',
    }));
    expect(rpcMock.mock.calls.some(([name]) => name === 'capture_shared_project_backup')).toBe(false);
    expect(state.maxActive).toBeGreaterThan(1);
    expect(fromMock).toHaveBeenCalledTimes(9);
    expect(rpcMock).toHaveBeenCalledTimes(10);
    expect(storageFromMock).toHaveBeenCalledTimes(2);
    expect(storageFromMock).toHaveBeenCalledWith('punchlist-attachments');
    expect(storageFromMock).toHaveBeenCalledWith('punchlist-avatars');
  });
});
