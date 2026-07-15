import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types';

const { fromMock, getUserMock, rpcMock } = vi.hoisted(() => ({
  fromMock: vi.fn(() => {
    throw new Error('Shared project creation must not query for a stale client-side match.');
  }),
  getUserMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
    rpc: rpcMock,
  }),
}));

import { createSharedProjectFromLocalProject } from '@/lib/collaboration/sharedProjects';

const baseline = new Date('2026-07-15T16:00:00.000Z');

function localProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'local-project-1',
    projectName: 'Archived project to share again',
    address: '',
    date: baseline,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas: [],
    createdAt: baseline,
    updatedAt: baseline,
    ...overrides,
  };
}

describe('shared project creation', () => {
  beforeEach(() => {
    fromMock.mockClear();
    getUserMock.mockReset();
    rpcMock.mockReset();
  });

  it('always lets the server choose or create the active shared project', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { email: 'owner@uai-ny.com' } },
      error: null,
    });
    rpcMock.mockResolvedValue({ data: 'new-active-shared-project', error: null });

    await expect(createSharedProjectFromLocalProject(
      localProject(),
      'owner@uai-ny.com',
      'Project Owner'
    )).resolves.toBe('new-active-shared-project');

    expect(fromMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith('create_shared_project', {
      p_local_project_id: 'local-project-1',
      p_project_name: 'Archived project to share again',
      p_owner_email: 'owner@uai-ny.com',
      p_owner_display_name: 'Project Owner',
    });
  });

  it('keeps an already-linked local project without creating another record', async () => {
    await expect(createSharedProjectFromLocalProject(
      localProject({ sharedProjectId: 'existing-active-shared-project' }),
      'owner@uai-ny.com'
    )).resolves.toBe('existing-active-shared-project');

    expect(getUserMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
