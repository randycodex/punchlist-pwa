import { describe, expect, it } from 'vitest';
import { getInspectionAreaMetrics } from '@/features/inspection/inspectionMetrics';
import type { Area, Checkpoint } from '@/types';

const now = new Date('2026-01-01T00:00:00.000Z');

function checkpoint(id: string, overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id,
    itemId: 'item-1',
    name: id,
    status: 'pending',
    fixStatus: 'pending',
    issueState: 'none',
    comments: '',
    sortOrder: 0,
    photos: [],
    files: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function location(checkpoints: Checkpoint[]): Area['locations'][number] {
  return {
    id: 'location-1',
    areaId: 'area-1',
    name: 'Living Room',
    sortOrder: 0,
    items: [
      {
        id: 'item-1',
        locationId: 'location-1',
        name: 'Finishes',
        sortOrder: 0,
        checkpoints,
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

describe('inspection metrics', () => {
  it('computes area, location, and item totals in one consistent pass', () => {
    const metrics = getInspectionAreaMetrics([
      location([
        checkpoint('ok', { status: 'ok', comments: 'Checked' }),
        checkpoint('issue', { status: 'needsReview', issueState: 'open' }),
        checkpoint('pending'),
      ]),
    ]);

    expect(metrics.stats).toEqual({ total: 3, ok: 1, issues: 1 });
    expect(metrics.pending).toBe(1);
    expect(metrics.reviewedPercent).toBeCloseTo(66.67, 2);
    expect(metrics.locationMetrics.get('location-1')).toMatchObject({
      pending: 1,
      commentCount: 1,
    });
    expect(metrics.locationMetrics.get('location-1')?.progress).toBeCloseTo(66.67, 2);
    expect(metrics.itemMetrics.get('item-1')).toMatchObject({
      stats: { total: 3, ok: 1, issues: 1 },
      pending: 1,
      commentCount: 1,
    });
  });

  it('returns stable zero percentages for an empty inspection', () => {
    const metrics = getInspectionAreaMetrics([]);
    expect(metrics.stats).toEqual({ total: 0, ok: 0, issues: 0 });
    expect(metrics.pending).toBe(0);
    expect(metrics.reviewedPercent).toBe(0);
  });
});
