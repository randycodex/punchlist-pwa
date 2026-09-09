import type { Area, Project } from '@/types';

export type UnitFloorNumbering = 'prefix' | 'last-two-digits' | 'manual';

export function parseUnitFloorNumbering(value: unknown): UnitFloorNumbering | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'prefix' || value === 'last-two-digits' || value === 'manual') return value;
  throw new Error('Invalid unit floor numbering convention.');
}

export function getUnitFloor(area: Pick<Area, 'areaNumber' | 'name' | 'unitFloor'>, convention: Project['unitFloorNumbering'] = 'prefix'): string | null {
  if (area.unitFloor?.trim()) return area.unitFloor.trim();
  const number = (area.areaNumber || area.name.match(/^Unit\s*-\s*(.+?)\s*-\s*(?:EFF|[0-4]BR|Dorm)$/i)?.[1] || '').trim();
  if (convention === 'manual') return null;
  const match = convention === 'last-two-digits'
    ? number.match(/^(\d+)\d{2}$/)
    : number.match(/^(\d+)\s*-?\s*[a-z][a-z0-9-]*$/i);
  const floor = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(floor) ? String(floor) : null;
}

export function groupUnitsByFloor(areas: Area[], convention?: UnitFloorNumbering) {
  const floors = new Map<string | null, Area[]>();
  for (const area of areas) {
    const floor = getUnitFloor(area, convention);
    floors.set(floor, [...floors.get(floor) ?? [], area]);
  }
  return [...floors.entries()].sort(([a], [b]) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b, undefined, { numeric: true });
  }).map(([floor, units]) => ({ floor, units }));
}
