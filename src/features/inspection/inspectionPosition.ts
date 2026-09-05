import type { Area } from '@/types';
import { compareLevelNames } from '@/lib/areas';
import { readLocalStorage, writeLocalStorage } from '@/lib/browserStorage';

export type InspectionPosition = { areaId: string; locationId: string; itemId?: string; checkpointId?: string };
export const positionKey = (projectId: string) => `punchlist:inspection-position:v1:${projectId}`;

export function readInspectionPosition(projectId: string): InspectionPosition | null {
  try {
    const value = JSON.parse(readLocalStorage(positionKey(projectId)) ?? 'null');
    return value && typeof value.areaId === 'string' && typeof value.locationId === 'string' ? value : null;
  } catch { return null; }
}

export function rememberInspectionPosition(projectId: string, position: InspectionPosition) {
  writeLocalStorage(positionKey(projectId), JSON.stringify(position));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('punchlist-inspection-position'));
}

export function nextInspectionPosition(area: Area, position: InspectionPosition | null, step: 'item' | 'room'): InspectionPosition | null {
  const hasSections = area.locations.some((location) => location.sectionLabel);
  const locations = [...area.locations].sort((a, b) => (hasSections ? 0 : compareLevelNames(a.name, b.name)) || a.sortOrder - b.sortOrder);
  if (step === 'room') {
    const next = locations[locations.findIndex((entry) => entry.id === position?.locationId) + 1];
    return next ? { areaId: area.id, locationId: next.id } : null;
  }
  const items = locations.flatMap((location) => [...location.items].sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => ({ areaId: area.id, locationId: location.id, itemId: item.id })));
  if (!position?.itemId) return items.find((entry) => entry.locationId === position?.locationId) ?? items[0] ?? null;
  return items[items.findIndex((entry) => entry.itemId === position.itemId) + 1] ?? null;
}
