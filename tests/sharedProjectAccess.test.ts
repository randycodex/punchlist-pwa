import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fromMock,
  getUserMock,
  memberMaybeSingleMock,
  projectIsMock,
  projectMaybeSingleMock,
} = vi.hoisted(() => {
  const projectMaybeSingleMock = vi.fn();
  const memberMaybeSingleMock = vi.fn();
  const projectQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  const memberQuery: Record<string, ReturnType<typeof vi.fn>> = {};

  projectQuery.select = vi.fn(() => projectQuery);
  projectQuery.eq = vi.fn(() => projectQuery);
  projectQuery.is = vi.fn(() => projectQuery);
  projectQuery.maybeSingle = projectMaybeSingleMock;

  memberQuery.select = vi.fn(() => memberQuery);
  memberQuery.eq = vi.fn(() => memberQuery);
  memberQuery.maybeSingle = memberMaybeSingleMock;

  return {
    fromMock: vi.fn((table: string) => table === 'shared_projects' ? projectQuery : memberQuery),
    getUserMock: vi.fn(),
    memberMaybeSingleMock,
    projectIsMock: projectQuery.is,
    projectMaybeSingleMock,
  };
});

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
  }),
}));

import { getSharedProjectAccess } from '@/lib/collaboration/sharedProjects';

describe('shared project access', () => {
  beforeEach(() => {
    fromMock.mockClear();
    getUserMock.mockReset();
    memberMaybeSingleMock.mockReset();
    projectIsMock.mockClear();
    projectMaybeSingleMock.mockReset();

    getUserMock.mockResolvedValue({
      data: { user: { id: 'owner-user-id' } },
      error: null,
    });
    memberMaybeSingleMock.mockResolvedValue({
      data: { access_state: 'active' },
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
    expect(projectIsMock).toHaveBeenCalledWith('archived_at', null);
  });

  it('treats an archived project as inactive even if its old membership row is active', async () => {
    projectMaybeSingleMock.mockResolvedValue({ data: null, error: null });

    await expect(getSharedProjectAccess('archived-project-id')).resolves.toEqual({
      isActiveMember: false,
      isOwner: false,
    });
  });
});
