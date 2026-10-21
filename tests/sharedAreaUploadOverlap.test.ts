import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadArea: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  complete: vi.fn(),
  discard: vi.fn(),
  getPending: vi.fn(),
  recordFailure: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/features/sync/loadAreaWithRecoveredMedia', () => ({
  loadAreaWithRecoveredMedia: mocks.loadArea,
}));
vi.mock('@/lib/collaboration/sharedProjectAreas', async () => {
  const actual = await vi.importActual<typeof import('@/lib/collaboration/sharedProjectAreas')>(
    '@/lib/collaboration/sharedProjectAreas'
  );
  return {
    ...actual,
    prepareSharedProjectAreaSnapshot: mocks.prepare,
    commitSharedProjectAreaSnapshot: mocks.commit,
    SHARED_AREA_PREPARE_CONCURRENCY: 3,
  };
});
vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    getPendingSharedAreaSyncs: mocks.getPending,
    completePendingSharedAreaSync: mocks.complete,
    discardPendingSharedAreaSync: mocks.discard,
    recordPendingSharedAreaSyncFailure: mocks.recordFailure,
  };
});
vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    auth: { getSession: mocks.getSession },
  }),
}));

import { flushPendingSharedAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';
import type { Project } from '@/types';

const timestamp = new Date('2026-07-17T12:00:00.000Z');

function projectWithAreas(areaIds: string[]): Project {
  return {
    id: 'local-1',
    sharedProjectId: 'shared-1',
    sharedSnapshotPublishedAt: timestamp,
    projectName: 'Overlap',
    address: '',
    date: timestamp,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas: areaIds.map((id, index) => ({
      id,
      projectId: 'local-1',
      name: id,
      sortOrder: index,
      isComplete: false,
      notes: '',
      locations: [],
      sharedVersion: 1,
      sharedPublishedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('shared area upload overlap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } }, error: null });
    mocks.complete.mockResolvedValue({ stillPending: false });
    mocks.recordFailure.mockResolvedValue(undefined);
  });

  it('overlaps preparation across areas while committing the same project sequentially', async () => {
    const project = projectWithAreas(['a', 'b', 'c']);
    const records = project.areas.map((area, index) => ({
      key: `k-${area.id}`,
      localProjectId: project.id,
      sharedProjectId: 'shared-1',
      areaId: area.id,
      baseVersion: 1,
      basePublishedAt: timestamp.toISOString(),
      clientId: `c-${area.id}`,
      revision: index + 1,
      attemptCount: 0,
      blockedByConflict: false,
      lastError: null,
      lastErrorCode: null,
      queuedAt: timestamp,
    }));
    mocks.getPending.mockResolvedValue(records);
    mocks.loadArea.mockImplementation(async (_projectId: string, areaId: string) => ({
      ...project,
      areas: project.areas.filter((area) => area.id === areaId),
    }));

    let activePrep = 0;
    let peakPrep = 0;
    const prepOrder: string[] = [];
    const commitOrder: string[] = [];
    let activeCommit = 0;
    let peakCommit = 0;
    const gates = new Map<string, () => void>();

    mocks.prepare.mockImplementation(async (input: { areaId: string }) => {
      prepOrder.push(input.areaId);
      activePrep += 1;
      peakPrep = Math.max(peakPrep, activePrep);
      await new Promise<void>((resolve) => { gates.set(input.areaId, resolve); });
      activePrep -= 1;
      return {
        sharedProjectId: 'shared-1',
        areaId: input.areaId,
        baseVersion: 1,
        basePublishedAt: timestamp.toISOString(),
        clientId: `c-${input.areaId}`,
        payload: { areaId: input.areaId },
        payloadVersion: 2,
      };
    });
    mocks.commit.mockImplementation(async (prepared: { areaId: string }) => {
      commitOrder.push(prepared.areaId);
      activeCommit += 1;
      peakCommit = Math.max(peakCommit, activeCommit);
      await new Promise((r) => setTimeout(r, 5));
      activeCommit -= 1;
      return { areaVersion: 2, publishedAt: timestamp.toISOString() };
    });

    const flush = flushPendingSharedAreaSyncs(project.id);
    await vi.waitFor(() => expect(prepOrder.length).toBe(3));
    expect(peakPrep).toBeGreaterThan(1);
    gates.get('a')?.();
    gates.get('b')?.();
    gates.get('c')?.();
    await expect(flush).resolves.toEqual({ synced: 3, pending: 0, conflicted: 0 });
    expect(commitOrder).toEqual(['a', 'b', 'c']);
    expect(peakCommit).toBe(1);
  });

  it('keeps unsent work when a later commit fails after overlapped preparation', async () => {
    const project = projectWithAreas(['a', 'b']);
    const records = project.areas.map((area, index) => ({
      key: `k-${area.id}`,
      localProjectId: project.id,
      sharedProjectId: 'shared-1',
      areaId: area.id,
      baseVersion: 1,
      basePublishedAt: timestamp.toISOString(),
      clientId: `c-${area.id}`,
      revision: index + 1,
      attemptCount: 0,
      blockedByConflict: false,
      lastError: null,
      lastErrorCode: null,
      queuedAt: timestamp,
    }));
    mocks.getPending.mockResolvedValue(records);
    mocks.loadArea.mockResolvedValue(project);
    mocks.prepare.mockImplementation(async (input: { areaId: string }) => ({
      sharedProjectId: 'shared-1',
      areaId: input.areaId,
      baseVersion: 1,
      basePublishedAt: timestamp.toISOString(),
      clientId: `c-${input.areaId}`,
      payload: {},
      payloadVersion: 2,
    }));
    mocks.commit
      .mockResolvedValueOnce({ areaVersion: 2, publishedAt: timestamp.toISOString() })
      .mockRejectedValueOnce(new Error('The project is syncing another change. Retry shortly.'));

    await expect(flushPendingSharedAreaSyncs(project.id)).resolves.toEqual({
      synced: 1,
      pending: 1,
      conflicted: 0,
    });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.recordFailure).toHaveBeenCalledTimes(1);
    expect(mocks.recordFailure.mock.calls[0][0]).toBe('k-b');
  });
});
