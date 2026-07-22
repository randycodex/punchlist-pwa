import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({ rpc: rpcMock }),
}));

import {
  SharedProjectAreaConflictError,
  publishSharedProjectAreaSnapshot,
} from '@/lib/collaboration/sharedProjectAreas';

const timestamp = new Date('2026-07-17T12:00:00.000Z');

function project(): Project {
  return {
    id: 'local-project-1',
    sharedProjectId: 'shared-project-1',
    sharedSnapshotPublishedAt: timestamp,
    sharedBaselinePublishedAt: timestamp,
    projectName: 'Area sync project',
    address: '',
    date: timestamp,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas: [{
      id: 'area-1',
      projectId: 'local-project-1',
      sharedVersion: 4,
      sharedPublishedAt: timestamp,
      name: 'Apartment 1A',
      sortOrder: 0,
      isComplete: false,
      notes: 'Changed locally',
      locations: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }, {
      id: 'area-2',
      projectId: 'local-project-1',
      name: 'Apartment 1B',
      sortOrder: 1,
      isComplete: false,
      notes: '',
      locations: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('shared project area publishing', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('publishes only the selected area with an optimistic revision and idempotency key', async () => {
    rpcMock.mockResolvedValue({
      data: [{ area_version: 5, published_at: '2026-07-17T12:01:00.000Z' }],
      error: null,
    });

    const result = await publishSharedProjectAreaSnapshot({
      project: project(),
      areaId: 'area-1',
      baseVersion: 4,
      basePublishedAt: timestamp.toISOString(),
      clientId: 'mutation-1',
      publishedByUserId: 'user-1',
    });

    expect(result).toEqual({
      areaVersion: 5,
      publishedAt: '2026-07-17T12:01:00.000Z',
    });
    expect(rpcMock).toHaveBeenCalledWith(
      'publish_shared_project_area_snapshot',
      expect.objectContaining({
        p_project_id: 'shared-project-1',
        p_area_id: 'area-1',
        p_base_version: 4,
        p_base_published_at: timestamp.toISOString(),
        p_client_id: 'mutation-1',
        p_payload_version: 1,
      })
    );
    const payload = rpcMock.mock.calls[0][1].p_area_payload as { areas: Project['areas'] };
    expect(payload.areas).toHaveLength(1);
    expect(payload.areas[0]).toMatchObject({ id: 'area-1', sharedVersion: 5 });
  });

  it.each(['40001', 'PT409'])('turns stale server revision %s into a dedicated conflict error', async (code) => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code, message: 'Shared area has newer team data.' },
    });

    await expect(publishSharedProjectAreaSnapshot({
      project: project(),
      areaId: 'area-1',
      baseVersion: 4,
      basePublishedAt: timestamp.toISOString(),
      clientId: 'mutation-2',
      publishedByUserId: 'user-1',
    })).rejects.toBeInstanceOf(SharedProjectAreaConflictError);
  });

  it('rejects malformed server revision responses instead of clearing queued work', async () => {
    rpcMock.mockResolvedValue({
      data: [{ area_version: 5, published_at: 'not-a-date' }],
      error: null,
    });

    await expect(publishSharedProjectAreaSnapshot({
      project: project(),
      areaId: 'area-1',
      baseVersion: 4,
      basePublishedAt: timestamp.toISOString(),
      clientId: 'mutation-3',
      publishedByUserId: 'user-1',
    })).rejects.toThrow('without a valid revision');
  });
});
