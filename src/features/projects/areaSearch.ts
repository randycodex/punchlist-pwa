import type { Area, Project } from '@/types';
import { getAreaFloor, normalizeFloorLabel } from '@/lib/unitFloors';

export function matchesAreaSearch(
  area: Area,
  displayName: string,
  search: string,
  convention?: Project['unitFloorNumbering']
): boolean {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  const floor = getAreaFloor(area, convention);
  const text = [displayName, area.name, area.areaNumber, area.unitFloor, floor && `Floor ${floor}`]
    .filter(Boolean).join(' ').toLocaleLowerCase();
  if (text.includes(query)) return true;
  const normalizedFloor = normalizeFloorLabel(query);
  return Boolean(
    floor && normalizedFloor === floor &&
    /(?:floor|level|roof|\b\d+(?:st|nd|rd|th)\b)/i.test(query)
  );
}
