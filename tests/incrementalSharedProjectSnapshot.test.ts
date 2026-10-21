import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/types';
import type { SharedProjectAreaSnapshotRow } from '@/lib/collaboration/sharedProjectAreas';

const mocks = vi.hoisted(() => ({ from: vi.fn(), pendingAreas: vi.fn(), pendingMetadata: vi.fn(), metadata: vi.fn(), parseArea: vi.fn() }));
vi.mock('@/lib/collaboration/supabaseClient', () => ({ getCollaborationSupabaseClient: () => ({ from: mocks.from }) }));
vi.mock('@/lib/db', () => ({ getPendingSharedAreaSyncsForProject: mocks.pendingAreas,
  getPendingSharedProjectMetadataSyncForProject: mocks.pendingMetadata }));
vi.mock('@/lib/collaboration/sharedProjectMetadata', async (original) => ({
  ...await original<object>(), getSharedProjectMetadataSnapshot: mocks.metadata,
}));
vi.mock('@/lib/collaboration/sharedProjectAreas', () => ({ parseSharedProjectAreaSnapshot: mocks.parseArea }));
import { getIncrementalSharedProjectSnapshot } from '@/lib/collaboration/incrementalSharedProjectSnapshot';

const baseline = '2026-10-01T00:00:00.000Z';
const accepted = '2026-10-02T00:00:00.000Z';
const newer = '2026-10-03T00:00:00.000Z';
let local: Project;
let rows: SharedProjectAreaSnapshotRow[];
let baselineReads: string[];
let missingTable: boolean;
let payloadError: object | null;
let omitPayload: boolean;
let payloadRequests: string[][];
let selections: string[];

beforeEach(() => {
  vi.resetAllMocks();
  local = { id: 'local', sharedProjectId: 'team', sharedBaselinePublishedAt: new Date(baseline),
    sharedSnapshotPublishedAt: new Date(accepted), projectName: 'Tower', address: '', inspector: '', gcName: '', gcSignoff: '',
    date: new Date(baseline), createdAt: new Date(baseline), updatedAt: new Date(baseline),
    areas: Array.from({ length: 224 }, (_, index) => ({ id: `area-${String(index).padStart(4, '0')}`, projectId: 'local',
      sharedVersion: 2, sharedPublishedAt: new Date(accepted), name: `Unit ${index}`, sortOrder: index, isComplete: false,
      notes: 'Accepted note', locations: [], createdAt: new Date(baseline), updatedAt: new Date(baseline) })),
  };
  rows = local.areas.map((area) => ({ project_id: 'team', area_id: area.id, version: 2,
    published_at: accepted, published_by_user_id: 'member', payload_version: 1,
    area_payload: { ...JSON.parse(JSON.stringify(local)), areas: [JSON.parse(JSON.stringify(area))] } }));
  baselineReads = [baseline]; missingTable = false; payloadError = null; omitPayload = false;
  selections = []; payloadRequests = [];
  mocks.pendingAreas.mockResolvedValue([]);
  mocks.pendingMetadata.mockResolvedValue(undefined);
  mocks.metadata.mockResolvedValue(null);
  mocks.parseArea.mockImplementation(async (row) => ({ area: { ...local.areas.find((area) => area.id === row.area_id),
    id: row.area_id, notes: 'Team update', sharedVersion: row.version, sharedPublishedAt: new Date(row.published_at) }, drawings: [] }));
  mocks.from.mockImplementation((table: string) => {
    const query = {
      select: (columns: string) => { selections.push(`${table}:${columns}`); return query; },
      eq: () => query, gt: () => query, order: () => query,
      maybeSingle: async () => ({ data: { published_at: baselineReads.length > 1 ? baselineReads.shift() : baselineReads[0] }, error: null }),
      range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1).map(({ area_id, version, published_at }) => ({ area_id, version, published_at })),
        error: missingTable ? { code: 'PGRST205' } : null }),
      in: async (_key: string, ids: string[]) => { payloadRequests.push(ids); return { data: omitPayload ? [] : rows.filter((row) => ids.includes(row.area_id)), error: payloadError }; },
    };
    return query;
  });
});

