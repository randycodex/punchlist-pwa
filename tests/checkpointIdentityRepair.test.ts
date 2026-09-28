import { describe, expect, it } from 'vitest';
import { createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment, saveProjectPreserveTimestamps, getProject, captureLocalProjectSaveToken, saveDownloadedProjectIfUnchanged } from '@/lib/db';
import { repairDuplicateCheckpointIdentities } from '@/lib/checkpointIdentityRepair';
import { parseProjectPayload, validateProjectIdentity } from '@/lib/projectPayload';
import { parseSharedSnapshotPayload, createCompactSharedSnapshotPayload } from '@/lib/collaboration/sharedSnapshotPayload';

function fixture() {
  const project = createProject('Legacy checkpoint recovery');
  const area = createArea(project.id, '5A', 0);
  const location = createLocation(area.id, 'Kitchen', 0);
  const item = createItem(location.id, 'Appliances', 0);
  const checkpoint = createCheckpoint(item.id, 'Refrigerator', 0);
  checkpoint.comments = 'Not installed';
  checkpoint.photos = [createPhotoAttachment(checkpoint.id, 'data:image/png;base64,YQ==')];
  const copy = structuredClone(checkpoint);
  copy.name = 'Yes/No'; copy.comments = '';
  copy.deletedPhotoIds = ['removed-photo'];
  item.checkpoints = [checkpoint, copy]; location.items = [item]; area.locations = [location]; project.areas = [area];
  return { project, item, checkpoint, copy };
}

describe('legacy checkpoint identity recovery', () => {
  it('preserves both entries and media with deterministic, independent identities', () => {
    const { project, item, checkpoint } = fixture();
    const otherDevice = structuredClone(project);
    const originalId = checkpoint.id;
    expect(() => parseProjectPayload(project)).toThrow('Duplicate checkpoint ID');
    expect(repairDuplicateCheckpointIdentities(project).changed).toBe(true);
    repairDuplicateCheckpointIdentities(otherDevice);
    expect(project).toEqual(otherDevice);
    expect(item.checkpoints.map(c => c.name)).toEqual(['Refrigerator', 'Yes/No']);
    expect(item.checkpoints[0].id).toBe(originalId);
    expect(item.checkpoints[1].id).not.toBe(originalId);
    expect(item.checkpoints[1].photos[0].id).not.toBe(checkpoint.photos[0].id);
    expect(item.checkpoints[1].photos[0].imageData).toBe(checkpoint.photos[0].imageData);
    expect(item.checkpoints[1].deletedPhotoIds).not.toContain('removed-photo');
    expect(() => validateProjectIdentity(project)).not.toThrow();
    expect(repairDuplicateCheckpointIdentities(project).changed).toBe(false);
  });

  it('keeps compact remote photo references available for both checkpoints', () => {
    const { project, checkpoint } = fixture();
    const reference = { bucket: 'project-attachments', path: 'project/photo/original.png', mimeType: 'image/png', sizeBytes: 1 };
    const payload = createCompactSharedSnapshotPayload(project, { photos: { [checkpoint.photos[0].id]: { image: reference } }, files: {}, drawings: {} });
    const parsed = parseSharedSnapshotPayload(payload, 2);
    const checkpoints = parsed.project.areas[0].locations[0].items[0].checkpoints;
    expect(checkpoints).toHaveLength(2);
    for (const entry of checkpoints) expect(parsed.assets.photos[entry.photos[0].id].image).toEqual(reference);
    expect(payload.project.areas[0].locations[0].items[0].checkpoints[1].id).toBe(checkpoint.id);
  });

  it('persists rekeyed photos without losing the original bytes or notes', async () => {
    const { project } = fixture();
    await saveProjectPreserveTimestamps(project);
    const token = await captureLocalProjectSaveToken(project.id);
    const hydrated = (await getProject(project.id))!;
    repairDuplicateCheckpointIdentities(hydrated);
    expect(await saveDownloadedProjectIfUnchanged(hydrated, token)).toBe(true);
    const saved = (await getProject(project.id))!;
    const entries = saved.areas[0].locations[0].items[0].checkpoints;
    expect(entries.map(c => c.comments)).toEqual(['Not installed', '']);
    expect(entries.map(c => c.photos[0].imageData)).toEqual(['data:image/png;base64,YQ==', 'data:image/png;base64,YQ==']);
    expect(() => validateProjectIdentity(saved)).not.toThrow();
  });
});
