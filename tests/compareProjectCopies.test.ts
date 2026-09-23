import { describe, expect, it } from 'vitest';
import { compareProjectCopies, isLikelyPersonalProjectCopy } from '../src/features/projects/compareProjectCopies';
import { mergeDuplicatePersonalProjects } from '../src/features/projects/mergeDuplicateTeamProjects';
import type { Checkpoint, Project } from '../src/types';

function project(id: string, checkpoints: Checkpoint[]): Project {
  return {
    id,
    projectName: 'Ilse Hoffman House - K&J (Kwassi)',
    address: '1760 Jerome Ave',
    sharedProjectId: 'shared-one',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
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
  it('recognizes personal copies by shared saved IDs, not their name alone', () => {
    const first = project('first', [checkpoint('same-checkpoint', [])]);
    const second = project('second', [checkpoint('same-checkpoint', [])]);
    delete first.sharedProjectId;
    delete second.sharedProjectId;
    expect(isLikelyPersonalProjectCopy(first, second)).toBe(true);
    expect(isLikelyPersonalProjectCopy(first, { ...second, address: 'Another address' })).toBe(false);
    expect(isLikelyPersonalProjectCopy(first, { ...second, areas: [] })).toBe(false);
  });

  it('keeps unique personal work and photo files under the retained project ID', () => {
    const first = project('first', [checkpoint('shared', [{ id: 'photo-one', imageData: 'data:first' }])]);
    const second = project('second', [
      checkpoint('shared', [{ id: 'photo-one', imageData: '' }], 'Later note'),
      checkpoint('unique', [{ id: 'photo-two', imageData: 'data:second' }]),
    ]);
    delete first.sharedProjectId;
    delete second.sharedProjectId;
    first.areas[0].locations[0].items[0].checkpoints[0].updatedAt = new Date('2025-01-01');
    second.areas[0].updatedAt = new Date('2027-02-01');
    second.areas[0].locations[0].items[0].checkpoints[0].updatedAt = new Date('2027-02-01');

    const merged = mergeDuplicatePersonalProjects(first, [first, second]);
    expect(merged.id).toBe(first.id);
    expect(merged.areas[0].projectId).toBe(first.id);
    expect(merged.areas[0].locations[0].items[0].checkpoints).toHaveLength(2);
    expect(merged.areas[0].locations[0].items[0].checkpoints.find((checkpoint) => checkpoint.id === 'shared')?.comments).toBe('Later note');
    expect(compareProjectCopies(first, merged).firstOnlyPhotoDataIds).toEqual([]);
    expect(compareProjectCopies(second, merged).firstOnlyPhotoDataIds).toEqual([]);
  });

  it('keeps a complete personal facade copy when an older copy has fewer selected levels', () => {
    const first = project('first', [checkpoint('shared', [])]);
    const second = project('second', [checkpoint('shared', [])]);
    delete first.sharedProjectId;
    delete second.sharedProjectId;
    first.areas[0].areaTypeKey = 'facade';
    second.areas[0].areaTypeKey = 'facade';
    first.areas[0].facadeLevel = 'Floor 1, Floor 2';
    second.areas[0].facadeLevel = 'Floor 1';
    first.areas[0].locations.push({
      ...first.areas[0].locations[0], id: 'floor-two', name: 'Floor 2', sortOrder: 1,
      items: [{
        ...first.areas[0].locations[0].items[0], id: 'floor-two-item', locationId: 'floor-two',
        checkpoints: [checkpoint('floor-two-checkpoint', [])],
      }],
    });
    second.areas[0].updatedAt = new Date('2027-01-01');
    second.updatedAt = new Date('2027-01-01');

    const merged = mergeDuplicatePersonalProjects(first, [first, second]);
    expect(compareProjectCopies(first, merged).firstOnlyCheckpointIds).toEqual([]);
    expect(merged.areas[0].locations.map((location) => location.name)).toContain('Floor 2');
  });

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
    expect(comparison.secondOnlyPhotoDataIds).toEqual(['old-photo', 'new-photo']);
    expect(comparison.differingCheckpointIds).toEqual(['shared']);
    expect(comparison.firstPhotosWithoutData).toBe(1);
    expect(comparison.secondPhotosWithoutData).toBe(0);
  });
});
