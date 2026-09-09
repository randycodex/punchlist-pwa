import { ensureBedroomCeilings } from '@/lib/bedroomDefaults';
import { isApartmentArea } from '@/lib/areas';
import { v5 as uuidv5 } from 'uuid';
import type { Project } from '@/types';

export type CheckpointRule = { room: string; item: string; name: string };
const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

export function parseCheckpointRules(value: unknown): CheckpointRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('Use no more than 100 project checkpoint rules.');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid checkpoint rule.');
    const record = entry as Record<string, unknown>;
    const values = ['room', 'item', 'name'].map((key) => {
      const text = record[key];
      if (typeof text !== 'string' || !text.trim() || text.length > 200) throw new Error('Checkpoint rule names must be 1–200 characters.');
      return text.trim();
    });
    return { room: values[0], item: values[1], name: values[2] };
  });
}

// Rules are additive schema, not edits to another inspector's checkpoint results.
// Stable IDs let independently synced teammates materialize the same checkpoint.
export function applyCheckpointRules(project: Project): Project {
  ensureBedroomCeilings(project);
  for (const area of project.areas) {
    if (area.deletedAt || !isApartmentArea(area)) continue;
    for (const rule of project.checkpointRules ?? []) {
      for (const location of area.locations.filter((entry) => normalize(entry.name) === normalize(rule.room))) {
        for (const item of location.items.filter((entry) => normalize(entry.name) === normalize(rule.item))) {
          if (item.checkpoints.some((entry) => normalize(entry.name) === normalize(rule.name))) continue;
          item.checkpoints.push({
            id: uuidv5(`${item.id}:${normalize(rule.name)}`, uuidv5.URL),
            itemId: item.id, name: rule.name, isCustom: true,
            status: 'needsReview', fixStatus: 'pending', issueState: 'open', comments: '',
            sortOrder: item.checkpoints.length, photos: [], files: [],
            createdAt: project.createdAt, updatedAt: project.createdAt,
          });
          area.isComplete = false;
        }
      }
    }
  }
  return project;
}

export function mergeCheckpointRules(...sets: Array<CheckpointRule[] | undefined>): CheckpointRule[] {
  const rules = new Map<string, CheckpointRule>();
  for (const set of sets) for (const rule of parseCheckpointRules(set)) {
    rules.set(JSON.stringify([normalize(rule.room), normalize(rule.item), normalize(rule.name)]), rule);
  }
  return parseCheckpointRules([...rules.values()]);
}

export function addCheckpointRule(project: Project, rule: CheckpointRule) {
  project.checkpointRules = mergeCheckpointRules(project.checkpointRules, [rule]);
  return applyCheckpointRules(project);
}
