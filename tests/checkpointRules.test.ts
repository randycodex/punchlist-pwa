import { describe, expect, it } from 'vitest';
import { addCheckpointRule, applyCheckpointRules, parseCheckpointRules, mergeCheckpointRules } from '@/lib/checkpointRules';
import { createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment, saveProjectPreserveTimestamps, saveProjectMetadataWithSharedSync, getProject, saveCheckpointInspectionChange, getPendingSharedProjectMetadataSyncs, getPendingSharedAreaSyncsForProject } from '@/lib/db';
import { createSharedProjectMetadataPayload, applySharedProjectMetadataSnapshot } from '@/lib/collaboration/sharedProjectMetadata';
import { parseProjectPayload, serializeProjectPayload } from '@/lib/projectPayload';

function fixture() {
  const project = createProject('Rule test');
  for (const number of ['14A', '14B']) {
    const area = createArea(project.id, number, project.areas.length, { areaTypeKey: 'apartment_unit' });
    area.areaTypeKey = 'apartment_unit';
    for (const roomName of ['Kitchen', 'Bathroom']) {
      const room = createLocation(area.id, roomName, area.locations.length);
      const item = createItem(room.id, 'Ceiling', 0);
      item.checkpoints.push(createCheckpoint(item.id, 'Paint', 0));
      room.items.push(item); area.locations.push(room);
    }
    project.areas.push(area);
  }
  return project;
}
const rule = { room: 'Kitchen', item: 'Ceiling', name: 'Cracks' };

describe('project checkpoint rules', () => {
  it('adds only matching checkpoints, preserves results, and is idempotent', () => {
    const project = fixture();
    project.areas[0].locations[0].items[0].checkpoints[0].comments = 'Keep this note';
    addCheckpointRule(project, rule); applyCheckpointRules(project);
    for (const area of project.areas) {
      expect(area.locations[0].items[0].checkpoints.map((c) => c.name)).toEqual(['Paint', 'Cracks']);
      expect(area.locations[1].items[0].checkpoints).toHaveLength(1);
      expect(area.locations[0].items[0].checkpoints[1].photos).toEqual([]);
    }
    expect(project.areas[0].locations[0].items[0].checkpoints[0].comments).toBe('Keep this note');
  });
  it('generates the same IDs for independently synced teammates and future units', () => {
    const first = fixture(); const second = structuredClone(first);
    addCheckpointRule(first, rule);
    const remote = applySharedProjectMetadataSnapshot(second, {
      project_id: 'team', metadata_payload: createSharedProjectMetadataPayload(first), payload_version: 1,
      version: 1, published_at: new Date().toISOString(), published_by_user_id: 'member',
    });
    expect(remote.areas).toEqual(first.areas);
    const future = structuredClone(first.areas[0]); future.id = crypto.randomUUID();
    future.locations[0].items[0].id = crypto.randomUUID(); future.locations[0].items[0].checkpoints = [];
    remote.areas.push(future); applyCheckpointRules(remote);
    expect(future.locations[0].items[0].checkpoints[0].name).toBe('Cracks');
  });
  it('queues team metadata without claiming or queuing other areas and supports photo writes', async () => {
    const project = fixture(); project.sharedProjectId = crypto.randomUUID(); project.sharedSnapshotPublishedAt = new Date();
    await saveProjectPreserveTimestamps(project);
    addCheckpointRule(project, rule); await saveProjectMetadataWithSharedSync(project);
    expect((await getPendingSharedProjectMetadataSyncs()).some((r) => r.localProjectId === project.id)).toBe(true);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(0);
    const saved = (await getProject(project.id))!;
    const checkpoint = saved.areas[0].locations[0].items[0].checkpoints[1];
    await saveCheckpointInspectionChange(project.id, saved.areas[0].id, checkpoint.id, { comments: 'Only 14A' });
    const reloaded = (await getProject(project.id))!;
    expect(reloaded.areas[0].locations[0].items[0].checkpoints[1].comments).toBe('Only 14A');
    expect(reloaded.areas[1].locations[0].items[0].checkpoints[1].comments).toBe('');
  });
  it('undo removes only the batch while preserving a later photo and checkpoint edits', async () => {
    const project = fixture(); await saveProjectPreserveTimestamps(project);
    const area = project.areas[0]; const checkpoint = area.locations[0].items[0].checkpoints[0];
    const first = createPhotoAttachment(checkpoint.id, 'data:image/png;base64,AA==');
    const later = createPhotoAttachment(checkpoint.id, 'data:image/png;base64,AQ==');
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, {}, [first]);
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, { comments: 'Later note' }, [later]);
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, {}, [], { removePhotoIds: [first.id] });
    const saved = (await getProject(project.id))!.areas[0].locations[0].items[0].checkpoints[0];
    expect(saved.photos.map((p) => p.id)).toEqual([later.id]);
    expect(saved.comments).toBe('Later note');
  });
  it('merges different team rules without duplicating equivalent names', () => {
    const other = { ...rule, name: 'Leaks' };
    expect(mergeCheckpointRules([rule], [other, { ...rule, name: ' Cracks ' }])).toHaveLength(2);
  });
  it('validates rule limits and preserves them in backup payloads', () => {
    expect(() => parseCheckpointRules([{ ...rule, name: '' }])).toThrow();
    expect(() => parseCheckpointRules(Array(101).fill(rule))).toThrow();
    const project = fixture(); addCheckpointRule(project, rule);
    expect(parseProjectPayload(JSON.parse(serializeProjectPayload(project)).project).checkpointRules).toEqual([rule]);
  });
});
