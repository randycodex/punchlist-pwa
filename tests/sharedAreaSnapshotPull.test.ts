import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types';

const basePublishedAt = '2026-07-17T12:00:00.000Z';
const areaPublishedAt = '2026-07-17T12:05:00.000Z';
const metadataPublishedAt = '2026-07-17T12:06:00.000Z';

function project(areaName: string): Project {
  const timestamp = new Date(basePublishedAt);
  return {
    id: 'remote-project-id',
    sharedProjectId: 'shared-project-1',
    projectName: 'Shared project',
    address: '',
    date: timestamp,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas: [{
      id: 'area-1',
      projectId: 'remote-project-id',
      name: areaName,
      sortOrder: 0,
      isComplete: false,
      notes: areaName,
      locations: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({ from: fromMock }),
}));

import {
  getSharedProjectSnapshot,
  getSharedProjectSnapshotMetadata,
  hasNewerSharedProjectRevisions,
} from '@/lib/collaboration/sharedProjectSnapshots';

describe('area-scoped shared snapshot pulls', () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it('detects an older missing area update even after this browser sent a newer area', async () => {
    const local = project('Local area');
    local.sharedBaselinePublishedAt = new Date(basePublishedAt);
    local.sharedSnapshotPublishedAt = new Date(metadataPublishedAt);
    local.areas[0].sharedVersion = 2;
    fromMock.mockImplementation((table: string) => {
      const query = {
        select: () => query, eq: () => query,
        gt: async () => ({ data: [{ area_id: 'area-1', version: 3 }], error: null }),
        maybeSingle: async () => ({ data: { published_at: basePublishedAt }, error: null }),
      };
      expect(['shared_project_snapshots', 'shared_project_area_snapshots']).toContain(table);
      return query;
    });
    expect(await hasNewerSharedProjectRevisions(local)).toBe(true);
  });

  it.each([
    ['unchanged opening unit', basePublishedAt, 2, 0, false],
    ['newer opening unit', basePublishedAt, 3, 0, true],
    ['newer project baseline', areaPublishedAt, 2, 0, true],
    ['newer project details', basePublishedAt, 2, 1, true],
  ])('checks %s without pulling unrelated unit payloads', async (_, baseline, version, metadataVersion, expected) => {
    const local = project('Opening unit');
    local.sharedBaselinePublishedAt = new Date(basePublishedAt);
    local.areas[0].sharedVersion = 2;
    const areaFilter = vi.fn();
    fromMock.mockImplementation((table: string) => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((key: string, value: string) => {
          if (table === 'shared_project_area_snapshots' && key === 'area_id') areaFilter(value);
          return query;
        }),
        maybeSingle: async () => ({ error: null, data: table === 'shared_project_snapshots'
          ? { published_at: baseline }
          : table === 'shared_project_area_snapshots'
            ? { version, published_at: areaPublishedAt }
            : { version: metadataVersion, published_at: metadataPublishedAt } }),
      };
      return query;
    });
    expect(await hasNewerSharedProjectRevisions(local, 'area-1')).toBe(expected);
    expect(areaFilter).toHaveBeenCalledWith('area-1');
    // Payloads and storage objects are outside this small freshness check.
    expect(fromMock.mock.calls.map(([table]) => table)).toEqual([
      'shared_project_snapshots', 'shared_project_area_snapshots', 'shared_project_metadata_snapshots',
    ]);
  });

  it('starts the opening unit checks together instead of waiting three network round trips', async () => {
    const local = project('Opening unit');
    local.sharedBaselinePublishedAt = new Date(basePublishedAt);
    let resolveBaseline!: (value: unknown) => void;
    const baseline = new Promise((resolve) => { resolveBaseline = resolve; });
    fromMock.mockImplementation((table: string) => {
      const query = { select: () => query, eq: () => query,
        maybeSingle: () => table === 'shared_project_snapshots' ? baseline
          : Promise.resolve({ data: null, error: null }) };
      return query;
    });
    const check = hasNewerSharedProjectRevisions(local, 'area-1');
    expect(fromMock).toHaveBeenCalledTimes(3);
    resolveBaseline({ data: { published_at: basePublishedAt }, error: null });
    expect(await check).toBe(false);
  });

  it('does not treat a failed opening unit check as fresh', async () => {
    const local = project('Opening unit');
    local.sharedBaselinePublishedAt = new Date(basePublishedAt);
    const error = { message: 'Failed to fetch' };
    fromMock.mockImplementation((table: string) => {
      const query = { select: () => query, eq: () => query,
        maybeSingle: async () => table === 'shared_project_area_snapshots'
          ? { data: null, error } : { data: { published_at: basePublishedAt }, error: null } };
      return query;
    });
    await expect(hasNewerSharedProjectRevisions(local, 'area-1')).rejects.toEqual(error);
  });

  it('overlays only area rows newer than the full baseline', async () => {
    const baselineQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    baselineQuery.select = vi.fn(() => baselineQuery);
    baselineQuery.eq = vi.fn(() => baselineQuery);
    baselineQuery.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        project_payload: JSON.parse(JSON.stringify(project('Baseline area'))),
        payload_version: 1,
        published_at: basePublishedAt,
      },
      error: null,
    });

    const areaQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    areaQuery.select = vi.fn(() => areaQuery);
    areaQuery.eq = vi.fn(() => areaQuery);
    areaQuery.gt = vi.fn(() => areaQuery);
    areaQuery.order = vi.fn().mockResolvedValue({
      data: [{
        project_id: 'shared-project-1',
        area_id: 'area-1',
        area_payload: JSON.parse(JSON.stringify(project('Updated area'))),
        payload_version: 1,
        version: 3,
        published_by_user_id: 'user-2',
        published_at: areaPublishedAt,
      }],
      error: null,
    });

    const metadataQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    metadataQuery.select = vi.fn(() => metadataQuery);
    metadataQuery.eq = vi.fn(() => metadataQuery);
    metadataQuery.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        project_id: 'shared-project-1',
        metadata_payload: {
          projectName: 'Updated project details',
          address: '123 Team Street',
          date: basePublishedAt,
          inspector: 'Inspector Two',
          gcName: 'Team GC',
          gcSignoff: '',
          facadeLevelStart: 2,
          facadeLevelEnd: 12,
        },
        payload_version: 1,
        version: 4,
        published_by_user_id: 'user-2',
        published_at: metadataPublishedAt,
      },
      error: null,
    });

    fromMock.mockImplementation((table: string) => {
      if (table === 'shared_project_snapshots') return baselineQuery;
      if (table === 'shared_project_metadata_snapshots') return metadataQuery;
      return areaQuery;
    });
    const localProject = project('Local area');
    localProject.id = 'local-project-id';

    const result = await getSharedProjectSnapshot(localProject);

    expect(areaQuery.gt).toHaveBeenCalledWith('published_at', basePublishedAt);
    expect(result.publishedAt).toBe(metadataPublishedAt);
    expect(result.project).toMatchObject({
      id: 'local-project-id',
      sharedBaselinePublishedAt: new Date(basePublishedAt),
      sharedSnapshotPublishedAt: new Date(metadataPublishedAt),
      sharedMetadataVersion: 4,
      sharedMetadataPublishedAt: new Date(metadataPublishedAt),
      projectName: 'Updated project details',
      address: '123 Team Street',
    });
    expect(result.project.areas[0]).toMatchObject({
      projectId: 'local-project-id',
      name: 'Updated area',
      sharedVersion: 3,
      sharedPublishedAt: new Date(areaPublishedAt),
    });
  });

  it('uses the newest area timestamp as the project freshness marker', async () => {
    const baselineQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    baselineQuery.select = vi.fn(() => baselineQuery);
    baselineQuery.eq = vi.fn(() => baselineQuery);
    baselineQuery.maybeSingle = vi.fn().mockResolvedValue({
      data: { published_at: basePublishedAt },
      error: null,
    });

    const areaQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    areaQuery.select = vi.fn(() => areaQuery);
    areaQuery.eq = vi.fn(() => areaQuery);
    areaQuery.order = vi.fn(() => areaQuery);
    areaQuery.limit = vi.fn(() => areaQuery);
    areaQuery.maybeSingle = vi.fn().mockResolvedValue({
      data: { published_at: areaPublishedAt },
      error: null,
    });
    const metadataQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    metadataQuery.select = vi.fn(() => metadataQuery);
    metadataQuery.eq = vi.fn(() => metadataQuery);
    metadataQuery.maybeSingle = vi.fn().mockResolvedValue({
      data: { published_at: metadataPublishedAt },
      error: null,
    });
    fromMock.mockImplementation((table: string) => {
      if (table === 'shared_project_snapshots') return baselineQuery;
      if (table === 'shared_project_metadata_snapshots') return metadataQuery;
      return areaQuery;
    });

    await expect(getSharedProjectSnapshotMetadata('shared-project-1')).resolves.toEqual({
      publishedAt: metadataPublishedAt,
    });
  });

  it('falls back to the full baseline while an older deployment lacks the area table', async () => {
    const baselineQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    baselineQuery.select = vi.fn(() => baselineQuery);
    baselineQuery.eq = vi.fn(() => baselineQuery);
    baselineQuery.maybeSingle = vi.fn().mockResolvedValue({
      data: { published_at: basePublishedAt },
      error: null,
    });

    const areaQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    areaQuery.select = vi.fn(() => areaQuery);
    areaQuery.eq = vi.fn(() => areaQuery);
    areaQuery.order = vi.fn(() => areaQuery);
    areaQuery.limit = vi.fn(() => areaQuery);
    areaQuery.maybeSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '42P01', message: 'relation shared_project_area_snapshots does not exist' },
    });
    fromMock.mockImplementation((table: string) => (
      table === 'shared_project_snapshots' ? baselineQuery : areaQuery
    ));

    await expect(getSharedProjectSnapshotMetadata('shared-project-1')).resolves.toEqual({
      publishedAt: basePublishedAt,
    });
  });
});
