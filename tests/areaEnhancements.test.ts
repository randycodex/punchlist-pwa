import { describe, expect, it } from 'vitest';
import { createArea } from '@/lib/db';
import { getAreaGroupKey } from '@/lib/areas';
import { applyTemplateToArea } from '@/lib/template';
import { getAreaStats } from '@/types';
import { getNextListSortOption } from '@/components/ListSortMenu';

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

  it('reverses every sort group when its selected button is tapped again', () => {
    expect(getNextListSortOption('issues', 'issues')).toBe('issues-reverse');
    expect(getNextListSortOption('issues-reverse', 'issues')).toBe('issues');
    expect(getNextListSortOption('alphabetical', 'alphabetical')).toBe('alphabetical-reverse');
    expect(getNextListSortOption('alphabetical-reverse', 'alphabetical')).toBe('alphabetical');
    expect(getNextListSortOption('progress', 'progress')).toBe('progress-reverse');
    expect(getNextListSortOption('progress-reverse', 'progress')).toBe('progress');
    expect(getNextListSortOption('date-newest', 'date')).toBe('date-oldest');
    expect(getNextListSortOption('date-oldest', 'date')).toBe('date-newest');
  });
});
