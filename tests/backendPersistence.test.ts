import { describe, expect, it } from 'vitest';
import {
  acknowledgePendingBackupRevisions, capturePendingBackupRevisions, createProject, createArea,
  createLocation, createItem, createCheckpoint, createPhotoAttachment, getDurablePendingSyncState,
  getProject, persistDurablePendingSyncState, saveProject, saveProjectPreserveTimestamps,
  saveCheckpointInspectionChange, saveAreaNotes, deleteProject,
} from '@/lib/db';
import { mergeProjects } from '@/lib/oneDriveSync';
import { parseProjectPayload, serializeProjectPayload } from '@/lib/projectPayload';
import { restoreCaptureDraft, stageCaptureDraft, listCaptureDrafts, type CaptureDraft } from '@/features/inspection/captureRecovery';

function fixture() {
  const project = createProject('Backend regression');
  const area = createArea(project.id, 'Area', 0);
  const location = createLocation(area.id, 'Room', 0);
  const item = createItem(location.id, 'Item', 0);
  const checkpoint = createCheckpoint(item.id, 'Checkpoint', 0);
  item.checkpoints.push(checkpoint); location.items.push(item); area.locations.push(location); project.areas.push(area);
  return { project, area, location, item, checkpoint };
}

describe('backup acknowledgements and attachment identity', () => {
  it('cannot clear a newer save or a different project through an older UI mirror', async () => {
    const first = createProject('First'); const second = createProject('Second');
    await saveProject(first);
    const sent = await capturePendingBackupRevisions();
    first.address = 'Saved during upload';
    await saveProject(first); await saveProject(second);
    await persistDurablePendingSyncState([], false);
    await acknowledgePendingBackupRevisions(sent);
    expect((await getDurablePendingSyncState()).projectIds).toEqual(expect.arrayContaining([first.id, second.id]));
    await acknowledgePendingBackupRevisions(await capturePendingBackupRevisions(), [first.id]);
    expect((await getDurablePendingSyncState()).projectIds).not.toContain(first.id);
    expect((await getDurablePendingSyncState()).projectIds).toContain(second.id);
  });

  it('keeps deleted photos deleted when an older backup is merged from either direction', async () => {
    const { project, area, checkpoint } = fixture();
    const photo = createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,YQ==');
    checkpoint.photos.push(photo);
    await saveProject(project);
    const oldBackup = structuredClone(project);
    await saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, {}, [], { removePhotoIds: [photo.id] });
    const saved = (await getProject(project.id))!;
    for (const merged of [mergeProjects(saved, oldBackup), mergeProjects(oldBackup, saved)]) {
      const result = parseProjectPayload(JSON.parse(serializeProjectPayload(merged)));
      const restored = result.areas[0].locations[0].items[0].checkpoints[0];
      expect(restored.photos).toHaveLength(0);
      expect(restored.deletedPhotoIds).toContain(photo.id);
    }
    await expect(saveCheckpointInspectionChange(project.id, area.id, checkpoint.id, {}, [photo])).rejects.toThrow('deliberately deleted');
  });

  it('rejects duplicate entity IDs and incorrect parents before import', () => {
    const { project, item, checkpoint } = fixture();
    item.checkpoints.push(structuredClone(checkpoint));
    expect(() => parseProjectPayload(project)).toThrow('Duplicate checkpoint ID');
    item.checkpoints.pop(); checkpoint.itemId = 'different-parent';
    expect(() => parseProjectPayload(project)).toThrow('different parent');
  });

  it('keeps drawing bytes isolated when two project copies share drawing IDs', async () => {
    const { project } = fixture();
    project.facadeElevationDrawings = [{ id: crypto.randomUUID(), orientation: 'North', name: 'Elevation', size: 1, fileName: 'Elevation.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ==', createdAt: new Date(), updatedAt: new Date() }];
    const copy = structuredClone(project); copy.id = crypto.randomUUID(); copy.areas[0].projectId = copy.id;
    copy.facadeElevationDrawings![0].dataUrl = 'data:image/png;base64,Yg==';
    await saveProjectPreserveTimestamps(project); await saveProjectPreserveTimestamps(copy);
    expect((await getProject(project.id))!.facadeElevationDrawings![0].dataUrl).toBe('data:image/png;base64,YQ==');
    await deleteProject(copy.id);
    expect((await getProject(project.id))!.facadeElevationDrawings![0].dataUrl).toBe('data:image/png;base64,YQ==');
  });

  it('rejects drawing IDs that collide with a photo storage directory', () => {
    const { project, checkpoint } = fixture();
    const photo = createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,YQ==');
    checkpoint.photos.push(photo);
    project.facadeElevationDrawings = [{ id: photo.id, orientation: 'North', name: 'Elevation', size: 1, fileName: 'Elevation.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ==', createdAt: new Date(), updatedAt: new Date() }];
    expect(() => parseProjectPayload(project)).toThrow('Duplicate attachment ID');
  });

  it('recovers a general note after interruption without erasing a later note', async () => {
    const { project, area } = fixture();
    area.notes = 'Original'; await saveProject(project);
    const draft: CaptureDraft = { key: `area-note:${project.id}:${area.id}`, revision: crypto.randomUUID(), projectId: project.id, areaId: area.id, checkpointId: area.id, kind: 'area-note', baseValue: 'Original', value: 'Interrupted field note', savedAt: new Date() };
    await stageCaptureDraft(draft);
    await saveAreaNotes(project.id, area.id, 'Later saved note');
    await restoreCaptureDraft(draft);
    expect((await getProject(project.id))!.areas[0].notes).toBe('Later saved note\nInterrupted field note');
    expect(await listCaptureDrafts(project.id, area.id)).toHaveLength(0);
  });
});
