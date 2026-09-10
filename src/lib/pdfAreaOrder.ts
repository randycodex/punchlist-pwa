import type { Area, Project } from '@/types';
import { compareAreaNames } from '@/lib/areas';
import { getUnitFloor } from '@/lib/unitFloors';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function comparePdfAreas(a: Area, b: Area, convention?: Project['unitFloorNumbering']): number {
  const floor = (area: Area) => getUnitFloor(area, convention)
    ?? area.facadeLevel?.trim()
    ?? getUnitFloor({ name: '', areaNumber: area.name }, convention);
  const floorA = floor(a);
  const floorB = floor(b);
  if (floorA !== floorB) {
    if (floorA == null) return 1;
    if (floorB == null) return -1;
    const order = collator.compare(floorA.replace(/^Level\s*/i, ''), floorB.replace(/^Level\s*/i, ''));
    if (order !== 0) return order;
  }
  return collator.compare(a.areaNumber?.trim() || a.name, b.areaNumber?.trim() || b.name)
    || compareAreaNames(a, b);
}
