import { expect, it } from 'vitest';
import { createArea, createCheckpoint, createItem, createLocation, createPhotoAttachment, createProject } from '@/lib/db';
import { areasChangedSinceTeamCopy, areasWithMissingMedia, mergeDuplicateTeamProjects } from '@/features/projects/mergeDuplicateTeamProjects';

it('combines unique photos and checkpoints while keeping the team project identity', () => {
  const primary = createProject('Team project');
  primary.sharedProjectId = 'team-id';
  const area = createArea(primary.id, 'Unit 1', 0);
  const location = createLocation(area.id, 'Kitchen', 0);
  const item = createItem(location.id, 'Walls', 0);
  const checkpoint = createCheckpoint(item.id, 'Paint', 0);
  checkpoint.updatedAt = new Date('2026-01-01');
  checkpoint.photos.push(createPhotoAttachment(checkpoint.id, 'primary-photo'));
  item.checkpoints.push(checkpoint);
  location.items.push(item);
  area.locations.push(location);
  primary.areas.push(area);

  const duplicate = structuredClone(primary);
  duplicate.id = 'duplicate-copy';
  duplicate.areas[0].projectId = duplicate.id;
  const duplicateCheckpoint = duplicate.areas[0].locations[0].items[0].checkpoints[0];
  duplicateCheckpoint.comments = 'Newer site note';
  duplicateCheckpoint.updatedAt = new Date('2026-01-02');
  duplicateCheckpoint.photos = [createPhotoAttachment(checkpoint.id, 'duplicate-photo')];
  duplicate.areas[0].locations[0].items[0].checkpoints.push(
    createCheckpoint(item.id, 'Second finish', 1)
  );

  const merged = mergeDuplicateTeamProjects(primary, [duplicate]);
  const checkpoints = merged.areas[0].locations[0].items[0].checkpoints;
  expect(merged.id).toBe(primary.id);
  expect(merged.sharedProjectId).toBe('team-id');
  expect(merged.areas[0].projectId).toBe(primary.id);
  expect(checkpoints).toHaveLength(2);
  expect(checkpoints[0].comments).toBe('Newer site note');
  expect(checkpoints[0].photos.map((photo) => photo.imageData)).toEqual(['duplicate-photo', 'primary-photo']);
  expect(areasChangedSinceTeamCopy(primary, merged)).toEqual([area.id]);
  expect(areasChangedSinceTeamCopy(primary, structuredClone(primary))).toEqual([]);
  expect(areasWithMissingMedia(merged, [area.id])).toEqual([]);
  checkpoints[0].photos[0].imageData = '';
  expect(areasWithMissingMedia(merged, [area.id])).toEqual([area.id]);
});
