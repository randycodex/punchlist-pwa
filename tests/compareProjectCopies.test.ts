import { describe, expect, it } from 'vitest';
import { compareProjectCopies } from '../src/features/projects/compareProjectCopies';
import type { Checkpoint, Project } from '../src/types';

function project(id: string, checkpoints: Checkpoint[]): Project {
  return {
    id,
    sharedProjectId: 'shared-one',
    areas: [{
      id: 'area-one', projectId: id, name: 'Area', sortOrder: 0,
      isComplete: false, notes: '', createdAt: new Date(), updatedAt: new Date(),
      locations: [{
        id: 'location-one', areaId: 'area-one', name: 'Room', sortOrder: 0,
        createdAt: new Date(), updatedAt: new Date(),
        items: [{
          id: 'item-one', locationId: 'location-one', name: 'Item', sortOrder: 0,
          createdAt: new Date(), updatedAt: new Date(), checkpoints,
        }],
      }],
    }],
  } as Project;
}

function checkpoint(id: string, photos: Array<{ id: string; imageData: string }>, comments = ''): Checkpoint {
  return {
    id, itemId: 'item-one', name: id, status: 'needsReview', fixStatus: 'pending',
    comments, sortOrder: 0, files: [], createdAt: new Date(), updatedAt: new Date(),
    photos: photos.map((photo) => ({ ...photo, checkpointId: id, createdAt: new Date() })),
  };
}

describe('compareProjectCopies', () => {
  it('finds unique checkpoint and photo IDs and missing local photo files', () => {
    const first = project('first', [checkpoint('shared', [{ id: 'old-photo', imageData: '' }])]);
    const second = project('second', [
      checkpoint('shared', [{ id: 'old-photo', imageData: 'data:photo' }, { id: 'new-photo', imageData: 'data:new' }], 'New comment'),
      checkpoint('new-checkpoint', []),
    ]);

    const comparison = compareProjectCopies(first, second);
    expect(comparison.sameTeamProject).toBe(true);
    expect(comparison.firstOnlyCheckpointIds).toEqual([]);
    expect(comparison.secondOnlyCheckpointIds).toEqual(['new-checkpoint']);
    expect(comparison.secondOnlyPhotoIds).toEqual(['new-photo']);
    expect(comparison.differingCheckpointIds).toEqual(['shared']);
    expect(comparison.firstPhotosWithoutData).toBe(1);
    expect(comparison.secondPhotosWithoutData).toBe(0);
  });
});
