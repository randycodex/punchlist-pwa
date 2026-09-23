import type { Area, Project } from '@/types';
import { isApartmentArea } from '@/lib/areas';

export type UnitFloorNumbering = 'prefix' | 'last-two-digits' | 'manual';

export function parseUnitFloorNumbering(value: unknown): UnitFloorNumbering | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'prefix' || value === 'last-two-digits' || value === 'manual') return value;
  throw new Error('Invalid unit floor numbering convention.');
}

export function getUnitFloor(area: Pick<Area, 'areaNumber' | 'name' | 'unitFloor'>, convention: Project['unitFloorNumbering'] = 'prefix'): string | null {
  if (area.unitFloor?.trim()) return normalizeFloorLabel(area.unitFloor) ?? null;
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

export function normalizeFloorLabel(value?: string): string | undefined {
  const floor = value?.trim();
  if (!floor) return undefined;
  if (/^roof$/i.test(floor)) return 'Roof';
  const number = floor.match(/^(?:floor|level)\s*(-?\d+)$/i)
    ?? floor.match(/^(-?\d+)(?:st|nd|rd|th)?(?:\s+(?:floor|level))?$/i);
  return number ? String(Number(number[1])) : floor;
}

export function getAreaFloor(area: Area, convention?: UnitFloorNumbering): string | null {
  const assignedFloor = normalizeFloorLabel(area.unitFloor);
  if (assignedFloor) return assignedFloor;
  if (isApartmentArea(area)) return getUnitFloor(area, convention);
  const numberOrLabel = area.areaNumber?.trim() ?? '';
  return /^(?:(?:floor|level)\s*-?\d+|-?\d+(?:st|nd|rd|th)\s+(?:floor|level))$/i.test(numberOrLabel)
    ? normalizeFloorLabel(numberOrLabel) ?? null
    : null;
}

export function hasProjectFloorLevels(project?: Pick<Project, 'facadeLevelStart' | 'facadeLevelEnd'> | null): boolean {
  const { facadeLevelStart: start, facadeLevelEnd: end } = project ?? {};
  return typeof start === 'number' && Number.isInteger(start)
    && typeof end === 'number' && Number.isInteger(end);
}

export function getProjectFloorLevels(project?: Pick<Project, 'facadeLevelStart' | 'facadeLevelEnd'> | null): string[] {
  if (!hasProjectFloorLevels(project)) return [];
  const levels: string[] = [];
  const start = Math.min(project!.facadeLevelStart!, project!.facadeLevelEnd!);
  const end = Math.max(project!.facadeLevelStart!, project!.facadeLevelEnd!);
  for (let level = start; level <= end; level += 1) {
    if (level !== 0) levels.push(String(level));
  }
  return [...levels, 'Roof'];
}

export function groupAreasByFloor(
  areas: Area[],
  convention?: UnitFloorNumbering,
  project?: Pick<Project, 'facadeLevelStart' | 'facadeLevelEnd'> | null
): Array<{ floor: string | null; areas: Area[] }> {
  const floors = new Map<string | null, Area[]>();
  for (const floor of getProjectFloorLevels(project)) floors.set(floor, []);
  for (const area of areas) {
    const floor = getAreaFloor(area, convention);
    floors.set(floor, [...floors.get(floor) ?? [], area]);
  }
  return [...floors.entries()].sort(([a], [b]) => {
    if (a === null) return 1;
    if (b === null) return -1;
    if (a === 'Roof') return 1;
    if (b === 'Roof') return -1;
    return a.localeCompare(b, undefined, { numeric: true });
  }).map(([floor, floorAreas]) => ({ floor, areas: floorAreas }));
}

export function hasFloorGroupedAreas(areas: Area[]): boolean {
  return areas.some((area) => isApartmentArea(area) || getAreaFloor(area) !== null);
}
