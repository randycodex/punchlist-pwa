import { describe, expect, it } from 'vitest';
import {
  buildAreaName,
  getAreaDisplayNameMap,
  getAreaTitle,
  type AreaFormValue,
} from '@/lib/areas';
import { createArea } from '@/lib/db';

const apartmentForm: AreaFormValue = {
  areaTypeKey: 'apartment_unit',
  unitType: 'EFF',
  customAreaName: '',
  areaNumber: '5A',
  facadeLevel: '',
  facadeLevelMode: '',
  elevationDrawingId: '',
  pendingElevationDrawing: null,
};

describe('area titles', () => {
  it('builds apartment names in unit, number, type order', () => {
    expect(buildAreaName(apartmentForm)).toBe('Unit - 5A - EFF');
  });

  it('formats existing apartment records from their saved fields', () => {
    const area = createArea('project-1', 'Apartment / Unit - EFF', 0, {
      areaTypeKey: 'apartment_unit',
      areaNumber: '5A',
      unitType: 'EFF',
    });

    expect(getAreaTitle(area)).toBe('Unit - 5A - EFF');
    expect(getAreaDisplayNameMap([area]).get(area.id)).toBe('Unit - 5A - EFF');
  });

  it('leaves non-apartment titles unchanged', () => {
    const area = createArea('project-1', 'Corridor - 5', 0, {
      areaTypeKey: 'corridor',
      areaNumber: '5',
    });

    expect(getAreaTitle(area)).toBe('Corridor - 5');
  });
});
