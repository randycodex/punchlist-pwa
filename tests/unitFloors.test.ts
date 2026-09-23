import { readFileSync } from 'node:fs';
import { parseBulkApartmentSchedule } from '@/lib/apartmentSchedule';
import { describe, expect, it } from 'vitest';
import { getAreaFloor, getProjectFloorLevels, getUnitFloor, groupAreasByFloor, groupUnitsByFloor, normalizeFloorLabel, parseUnitFloorNumbering } from '@/lib/unitFloors';
import { createArea, createProject } from '@/lib/db';
import { createSharedProjectMetadataPayload, applySharedProjectMetadataSnapshot } from '@/lib/collaboration/sharedProjectMetadata';
import { parseProjectPayload } from '@/lib/projectPayload';

describe('unit floors', () => {
  it('recognizes every floor in the supplied 175-unit schedule', () => {
    const schedule = parseBulkApartmentSchedule(readFileSync(new URL('./fixtures/apartment-schedule.csv', import.meta.url), 'utf8'));
    expect(schedule.units).toHaveLength(175);
    const floors = schedule.units.map((unit) => getUnitFloor({ name:'', areaNumber:unit.areaNumber }));
    expect(floors.every((floor) => floor !== null)).toBe(true);
    expect([...new Set(floors)].sort((a,b) => Number(a)-Number(b))).toEqual(Array.from({length:14},(_,i) => String(i+1)));
  });
  it('recognizes lettered and hyphenated units without guessing numeric conventions', () => {
    for (const [number, expected] of [['14A','14'],['14-A','14'],['03B','3'],['1-BR','1'],['1401',null],['PH-A',null],['G1',null]] as const) {
      expect(getUnitFloor({ name:'', areaNumber:number })).toBe(expected);
    }
  });
  it('uses the explicit numeric convention and manual overrides', () => {
    expect(getUnitFloor({name:'', areaNumber:'1401'}, 'last-two-digits')).toBe('14');
    expect(getUnitFloor({name:'', areaNumber:'301'}, 'last-two-digits')).toBe('3');
    expect(getUnitFloor({name:'', areaNumber:'14A'}, 'manual')).toBe(null);
    expect(getUnitFloor({name:'', areaNumber:'PH-A', unitFloor:' Penthouse '})).toBe('Penthouse');
    expect(getUnitFloor({name:'Unit - 14A - 2BR'})).toBe('14');
  });
  it('orders floors numerically and keeps unknown units', () => {
    const units = ['14A','2B','PH-A','2-A'].map((number,index) => ({...createArea('p',number,index), areaNumber:number}));
    const groups = groupUnitsByFloor(units);
    expect(groups.map((g) => g.floor)).toEqual(['2','14',null]);
    expect(groups[0].units.map((a) => a.areaNumber)).toEqual(['2B','2-A']);
  });
  it('places non-unit areas on an explicit floor and keeps an empty Roof above the selected levels', () => {
    const project = createProject('Tower');
    project.facadeLevelStart = 1;
    project.facadeLevelEnd = 3;
    const corridor = createArea(project.id, 'Corridor', 0, { areaTypeKey: 'corridor' });
    corridor.unitFloor = '3rd Floor';
    const unit = createArea(project.id, 'Unit - 3A - 1BR', 1, { areaTypeKey: 'apartment_unit', areaNumber: '3A' });

    expect(normalizeFloorLabel('3rd Floor')).toBe('3');
    expect(normalizeFloorLabel('Floor 3')).toBe('3');
    expect(getAreaFloor(corridor)).toBe('3');
    expect(getProjectFloorLevels(project)).toEqual(['1', '2', '3', 'Roof']);
    const groups = groupAreasByFloor([corridor, unit], project.unitFloorNumbering, project);
    expect(groups.map(({ floor }) => floor)).toEqual(['1', '2', '3', 'Roof']);
    expect(groups[2].areas.map(({ id }) => id)).toEqual([corridor.id, unit.id]);
    expect(groups[3].areas).toEqual([]);

    const labeledCorridor = createArea(project.id, 'Corridor 3rd Floor', 2, { areaTypeKey: 'corridor', areaNumber: '3rd Floor' });
    expect(getAreaFloor(labeledCorridor)).toBe('3');
    expect(groupAreasByFloor([labeledCorridor], project.unitFloorNumbering, project)[2].areas[0].id).toBe(labeledCorridor.id);
  });
  it('places Roof after a reversed project level range and skips level zero', () => {
    const project = createProject('Tower');
    project.facadeLevelStart = 2;
    project.facadeLevelEnd = -1;
    expect(getProjectFloorLevels(project)).toEqual(['-1', '1', '2', 'Roof']);
  });
  it('preserves settings and overrides in shared metadata and backups', () => {
    const project = createProject('Floors'); project.unitFloorNumbering = 'last-two-digits';
    project.areas.push({...createArea(project.id,'Unit - PH-A - 2BR',0), unitFloor:'PH'});
    const parsed = parseProjectPayload(JSON.parse(JSON.stringify(project)));
    expect(parsed.areas[0].unitFloor).toBe('PH');
    expect(parsed.unitFloorNumbering).toBe('last-two-digits');
    const shared = applySharedProjectMetadataSnapshot(createProject('Other'), {
      project_id:'shared', metadata_payload:createSharedProjectMetadataPayload(project), payload_version:1, version:1,
      published_by_user_id:'member', published_at:new Date().toISOString(),
    });
    expect(shared.unitFloorNumbering).toBe('last-two-digits');
    expect(() => parseUnitFloorNumbering('guess')).toThrow();
  });
});
