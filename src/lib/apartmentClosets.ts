import { v5 as uuidv5 } from 'uuid';
import { isApartmentArea } from '@/lib/areas';
import type { Project } from '@/types';

export function isApartmentClosetItem(name: string): boolean {
  return /^closet(?:\s+\d+)?(?:\s+(?:door|interior))?$/i.test(name.trim())
    || /^verizon\s*\/\s*cable$/i.test(name.trim());
}

// Move the original items rather than rebuilding their checkpoints. Stable room
// IDs keep independently loaded team copies consistent without resetting results.
export function ensureApartmentClosets(project: Project): void {
  for (const area of project.areas) {
    if (area.deletedAt || !isApartmentArea(area)) continue;
    let closets = area.locations.find((room) => room.name.trim().toLowerCase() === 'closets');
    const sourceRooms = area.locations.filter((room) => room !== closets
      && room.items.some((item) => isApartmentClosetItem(item.name)));

    if (!closets) {
      closets = {
        id: uuidv5(`${area.id}:apartment-closets`, uuidv5.URL),
        areaId: area.id,
        name: 'Closets',
        sortOrder: 0,
        items: [],
        createdAt: area.createdAt,
        updatedAt: area.createdAt,
      };
      if (sourceRooms.length && sourceRooms.every((room) => room.reviewedAt)) {
        closets.reviewedAt = sourceRooms.map((room) => room.reviewedAt!).sort()[0];
      }
      const entryIndex = area.locations.findIndex((room) => /^entry\s*\/\s*foyer$/i.test(room.name.trim()));
      area.locations.splice(entryIndex < 0 ? area.locations.length : entryIndex + 1, 0, closets);
      area.locations.forEach((room, index) => { room.sortOrder = index; });
    }

    for (const room of sourceRooms) {
      for (const item of room.items.filter((entry) => isApartmentClosetItem(entry.name))) {
        item.locationId = closets.id;
        item.sortOrder = closets.items.length;
        closets.items.push(item);
      }
      room.items = room.items.filter((item) => !isApartmentClosetItem(item.name));
      room.items.forEach((item, index) => { item.sortOrder = index; });
    }
  }
}
