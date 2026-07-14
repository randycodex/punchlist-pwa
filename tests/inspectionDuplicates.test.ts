import { describe, expect, it } from 'vitest';
import {
  AREA_TYPE_DEFINITIONS,
  APARTMENT_UNIT_TYPES,
  type ApartmentUnitType,
} from '@/lib/areas';
import { createArea, createCheckpoint, createItem, createLocation } from '@/lib/db';
import { dedupeInspectionHierarchy } from '@/features/inspection/inspectionContent';
import { applyTemplateToArea } from '@/lib/template';

function normalizedNames(values: Array<{ name: string }>) {
  return values.map((value) => value.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase());
}

function expectUniqueNames(values: Array<{ name: string }>) {
  const names = normalizedNames(values);
  expect(new Set(names).size).toBe(names.length);
}

function expectUniqueInspectionHierarchy(area: ReturnType<typeof createArea>) {
  expectUniqueNames(area.locations);
  for (const location of area.locations) {
    expectUniqueNames(location.items);
    for (const item of location.items) {
      expectUniqueNames(item.checkpoints.filter((checkpoint) => !checkpoint.isElevationIssue));
    }
  }
}

describe('inspection hierarchy duplicate prevention', () => {
  it('creates unique standard names for every area template', () => {
    for (const definition of AREA_TYPE_DEFINITIONS) {
      if (definition.key === 'facade') continue;
      const unitTypes: Array<ApartmentUnitType | ''> =
        definition.key === 'apartment_unit' ? APARTMENT_UNIT_TYPES : [''];
      for (const unitType of unitTypes) {
        const area = createArea('project-1', definition.label, 0, {
          areaTypeKey: definition.key,
          unitType,
        });
        applyTemplateToArea(area);
        expectUniqueInspectionHierarchy(area);
      }
    }
  });

  it('deduplicates repeated facade types and shared facade items', () => {
    const area = createArea('project-1', 'Facade - West', 0, {
      areaTypeKey: 'facade',
      unitType: 'West',
      areaNumber: 'Bricks,GFRC,EIFS,GFRC',
      facadeLevel: 'Level 1,Level 2',
    });

    applyTemplateToArea(area);

    expectUniqueInspectionHierarchy(area);
    expect(area.locations).toHaveLength(2);
  });

  it('merges saved duplicate standard records without losing inspection content', () => {
    const area = createArea('project-1', 'Facade', 0, { areaTypeKey: 'facade' });
    const location = createLocation(area.id, 'Level 1', 0);
    const firstItem = createItem(location.id, 'Doors', 0);
    const duplicateItem = createItem(location.id, ' doors ', 1);
    const firstCheckpoint = createCheckpoint(firstItem.id, 'Hardware', 0);
    const duplicateCheckpoint = createCheckpoint(duplicateItem.id, 'hardware', 0);
    const duplicateCheckpointInSameItem = createCheckpoint(firstItem.id, ' HARDWARE ', 1);
    firstCheckpoint.comments = 'First note';
    duplicateCheckpoint.comments = 'Second note';
    duplicateCheckpoint.status = 'needsReview';
    duplicateCheckpoint.issueState = 'open';
    duplicateCheckpoint.photos = [{
      id: 'photo-1',
      checkpointId: duplicateCheckpoint.id,
      imageData: 'image',
      createdAt: new Date(),
    }];
    duplicateCheckpointInSameItem.comments = 'Same item duplicate';
    firstItem.checkpoints = [firstCheckpoint, duplicateCheckpointInSameItem];
    duplicateItem.checkpoints = [duplicateCheckpoint];
    location.items = [firstItem, duplicateItem];
    area.locations = [location];

    expect(dedupeInspectionHierarchy(area)).toBe(true);
    expect(area.locations[0].items).toHaveLength(1);
    const mergedCheckpoint = area.locations[0].items[0].checkpoints[0];
    expect(mergedCheckpoint.comments).toBe('First note\n\nSame item duplicate\n\nSecond note');
    expect(mergedCheckpoint.issueState).toBe('open');
    expect(mergedCheckpoint.photos[0]).toMatchObject({
      id: 'photo-1',
      checkpointId: mergedCheckpoint.id,
    });
  });

  it('leaves same-named custom and elevation records separate', () => {
    const area = createArea('project-1', 'Custom area', 0, { areaTypeKey: 'custom' });
    const location = createLocation(area.id, 'Custom items', 0, { isCustom: true });
    const firstItem = createItem(location.id, 'Door', 0, { isCustom: true });
    const secondItem = createItem(location.id, 'Door', 1, { isCustom: true });
    const elevationItem = createItem(location.id, 'Markers', 2);
    elevationItem.checkpoints = [
      createCheckpoint(elevationItem.id, 'E1', 0, { isElevationIssue: true }),
      createCheckpoint(elevationItem.id, 'E1', 1, { isElevationIssue: true }),
    ];
    location.items = [firstItem, secondItem, elevationItem];
    area.locations = [location];

    expect(dedupeInspectionHierarchy(area)).toBe(false);
    expect(location.items).toHaveLength(3);
    expect(elevationItem.checkpoints).toHaveLength(2);
  });
});
