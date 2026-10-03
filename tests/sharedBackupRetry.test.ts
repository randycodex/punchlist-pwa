import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    rpc, auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } }, error: null }) },
  }),
}));
import { createProject } from '@/lib/db';
import { captureSharedProjectBackup } from '@/lib/collaboration/sharedProjectSnapshots';
beforeEach(() => { rpc.mockReset(); });
describe('all backup actions use idempotent capture', () => {
  it.each(['manual', 'restore'] as const)('reuses one ID when a %s reply is lost', async (reason) => {
    const rows = new Map<string, string>();
    let lost = true;
    rpc.mockImplementation(async (name, args) => {
      expect(name).toBe('capture_shared_project_device_backup');
      const key = args.p_device_recovery_id;
      if (!rows.has(key)) rows.set(key, crypto.randomUUID());
      if (lost) { lost = false; throw new TypeError('Failed to fetch'); }
      return { data: rows.get(key), error: null };
    });
    const project = createProject('Retry');
    project.sharedProjectId = crypto.randomUUID();
    const result = await captureSharedProjectBackup(project, reason);
    expect(rows.size).toBe(1);
    expect(result).toBe([...rows.values()][0]);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toEqual(rpc.mock.calls[1][1]);
    await captureSharedProjectBackup(project, reason);
    expect(rows.size).toBe(2); // A new deliberate action remains a new backup.
  });
  it('preserves the persisted device recovery identity', async () => {
    rpc.mockResolvedValue({ data: 'backup', error: null });
    const project = createProject('Device');
    project.sharedProjectId = crypto.randomUUID();
    const id = crypto.randomUUID();
    await captureSharedProjectBackup(project, 'before_pull', 'Saved device', id);
    expect(rpc.mock.calls[0][1].p_device_recovery_id).toBe(id);
  });
});
