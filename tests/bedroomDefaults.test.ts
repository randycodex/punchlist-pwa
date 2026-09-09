import { describe, expect, it } from 'vitest';
import { createProject, createArea, createLocation, getProject, saveProjectPreserveTimestamps } from '@/lib/db';
import { applyTemplateToArea } from '@/lib/template';
import { applyCheckpointRules } from '@/lib/checkpointRules';

describe('bedroom ceiling defaults', () => {
  it.each(['EFF', '1BR', '2BR'] as const)('includes living ceiling defaults for %s units', (unitType) => {
    const area = createArea('project', '14A', 0, { areaTypeKey: 'apartment_unit' });
    area.unitType = unitType;
    applyTemplateToArea(area);
    const room = area.locations.find((entry) => entry.name === (unitType === 'EFF' ? 'Living/Bedroom' : 'Living'))!;
    expect(room).toBeDefined();
    expect(room.items.filter((item) => item.name === 'Ceiling')).toHaveLength(1);
    expect(room.items.find((item) => item.name === 'Ceiling')?.checkpoints.map((c) => c.name)).toEqual(['Paint', 'Clean']);
  });
  it('includes ceiling with Paint and Clean in new bedroom templates', () => {
    const area = createArea('project', '14A', 0, { areaTypeKey: 'apartment_unit' });
    applyTemplateToArea(area);
    const bedrooms = area.locations.filter((room) => room.name.startsWith('Bedroom'));
    expect(bedrooms.length).toBeGreaterThan(0);
    for (const room of bedrooms) {
      expect(room.items.find((item) => item.name === 'Ceiling')?.checkpoints.map((c) => c.name)).toEqual(['Paint', 'Clean']);
    }
  });
  it('fills existing bedrooms deterministically without duplicating or resetting results', async () => {
    const project = createProject('Existing');
    const area = createArea(project.id, '14A', 0, { areaTypeKey: 'apartment_unit' });
    area.locations = ['Bedroom', 'Bedroom 2', 'Kitchen', 'Living', 'Living/Bedroom'].map((name, index) => createLocation(area.id, name, index));
    project.areas.push(area);
    const teammate = structuredClone(project);
    applyCheckpointRules(project); applyCheckpointRules(teammate);
    expect(project).toEqual(teammate);
    expect(area.locations[2].items).toEqual([]);
    for (const room of area.locations.slice(3)) {
      expect(room.items.map((item) => item.name)).toEqual(['Ceiling']);
      expect(room.items[0].checkpoints.map((c) => c.issueState)).toEqual(['none', 'none']);
    }
    const ceiling = area.locations[0].items[0];
    expect(ceiling.checkpoints.map((c) => c.issueState)).toEqual(['none', 'none']);
    ceiling.checkpoints[0].comments = 'Keep me';
    ceiling.checkpoints[0].status = 'ok';
    applyCheckpointRules(project);
    expect(area.locations[0].items).toHaveLength(1);
    await saveProjectPreserveTimestamps(project);
    const saved = await getProject(project.id);
    expect(saved?.areas[0].locations[0].items[0].checkpoints[0]).toMatchObject({ comments: 'Keep me', status: 'ok' });
  });
});
