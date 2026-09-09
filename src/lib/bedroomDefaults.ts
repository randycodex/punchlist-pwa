import { v5 as uuidv5 } from 'uuid';
import { isApartmentArea } from '@/lib/areas';
import type { Project } from '@/types';

// Deterministic defaults keep independently loaded team copies consistent.
export function ensureBedroomCeilings(project: Project): void {
  for (const area of project.areas) {
    if (area.deletedAt || !isApartmentArea(area)) continue;
    for (const room of area.locations) {
      if (!/^(?:(?:(?:primary|master)\s+)?bedroom(?:\s*\d+)?|living(?:\s*\/\s*bedroom)?)$/i.test(room.name.trim())) continue;
      if (room.items.some((item) => item.name.trim().toLowerCase() === 'ceiling')) continue;
      const id = uuidv5(`${room.id}:default-bedroom-ceiling`, uuidv5.URL);
      room.items.push({
        id, locationId: room.id, name: 'Ceiling', isCustom: false,
        sortOrder: Math.max(-1, ...room.items.map((item) => item.sortOrder)) + 1,
        createdAt: project.createdAt, updatedAt: project.createdAt,
        checkpoints: ['Paint', 'Clean'].map((name, sortOrder) => ({
          id: uuidv5(`${id}:${name.toLowerCase()}`, uuidv5.URL), itemId: id,
          name, sortOrder, isCustom: false, status: 'pending', issueState: 'none',
          fixStatus: 'pending', comments: '', photos: [], files: [],
          createdAt: project.createdAt, updatedAt: project.createdAt,
        })),
      });
      area.isComplete = false;
    }
  }
}
