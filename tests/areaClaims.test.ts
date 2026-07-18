import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
}));

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    rpc: rpcMock,
  }),
}));

import {
  canUserEditClaimedArea,
  claimSharedProjectArea,
  isAreaClaimActive,
} from '@/lib/collaboration/areaClaims';

describe('persistent shared area claims', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('treats an active claim as locked even when its legacy expiry is in the past', () => {
    expect(isAreaClaimActive({
      status: 'active',
      expiresAt: new Date('2026-07-17T12:00:00.000Z'),
    })).toBe(true);
  });

  it('only allows the claimant to edit an active area', () => {
    const claim = {
      status: 'active' as const,
      claimedByUserId: 'claimant',
      expiresAt: new Date('2026-07-17T12:00:00.000Z'),
    };

    expect(canUserEditClaimedArea(claim, 'claimant')).toBe(true);
    expect(canUserEditClaimedArea(claim, 'someone-else')).toBe(false);
  });

  it('creates a claim without an expiry', async () => {
    rpcMock.mockResolvedValue({
      data: {
        id: 'claim-id',
        claimed_by_user_id: 'claimant',
        expires_at: null,
      },
      error: null,
    });

    await expect(claimSharedProjectArea('shared-project-id', 'area-id')).resolves.toEqual({
      id: 'claim-id',
      projectId: 'shared-project-id',
      areaId: 'area-id',
      claimedByUserId: 'claimant',
      status: 'active',
    });
    expect(rpcMock).toHaveBeenCalledWith('claim_shared_project_area', {
      p_project_id: 'shared-project-id',
      p_area_id: 'area-id',
      p_expires_at: null,
    });
  });
});
