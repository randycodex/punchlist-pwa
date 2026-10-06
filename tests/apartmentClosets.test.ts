import { describe, expect, it } from 'vitest';
import { ensureApartmentClosets, isApartmentClosetItem } from '@/lib/apartmentClosets';
import { applyCheckpointRules } from '@/lib/checkpointRules';
import { createArea, createProject, getProject, saveProjectPreserveTimestamps } from '@/lib/db';
import { applyTemplateToArea } from '@/lib/template';
import type { ApartmentUnitType } from '@/lib/areas';

const unitTypes: ApartmentUnitType[] = ['EFF', '0BR', 'Dorm', '1BR', '2BR', '3BR', '4BR'];

function unitProject(unitType: ApartmentUnitType) {
  const project = createProject('Closet test');
  const area = createArea(project.id, 'Unit - 201', 0, { areaTypeKey: 'apartment_unit', unitType });
  applyTemplateToArea(area);
  project.areas.push(area);
  return { project, area };
}

function legacyUnit(unitType: ApartmentUnitType) {
  const result = unitProject(unitType);
  const { area } = result;
  const closets = area.locations.find((room) => room.name === 'Closets')!;
  const entry = area.locations.find((room) => room.name === 'Entry / Foyer')!;
  const corridor = area.locations.find((room) => room.name === 'Corridor');
  for (const item of closets.items) {
    const originalRoom = item.name === 'Closet' && corridor ? corridor : entry;
    item.locationId = originalRoom.id;
    item.sortOrder = originalRoom.items.length;
    originalRoom.items.push(item);
  }
  area.locations = area.locations.filter((room) => room !== closets);
  return result;
}

describe('apartment Closets room', () => {
  it.each(unitTypes)('groups every existing closet template item for %s', (unitType) => {
    const { area } = unitProject(unitType);
    const closets = area.locations.filter((room) => room.name === 'Closets');
    expect(closets).toHaveLength(1);
    expect(closets[0].items.map((item) => item.name)).toEqual([
      'Closet 1 Door', 'Closet 1 Interior', 'Verizon / Cable', 'Closet 2 Door', 'Closet 2 Interior',
      ...(['3BR', '4BR'].includes(unitType) ? ['Closet'] : []),
    ]);
    expect(area.locations.filter((room) => room !== closets[0])
      .flatMap((room) => room.items).filter((item) => isApartmentClosetItem(item.name))).toEqual([]);
  });

  it.each(unitTypes)('moves legacy %s items without replacing any checkpoints', (unitType) => {
    const { project, area } = legacyUnit(unitType);
    const originalItems = area.locations.flatMap((room) => room.items);
    const originalCheckpoints = structuredClone(originalItems.flatMap((item) => item.checkpoints));
    const teammate = structuredClone(project);
    ensureApartmentClosets(project);
    ensureApartmentClosets(teammate);
    expect(project).toEqual(teammate);
    const moved = area.locations.flatMap((room) => room.items);
    expect(moved.map((item) => item.id).sort()).toEqual(originalItems.map((item) => item.id).sort());
    for (const item of moved) {
      expect(item.checkpoints).toEqual(originalCheckpoints.filter((checkpoint) => checkpoint.itemId === item.id));
    }
    const once = structuredClone(project);
    ensureApartmentClosets(project);
    expect(project).toEqual(once);
  });

  it('preserves recorded results, attachments, room review, and old project rules after save/load', async () => {
    const { project, area } = legacyUnit('1BR');
    const entry = area.locations.find((room) => room.name === 'Entry / Foyer')!;
    entry.reviewedAt = '2026-10-06T12:00:00Z';
    const item = entry.items.find((item) => item.name === 'Closet 1 Door')!;
    const checkpoint = item.checkpoints[0];
    Object.assign(checkpoint, { status: 'needsReview', issueState: 'resolved', fixStatus: 'fixed', comments: 'Keep this inspection' });
    checkpoint.photos = [{ id: 'closet-photo', checkpointId: checkpoint.id, imageData: 'data:image/png;base64,YQ==', createdAt: checkpoint.createdAt }];
    checkpoint.files = [{ id: 'closet-file', checkpointId: checkpoint.id, name: 'Closet.txt', mimeType: 'text/plain', size: 1, data: 'data:text/plain;base64,YQ==', createdAt: checkpoint.createdAt }];
    const originalCheckpoint = structuredClone(checkpoint);
    project.checkpointRules = [{ room: 'Entry / Foyer', item: 'Closet 1 Door', name: 'Alignment' }];
    applyCheckpointRules(project);
    const closets = area.locations.find((room) => room.name === 'Closets')!;
    expect(closets.reviewedAt).toBe(entry.reviewedAt);
    expect(item.checkpoints[0]).toEqual(originalCheckpoint);
    expect(item.checkpoints.some((checkpoint) => checkpoint.name === 'Alignment')).toBe(true);
    expect(project.checkpointRules[0].room).toBe('Closets');
    await saveProjectPreserveTimestamps(project);
    const loaded = await getProject(project.id);
    const loadedItem = loaded!.areas[0].locations.find((room) => room.name === 'Closets')!.items.find((entry) => entry.id === item.id)!;
    expect(loadedItem.checkpoints[0]).toEqual(originalCheckpoint);
    expect(loadedItem.checkpoints.filter((entry) => entry.name === 'Alignment')).toHaveLength(1);
  });

  it('keeps non-unit closet items in their original rooms', () => {
    const project = createProject('Lobby');
    const area = createArea(project.id, 'Lobby', 0, { areaTypeKey: 'lobby' });
    applyTemplateToArea(area);
    project.areas.push(area);
    const before = structuredClone(project);
    ensureApartmentClosets(project);
    expect(project).toEqual(before);
  });
});
