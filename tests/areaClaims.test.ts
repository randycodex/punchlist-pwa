import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpcMock, fromMock, getUserMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  getUserMock: vi.fn(),
}));

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    rpc: rpcMock,
    from: fromMock,
    auth: { getUser: getUserMock },
  }),
}));

import {
  canUserEditClaimedArea,
  claimSharedProjectArea,
  isAreaClaimActive,
  releaseAllMySharedProjectAreaClaims,
} from '@/lib/collaboration/areaClaims';

describe('persistent shared area claims', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    getUserMock.mockReset();
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

  it('releases only the signed-in user active area locks on a project', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'me' } },
      error: null,
    });
    fromMock.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: [
              {
                id: 'c1',
                project_id: 'shared-project-id',
                area_id: 'area-1',
                claimed_by_user_id: 'me',
                status: 'active',
                claimed_at: '2026-07-19T12:00:00.000Z',
                expires_at: null,
                released_at: null,
                transferred_to_user_id: null,
              },
              {
                id: 'c2',
                project_id: 'shared-project-id',
                area_id: 'area-2',
                claimed_by_user_id: 'someone-else',
                status: 'active',
                claimed_at: '2026-07-19T12:00:00.000Z',
                expires_at: null,
                released_at: null,
                transferred_to_user_id: null,
              },
              {
                id: 'c3',
                project_id: 'shared-project-id',
                area_id: 'area-3',
                claimed_by_user_id: 'me',
                status: 'active',
                claimed_at: '2026-07-19T12:05:00.000Z',
                expires_at: null,
                released_at: null,
                transferred_to_user_id: null,
              },
            ],
            error: null,
          }),
        }),
      }),
    });
    rpcMock.mockResolvedValue({ data: null, error: null });

    await expect(releaseAllMySharedProjectAreaClaims('shared-project-id')).resolves.toEqual({
      releasedCount: 2,
    });
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock).toHaveBeenCalledWith('release_shared_project_area', {
      p_project_id: 'shared-project-id',
      p_area_id: 'area-1',
    });
    expect(rpcMock).toHaveBeenCalledWith('release_shared_project_area', {
      p_project_id: 'shared-project-id',
      p_area_id: 'area-3',
    });
  });

  it('reports zero when the user has no active locks', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'me' } },
      error: null,
    });
    fromMock.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    });

    await expect(releaseAllMySharedProjectAreaClaims('shared-project-id')).resolves.toEqual({
      releasedCount: 0,
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
