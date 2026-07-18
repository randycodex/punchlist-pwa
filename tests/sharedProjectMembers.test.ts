import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fromMock,
  memberNeqMock,
  memberOrderMock,
  projectMaybeSingleMock,
  rpcMock,
} = vi.hoisted(() => {
  const projectMaybeSingleMock = vi.fn();
  const memberNeqMock = vi.fn();
  const memberOrderMock = vi.fn();
  const projectQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  const memberQuery: Record<string, ReturnType<typeof vi.fn>> = {};

  projectQuery.select = vi.fn(() => projectQuery);
  projectQuery.eq = vi.fn(() => projectQuery);
  projectQuery.maybeSingle = projectMaybeSingleMock;

  memberQuery.select = vi.fn(() => memberQuery);
  memberQuery.eq = vi.fn(() => memberQuery);
  memberQuery.neq = memberNeqMock.mockImplementation(() => memberQuery);
  memberQuery.order = memberOrderMock;

  return {
    fromMock: vi.fn((table: string) => table === 'shared_projects' ? projectQuery : memberQuery),
    memberNeqMock,
    memberOrderMock,
    projectMaybeSingleMock,
    rpcMock: vi.fn(),
  };
});

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({ from: fromMock, rpc: rpcMock }),
}));

import { getSharedProjectMembers, removeSharedProjectMember } from '@/lib/collaboration/sharedProjects';

describe('shared project member list', () => {
  beforeEach(() => {
    fromMock.mockClear();
    memberNeqMock.mockClear();
    memberOrderMock.mockReset();
    projectMaybeSingleMock.mockReset();
    rpcMock.mockReset();
  });

  it('shows current members without rendering removed membership history', async () => {
    projectMaybeSingleMock.mockResolvedValue({
      data: { owner_user_id: 'owner-user-id' },
      error: null,
    });
    memberOrderMock.mockResolvedValue({
      data: [{
        project_id: 'shared-project-id',
        user_id: 'owner-user-id',
        email: 'owner@uai-ny.com',
        display_name: 'Project Owner',
        access_state: 'active',
        joined_by: 'joinCode',
        invited_by_user_id: null,
        invited_at: '2026-07-15T16:00:00.000Z',
        joined_at: '2026-07-15T16:00:00.000Z',
        removed_at: null,
      }],
      error: null,
    });

    const members = await getSharedProjectMembers('shared-project-id');

    expect(memberNeqMock).toHaveBeenCalledWith('access_state', 'removed');
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      email: 'owner@uai-ny.com',
      displayName: 'Project Owner',
      accessState: 'active',
      isOwner: true,
    });
  });

  it('removes a member through the owner-only RPC and reports invite invalidation', async () => {
    rpcMock.mockResolvedValue({
      data: {
        project_id: 'shared-project-id',
        member_email: 'member@uai-ny.com',
        invite_invalidated: true,
      },
      error: null,
    });

    await expect(removeSharedProjectMember(
      'shared-project-id',
      ' Member@UAI-NY.com '
    )).resolves.toEqual({
      projectId: 'shared-project-id',
      memberEmail: 'member@uai-ny.com',
      inviteInvalidated: true,
    });
    expect(rpcMock).toHaveBeenCalledWith('remove_shared_project_member', {
      p_project_id: 'shared-project-id',
      p_member_email: 'member@uai-ny.com',
    });
  });
});
