import { describe, expect, it } from 'vitest';
import { getNextPendingCheckpoint } from '@/features/inspection/checkpointNavigation';
import type { Area, Checkpoint } from '@/types';

const now = new Date('2026-01-01T00:00:00.000Z');

function checkpoint(id: string, status: Checkpoint['status'] = 'pending'): Checkpoint {
  return {
    id,
    itemId: `item-${id}`,
    name: id,
    status,
    fixStatus: 'pending',
    issueState: status === 'needsReview' ? 'open' : 'none',
    comments: '',
    sortOrder: 0,
    photos: [],
    files: [],
    createdAt: now,
    updatedAt: now,
  };
}

function areaWith(checkpoints: Checkpoint[]): Area {
  return {
    id: 'area-1',
    projectId: 'project-1',
    name: 'Area',
    sortOrder: 0,
    isComplete: false,
    notes: '',
    locations: checkpoints.map((entry, index) => ({
      id: `location-${index}`,
      areaId: 'area-1',
      name: index === checkpoints.length - 1 ? 'Other' : `Room ${index}`,
      sortOrder: index,
      items: [{
        id: entry.itemId,
        locationId: `location-${index}`,
        name: 'Item',
        sortOrder: 0,
        checkpoints: [entry],
        createdAt: now,
        updatedAt: now,
      }],
      createdAt: now,
      updatedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

describe('next pending checkpoint navigation', () => {
  it('skips reviewed checkpoints and excluded locations', () => {
    const area = areaWith([
      checkpoint('reviewed', 'ok'),
      checkpoint('pending'),
      checkpoint('excluded'),
    ]);

    expect(getNextPendingCheckpoint(area, null, { excludedLocationNames: ['Other'] })?.checkpoint.id).toBe('pending');
  });

  it('wraps to the beginning after the current checkpoint', () => {
    const area = areaWith([checkpoint('first'), checkpoint('second', 'ok')]);
    expect(getNextPendingCheckpoint(area, 'second')?.checkpoint.id).toBe('first');
  });

  it('returns null when the inspection is complete', () => {
    const area = areaWith([checkpoint('one', 'ok'), checkpoint('two', 'needsReview')]);
    expect(getNextPendingCheckpoint(area, null)).toBeNull();
  });
});
