import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fromMock,
  memberNeqMock,
  memberOrderMock,
  projectMaybeSingleMock,
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
  };
});

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({ from: fromMock }),
}));

import { getSharedProjectMembers } from '@/lib/collaboration/sharedProjects';

describe('shared project member list', () => {
  beforeEach(() => {
    fromMock.mockClear();
    memberNeqMock.mockClear();
    memberOrderMock.mockReset();
    projectMaybeSingleMock.mockReset();
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
});
