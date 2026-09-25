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
  isSharedAreaClaimBlockedError,
  shouldBlockSharedAreaEdits,
  releaseAllMySharedProjectAreaClaims,
  releaseAbandonedSharedProjectArea,
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

  it('recognizes the server lock conflict so the area shows who can act', () => {
    expect(isSharedAreaClaimBlockedError({ code: '55P03', message: 'This area is locked by another user until they release it.' })).toBe(true);
    expect(isSharedAreaClaimBlockedError(new Error('This area is locked by another user until they release it.'))).toBe(true);
    expect(isSharedAreaClaimBlockedError(new Error('Failed to fetch'))).toBe(false);
  });

  it('allows local work when locking is unavailable but blocks a known teammate lock', () => {
    expect(shouldBlockSharedAreaEdits(false, null)).toBe(true);
    expect(shouldBlockSharedAreaEdits(false, 'lost')).toBe(false);
    expect(shouldBlockSharedAreaEdits(false, 'blocked')).toBe(true);
    expect(shouldBlockSharedAreaEdits(true, null)).toBe(false);
  });

  it('retries a temporary claim connection error before giving up', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce({ data: { id: 'claim-id', claimed_by_user_id: 'claimant' }, error: null });

    await expect(claimSharedProjectArea('shared-project-id', 'area-id')).resolves.toMatchObject({
      id: 'claim-id',
      status: 'active',
    });
    expect(rpcMock).toHaveBeenCalledTimes(2);
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

  it('recovers only the exact abandoned claim selected by the owner', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    await expect(releaseAbandonedSharedProjectArea('project-id', 'area-id', 'claim-id')).resolves.toBe(true);
    expect(rpcMock).toHaveBeenCalledWith('release_abandoned_shared_project_area', {
      p_project_id: 'project-id', p_area_id: 'area-id', p_claim_id: 'claim-id',
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

  it('sends release requests one at a time and stops when the database is full', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'me' } }, error: null });
    fromMock.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: ['area-1', 'area-2'].map((areaId) => ({
              id: areaId, project_id: 'shared-project-id', area_id: areaId,
              claimed_by_user_id: 'me', status: 'active', claimed_at: '2026-07-19T12:00:00.000Z',
              expires_at: null, released_at: null, transferred_to_user_id: null,
            })),
            error: null,
          }),
        }),
      }),
    });
    let finishFirst: (() => void) | undefined;
    rpcMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirst = () => resolve({ data: null, error: null });
    }));
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'Too many connections issued to the database' } });

    const pending = releaseAllMySharedProjectAreaClaims('shared-project-id');
    await vi.waitFor(() => expect(rpcMock).toHaveBeenCalledOnce());
    finishFirst?.();
    await expect(pending).rejects.toThrow('Released 1 lock, but 1 still need attention');
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });
});
