import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fromMock,
  getSessionMock,
  rpcMock,
  storageFromMock,
  state,
} = vi.hoisted(() => {
  const state = { active: 0, maxActive: 0 };
  const delayedResponse = () => {
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    return new Promise<{ error: null }>((resolve) => {
      setTimeout(() => {
        state.active -= 1;
        resolve({ error: null });
      }, 5);
    });
  };

  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.limit = vi.fn(() => delayedResponse());

  return {
    state,
    fromMock: vi.fn(() => query),
    rpcMock: vi.fn(() => delayedResponse()),
    storageFromMock: vi.fn(() => ({ list: vi.fn(() => delayedResponse()) })),
    getSessionMock: vi.fn(),
  };
});

vi.mock('@/lib/collaboration/config', () => ({
  getCollaborationRuntimeConfig: () => ({ supabaseUrl: 'https://example.supabase.co', uaiEmailDomain: 'uai-ny.com', allowedEmails: [] }),
  getAllowedCollaborationEmailDescription: () => 'uai-ny.com accounts',
}));

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    auth: { getSession: getSessionMock },
    from: fromMock,
    rpc: rpcMock,
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
    expect(report.checks).toHaveLength(19);
    expect(state.maxActive).toBeGreaterThan(1);
    expect(fromMock).toHaveBeenCalledTimes(7);
    expect(rpcMock).toHaveBeenCalledTimes(8);
    expect(storageFromMock).toHaveBeenCalledWith('punchlist-attachments');
  });
});
