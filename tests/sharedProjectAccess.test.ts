import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserMock, projectMaybeSingleMock, rpcMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  projectMaybeSingleMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    auth: { getUser: getUserMock },
    rpc: rpcMock,
  }),
}));

import { getSharedProjectAccess } from '@/lib/collaboration/sharedProjects';

describe('shared project access', () => {
  beforeEach(() => {
    getUserMock.mockReset();
    rpcMock.mockReset();

    getUserMock.mockResolvedValue({
      data: { user: { id: 'owner-user-id' } },
      error: null,
    });
    rpcMock.mockResolvedValue({
      data: [
        {
          project_id: 'active-project-id',
          project_name: 'Active project',
          owner_user_id: 'owner-user-id',
          owner_email: 'owner@uai-ny.com',
          joined_at: null,
          published_at: null,
          updated_at: '2026-07-16T12:00:00.000Z',
        },
      ],
      error: null,
    });
  });

  it('reports active owner access only for a non-archived project', async () => {
    projectMaybeSingleMock.mockResolvedValue({
      data: { owner_user_id: 'owner-user-id' },
      error: null,
    });

    await expect(getSharedProjectAccess('active-project-id')).resolves.toEqual({
      isActiveMember: true,
      isOwner: true,
    });
    expect(rpcMock).toHaveBeenCalledWith('list_my_shared_projects');
  });

  it('treats an archived project as inactive even if its old membership row is active', async () => {
    projectMaybeSingleMock.mockResolvedValue({ data: null, error: null });

    await expect(getSharedProjectAccess('archived-project-id')).resolves.toEqual({
      isActiveMember: false,
      isOwner: false,
    });
  });

  it('uses the signed-in user already held by React instead of making another auth request', async () => {
    projectMaybeSingleMock.mockResolvedValue({
      data: { owner_user_id: 'owner-user-id' },
      error: null,
    });

    await expect(getSharedProjectAccess('active-project-id', 'owner-user-id')).resolves.toEqual({
      isActiveMember: true,
      isOwner: true,
    });
    expect(getUserMock).not.toHaveBeenCalled();
  });
});
