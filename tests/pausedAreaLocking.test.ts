import { expect, it, vi } from 'vitest';
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/features/sync/refreshSharedProject', () => ({ refreshSharedProject: refresh }));
vi.mock('@/lib/collaboration/supabaseClient', () => ({ getCollaborationSupabaseClient: () => { throw new Error('Unexpected lock network call'); } }));
import { canUserEditClaimedArea, shouldBlockSharedAreaEdits, getActiveSharedProjectAreaClaims, releaseAllMySharedProjectAreaClaims } from '@/lib/collaboration/areaClaims';
import { prepareSharedInspectionArea } from '@/features/inspection/prepareSharedInspectionArea';
it('opens immediately and ignores previously cached exclusive claims', async () => {
  expect(canUserEditClaimedArea({ claimedByUserId: 'teammate', status: 'active' }, 'me')).toBe(true);
  expect(shouldBlockSharedAreaEdits(false, 'blocked')).toBe(false);
  expect(shouldBlockSharedAreaEdits(false, null)).toBe(false);
  expect(await prepareSharedInspectionArea('local', 'team', 'area', () => true)).toBe('current');
  expect(refresh).not.toHaveBeenCalled();
  expect(await getActiveSharedProjectAreaClaims('team')).toEqual([]);
  expect(await releaseAllMySharedProjectAreaClaims('team', 'local')).toEqual({ releasedCount: 0 });
});