describe('incremental team downloads', () => {
  it('fetches one changed area in a 224-area project without fetching the baseline payload', async () => {
    rows[100] = { ...rows[100], version: 3, published_at: newer };
    const before = structuredClone(local);
    const result = await getIncrementalSharedProjectSnapshot(local);
    expect(payloadRequests).toEqual([['area-0100']]);
    expect(mocks.parseArea).toHaveBeenCalledTimes(1);
    expect(selections.some((selection) => selection.includes('project_payload'))).toBe(false);
    expect(result?.project.areas).toHaveLength(224);
    expect(result?.project.areas[100].notes).toBe('Team update');
    expect(result?.project.areas[99].notes).toBe('Accepted note');
    expect(result?.publishedAt).toBe(newer);
    expect(local).toEqual(before);
  });

  it('uses timestamp equivalence across Postgres and JavaScript date formats', async () => {
    baselineReads = ['2026-10-01T00:00:00+00:00'];
    rows.forEach((row) => { row.published_at = '2026-10-02T00:00:00+00:00'; });
    expect(await getIncrementalSharedProjectSnapshot(local)).not.toBeNull();
    expect(payloadRequests).toEqual([]);
  });

  it('applies incoming metadata rules without mutating the source used for merge review', async () => {
    local.areas[0].areaTypeKey = 'apartment_unit';
    const before = structuredClone(local);
    mocks.metadata.mockResolvedValue({ project_id: 'team', version: 2, payload_version: 1,
      published_at: newer, metadata_payload: { projectName: 'Updated tower', address: '', date: baseline,
        inspector: '', gcName: '', gcSignoff: '', facadeLevelStart: null, facadeLevelEnd: null } });
    const result = await getIncrementalSharedProjectSnapshot(local);
    expect(result?.project.projectName).toBe('Updated tower');
    expect(result?.project.areas[0].locations.some((location) => location.name === 'Closets')).toBe(true);
    expect(local).toEqual(before);
    expect(payloadRequests).toEqual([]);
  });

  it.each(['area queue', 'metadata queue', 'local area edit', 'local metadata edit', 'legacy baseline', 'archived copy'])(
    'falls back to full conflict-safe loading for %s', async (reason) => {
      if (reason === 'area queue') mocks.pendingAreas.mockResolvedValue([{ areaId: local.areas[0].id }]);
      if (reason === 'metadata queue') mocks.pendingMetadata.mockResolvedValue({ revision: 1 });
      if (reason === 'local area edit') local.areas[0].updatedAt = new Date(newer);
      if (reason === 'local metadata edit') local.updatedAt = new Date(newer);
      if (reason === 'legacy baseline') delete local.sharedBaselinePublishedAt;
      if (reason === 'archived copy') local.deletedAt = new Date(newer);
      expect(await getIncrementalSharedProjectSnapshot(local)).toBeNull();
      expect(payloadRequests).toEqual([]);
    });

  it('detects an older missing revision even after this device sent a newer area', async () => {
    local.sharedSnapshotPublishedAt = new Date(newer);
    local.areas[0].sharedVersion = 1;
    local.areas[0].sharedPublishedAt = new Date(baseline);
    rows[1].published_at = newer;
    local.areas[1].sharedPublishedAt = new Date(newer);
    const result = await getIncrementalSharedProjectSnapshot(local);
    expect(payloadRequests).toEqual([['area-0000']]);
    expect(result?.project.areas[0].sharedVersion).toBe(2);
  });

  it('falls back if the baseline changes before or during a pull', async () => {
    baselineReads = [newer];
    expect(await getIncrementalSharedProjectSnapshot(local)).toBeNull();
    baselineReads = [baseline, newer];
    expect(await getIncrementalSharedProjectSnapshot(local)).toBeNull();
  });

  it('does not certify missing or rolled-back area rows as current', async () => {
    rows.pop();
    expect(await getIncrementalSharedProjectSnapshot(local)).toBeNull();
    rows = rows.concat({ ...rows[0], area_id: local.areas.at(-1)!.id, version: 1 });
    expect(await getIncrementalSharedProjectSnapshot(local)).toBeNull();
  });

  it('paginates revision lists and bounds payload batches for projects over the API row limit', async () => {
    const template = rows[0];
    rows = Array.from({ length: 1101 }, (_, index) => ({ ...template, area_id: `new-${String(index).padStart(4, '0')}` }));
    local.areas = [];
    const result = await getIncrementalSharedProjectSnapshot(local);
    expect(result?.project.areas).toHaveLength(1101);
    expect(payloadRequests).toHaveLength(23);
    expect(payloadRequests.every((batch) => batch.length <= 50)).toBe(true);
  });

  it('falls back if a requested payload disappears during download', async () => {
    rows[0].version = 3; omitPayload = true;
    expect(await getIncrementalSharedProjectSnapshot(local)).toBeNull();
  });

  it('propagates permission and media-integrity failures without applying a partial project', async () => {
    rows[0].version = 3;
    payloadError = { code: '42501', message: 'Permission denied' };
    await expect(getIncrementalSharedProjectSnapshot(local)).rejects.toEqual(payloadError);
    payloadError = null;
    mocks.parseArea.mockRejectedValue(new Error('Shared attachment content failed verification'));
    await expect(getIncrementalSharedProjectSnapshot(local)).rejects.toThrow('failed verification');
    expect(local.areas[0].notes).toBe('Accepted note');
  });

  it('falls back for an older server missing area snapshots', async () => {
    missingTable = true;
    expect(await getIncrementalSharedProjectSnapshot(local)).toBeNull();
  });
});
