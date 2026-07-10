import { describe, expect, it } from 'vitest';
import {
  checkpointHasFacadeListContent,
  checkpointHasStoredMedia,
  facadeAreaNeedsTemplateRefresh,
  locationHasRecordedActivity,
} from '@/features/inspection/inspectionContent';
import type { Area, Checkpoint } from '@/types';

const now = new Date('2026-01-01T00:00:00.000Z');

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'checkpoint-1',
    itemId: 'item-1',
    name: 'Doors',
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

function areaWithCheckpoints(checkpoints: Checkpoint[], itemNames = ['Doors']): Area {
  return {
    id: 'area-1',
    projectId: 'project-1',
    name: 'Facade',
    areaTypeKey: 'facade',
    sortOrder: 0,
    isComplete: false,
    notes: '',
    locations: [
      {
        id: 'location-1',
        areaId: 'area-1',
        name: 'Level 1',
        sortOrder: 0,
        items: itemNames.map((name, index) => ({
          id: `item-${index}`,
          locationId: 'location-1',
          name,
          sortOrder: index,
          checkpoints: index === 0 ? checkpoints : [],
          createdAt: now,
          updatedAt: now,
        })),
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

describe('inspection content classification', () => {
  it('detects user activity and stored media independently', () => {
    const pendingArea = areaWithCheckpoints([checkpoint()]);
    expect(locationHasRecordedActivity(pendingArea.locations[0])).toBe(false);
    expect(checkpointHasStoredMedia(pendingArea.locations[0].items[0].checkpoints[0])).toBe(false);

    const commented = checkpoint({ comments: 'Needs review' });
    expect(locationHasRecordedActivity(areaWithCheckpoints([commented]).locations[0])).toBe(true);

    const withPhoto = checkpoint({ photos: [{ id: 'photo-1' } as Checkpoint['photos'][number]] });
    expect(checkpointHasStoredMedia(withPhoto)).toBe(true);
  });

  it('only includes elevation issues for the active drawing', () => {
    const issue = checkpoint({
      status: 'needsReview',
      issueState: 'open',
      isElevationIssue: true,
      elevationMarker: { drawingId: 'drawing-a', xPercent: 50, yPercent: 50 },
    });
    expect(checkpointHasFacadeListContent(issue, 'drawing-a')).toBe(true);
    expect(checkpointHasFacadeListContent(issue, 'drawing-b')).toBe(false);
  });

  it('flags facades that are missing required template items', () => {
    expect(facadeAreaNeedsTemplateRefresh(areaWithCheckpoints([checkpoint()]))).toBe(true);
    expect(
      facadeAreaNeedsTemplateRefresh(
        areaWithCheckpoints([checkpoint()], [
          'Doors',
          'Storefront',
          'Planting',
          'Light Fixture',
          'Security Camera',
          'Fence',
          'Signage',
          'Canopy',
          'Louvers',
        ])
      )
    ).toBe(false);
  });
});
