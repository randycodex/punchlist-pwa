import { describe, expect, it } from 'vitest';
import { createArea } from '@/lib/db';
import { compareAreaNames, getAreaGroupKey } from '@/lib/areas';
import { applyTemplateToArea } from '@/lib/template';
import { getAreaStats } from '@/types';
import { getNextListSortOption } from '@/components/ListSortMenu';
import { getSortForAreaViewMode } from '@/features/projects/areaListView';

describe('area list and checklist enhancements', () => {
  it('groups units, facades, and all remaining area types', () => {
    expect(getAreaGroupKey(createArea('project-1', 'Unit 1A', 0, { areaTypeKey: 'apartment_unit' }))).toBe('units');
    expect(getAreaGroupKey(createArea('project-1', 'North Facade', 1, { areaTypeKey: 'facade' }))).toBe('facades');
    expect(getAreaGroupKey(createArea('project-1', 'Lobby', 2, { areaTypeKey: 'lobby' }))).toBe('others');
  });

  it('counts a non-empty general note as an issue', () => {
    const area = createArea('project-1', 'Unit 1A', 0, { areaTypeKey: 'apartment_unit' });
    area.notes = 'Repair the damaged wall finish.';

    expect(getAreaStats(area)).toEqual({ total: 1, ok: 0, issues: 1 });
  });

  it('adds Wall to bedrooms and Ceiling to kitchens', () => {
    const area = createArea('project-1', 'Unit 1A', 0, {
      areaTypeKey: 'apartment_unit',
      unitType: '1BR',
    });
    applyTemplateToArea(area);

    const bedroom = area.locations.find((location) => location.name === 'Bedroom');
    const kitchen = area.locations.find((location) => location.name === 'Kitchen');

    expect(bedroom?.items.some((item) => item.name === 'Wall')).toBe(true);
    expect(kitchen?.items.some((item) => item.name === 'Ceiling')).toBe(true);
  });

  it('uses the efficiency checklist for 0BR units', () => {
    const efficiency = createArea('project-1', 'Unit - 1A - EFF', 0, {
      areaTypeKey: 'apartment_unit',
      unitType: 'EFF',
    });
    const zeroBedroom = createArea('project-1', 'Unit - 1B - 0BR', 1, {
      areaTypeKey: 'apartment_unit',
      unitType: '0BR',
    });

    applyTemplateToArea(efficiency);
    applyTemplateToArea(zeroBedroom);

    expect(zeroBedroom.locations.map((location) => location.name)).toEqual(
      efficiency.locations.map((location) => location.name)
    );
    expect(zeroBedroom.locations.some((location) => location.name === 'Living/Bedroom')).toBe(true);
  });

  it('uses the efficiency layout without a bathroom or kitchen for Dorm units', () => {
    const area = createArea('project-1', 'Unit - D1 - Dorm', 0, {
      areaTypeKey: 'apartment_unit',
      unitType: 'Dorm',
    });

    applyTemplateToArea(area);

    expect(area.locations.map((location) => location.name)).toEqual([
      'Entry / Foyer',
      'Living/Bedroom',
    ]);
  });

  it('adds Bedroom 4 to 4BR units', () => {
    const area = createArea('project-1', 'Unit - 1A - 4BR', 0, {
      areaTypeKey: 'apartment_unit',
      unitType: '4BR',
    });

    applyTemplateToArea(area);

    expect(area.locations.filter((location) => /^Bedroom \d+$/.test(location.name)).map((location) => location.name)).toEqual([
      'Bedroom 1',
      'Bedroom 2',
      'Bedroom 3',
      'Bedroom 4',
    ]);
  });

  it('reverses every sort group when its selected button is tapped again', () => {
    expect(getNextListSortOption('issues', 'issues')).toBe('issues-reverse');
    expect(getNextListSortOption('issues-reverse', 'issues')).toBe('issues');
    expect(getNextListSortOption('alphabetical', 'alphabetical')).toBe('alphabetical-reverse');
    expect(getNextListSortOption('alphabetical-reverse', 'alphabetical')).toBe('alphabetical');
    expect(getNextListSortOption('date-newest', 'date')).toBe('date-oldest');
    expect(getNextListSortOption('date-oldest', 'date')).toBe('date-newest');
  });

  it('defaults the flat area view to creation order and remembers each view sort', () => {
    expect(getSortForAreaViewMode('all', null, null, 'issues')).toBe('date-oldest');
    expect(getSortForAreaViewMode('all', 'issues', 'alphabetical-reverse', 'issues')).toBe('alphabetical-reverse');
    expect(getSortForAreaViewMode('grouped', 'issues-reverse', 'date-oldest', 'alphabetical')).toBe('issues-reverse');
    expect(getSortForAreaViewMode('grouped', null, 'date-oldest', 'alphabetical')).toBe('alphabetical');
  });

  it('sorts grouped units by their displayed unit number', () => {
    const units = [
      { areaNumber: '14A', unitType: '2BR' as const },
      { areaNumber: '14G', unitType: '3BR' as const },
      { areaNumber: '14B', unitType: '3BR' as const },
      { areaNumber: '14D', unitType: '3BR' as const },
      { areaNumber: '14H', unitType: 'EFF' as const },
    ].map((unit, index) => createArea('project-1', `Apartment / Unit - ${unit.unitType}`, index, {
      areaTypeKey: 'apartment_unit',
      areaNumber: unit.areaNumber,
      unitType: unit.unitType,
    }));

    expect(units.sort(compareAreaNames).map((area) => area.areaNumber)).toEqual([
      '14A',
      '14B',
      '14D',
      '14G',
      '14H',
    ]);
  });
});
