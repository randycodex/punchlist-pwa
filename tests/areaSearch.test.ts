import { describe, expect, it } from 'vitest';
import { createArea } from '@/lib/db';
import { matchesAreaSearch } from '@/features/projects/areaSearch';

describe('area search', () => {
  it('finds a unit by number and ordinal floor name', () => {
    const area = createArea('project-1', 'Unit - 3Z - 0BR', 0, {
      areaTypeKey: 'apartment_unit', areaNumber: '3Z',
    });
    area.unitFloor = '3';
    expect(matchesAreaSearch(area, area.name, '3Z')).toBe(true);
    expect(matchesAreaSearch(area, area.name, '3rd Floor')).toBe(true);
    expect(matchesAreaSearch(area, area.name, 'Floor 4')).toBe(false);
  });

  it('finds non-unit areas by their assigned floor', () => {
    const area = createArea('project-1', 'East Corridor', 0);
    area.unitFloor = 'Roof';
    expect(matchesAreaSearch(area, area.name, 'Roof')).toBe(true);
    expect(matchesAreaSearch(area, area.name, 'corridor')).toBe(true);
  });
});
