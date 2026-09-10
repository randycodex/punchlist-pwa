import { describe, expect, it } from 'vitest';
import { createArea } from '@/lib/db';
import { comparePdfAreas } from '@/lib/pdfAreaOrder';

describe('PDF area order', () => {
  it('orders shuffled units by numeric floor and then letter, regardless of unit type', () => {
    const areas = ['10a', '1h', '2a', '1c', '1a', '1g', '1f'].map((areaNumber, index) => ({
      ...createArea('p', `Unit - ${areaNumber} - ${index % 2 ? '1BR' : '2BR'}`, index),
      areaNumber,
    }));
    expect(areas.sort(comparePdfAreas).map((area) => area.areaNumber)).toEqual([
      '1a', '1c', '1f', '1g', '1h', '2a', '10a',
    ]);
  });

  it('honors assigned floors before alphabetical area names and puts unknown floors last', () => {
    const areas = [
      { ...createArea('p', 'Storage', 0), unitFloor: '10' },
      createArea('p', 'Lobby', 1),
      { ...createArea('p', 'Storage', 2), unitFloor: '2' },
      { ...createArea('p', 'Corridor', 3), unitFloor: '2' },
    ];
    expect(areas.sort(comparePdfAreas).map((area) => [area.unitFloor, area.name])).toEqual([
      ['2', 'Corridor'], ['2', 'Storage'], ['10', 'Storage'], [undefined, 'Lobby'],
    ]);
  });
});
