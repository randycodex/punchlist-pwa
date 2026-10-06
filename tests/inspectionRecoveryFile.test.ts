import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '@/lib/db';
import * as journal from '@/lib/captureJournal';
import { prepareInspectionRecoveryFile } from '@/features/export/inspectionRecoveryFile';
import type { Project } from '@/types';

let project: Project;
beforeEach(async () => {
  project = db.createProject('Alafia / Inspection'); project.sharedProjectId = crypto.randomUUID();
  for (let index = 0; index < 2; index++) {
    const area = db.createArea(project.id, `Unit ${702 + index}`, index);
    const room = db.createLocation(area.id, 'Bedroom', 0), item = db.createItem(room.id, 'Closet Door', 0);
    const checkpoint = db.createCheckpoint(item.id, 'Finish', 0);
    checkpoint.status = 'needsReview'; checkpoint.comments = `Keep comment ${index}`;
    checkpoint.photos = [db.createPhotoAttachment(checkpoint.id, 'data:image/png;base64,YQ==')];
    checkpoint.files = [db.createFileAttachment(checkpoint.id, 'data:application/pdf;base64,Yg==', 'notes.pdf', 'application/pdf', 1)];
    item.checkpoints = [checkpoint]; room.items = [item]; area.locations = [room]; project.areas.push(area);
  }
  await db.saveProjectPreserveTimestamps(project);
  await db.saveAreaNotes(project.id, project.areas[0].id, 'Unsent area note');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await journal.deleteProjectCaptureDrafts(project.id);
  await db.deleteProject(project.id);
});

describe('inspection recovery download', () => {
  it('backs up all saved unit results, comments, attachment references and queued writes without reading or rewriting broken photo files', async () => {
    const before = await db.getProjectMetadata(project.id);
    const savedHierarchy = JSON.parse((await db.captureLocalProjectSaveToken(project.id))!);
    const queue = await db.getPendingSharedAreaSyncsForProject(project.id);
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new DOMException('Missing Safari file', 'NotFoundError'));
    const file = await prepareInspectionRecoveryFile(project.id);
    expect(read).not.toHaveBeenCalled();
    const result = JSON.parse(file.json);
    expect(result).toMatchObject({ format: 'punchlist-inspection-recovery', version: 1,
      limitations: { savedPhotoFileAndDrawingBytesIncluded: false, unreadableDraftAreas: [] } });
    expect(result.project.areas).toHaveLength(2);
    expect(result.project.areas.map((area: { locations: unknown[] }) => area.locations)).toEqual(savedHierarchy.areas.map((area: { locations: unknown[] }) => area.locations));
    expect(result.project.areas[0].notes).toBe('Unsent area note');
    expect(result.project.areas[0].locations[0].items[0].checkpoints[0]).toMatchObject({
      status: 'needsReview', comments: 'Keep comment 0', photos: [{ id: project.areas[0].locations[0].items[0].checkpoints[0].photos[0].id, imageData: '' }],
      files: [{ name: 'notes.pdf', data: '' }],
    });
    expect(result.pendingSync.areas).toEqual(JSON.parse(JSON.stringify(queue)));
    expect(await db.getPendingSharedAreaSyncsForProject(project.id)).toEqual(queue);
    expect(await db.getProjectMetadata(project.id)).toEqual(before);
    read.mockRestore();
    expect((await db.getProject(project.id))!.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('data:image/png;base64,YQ==');
    expect(file.filename).toMatch(/^Alafia_Inspection_Inspection_Recovery_.*\.json$/);
  });

  it('keeps uncommitted note drafts separate from saved comments and leaves recovery drafts intact', async () => {
    const checkpoint = project.areas[0].locations[0].items[0].checkpoints[0];
    await journal.stageCaptureDraft({ key: `note:${project.id}:${checkpoint.id}`, projectId: project.id,
      areaId: project.areas[0].id, checkpointId: checkpoint.id, revision: 'latest-typing', savedAt: new Date(),
      kind: 'note', value: 'Still typing this comment', baseValue: 'Keep comment 0' });
    const originalDrafts = await journal.listCaptureDrafts(project.id, project.areas[0].id);
    const result = JSON.parse((await prepareInspectionRecoveryFile(project.id)).json);
    expect(result.captureDrafts).toEqual(JSON.parse(JSON.stringify(originalDrafts)));
    expect(result.project.areas[0].locations[0].items[0].checkpoints[0].comments).toBe('Keep comment 0');
    expect(await journal.listCaptureDrafts(project.id, project.areas[0].id)).toEqual(originalDrafts);
  });

  it('includes pending camera drafts without depending on the unreadable saved checkpoint photos', async () => {
    const checkpoint = project.areas[0].locations[0].items[0].checkpoints[0];
    const photo = db.createPhotoAttachment(checkpoint.id, 'data:image/png;base64,Yw==');
    await journal.stageCaptureDraft({ key: `photo:${project.id}:${photo.id}`, projectId: project.id, areaId: project.areas[0].id,
      checkpointId: checkpoint.id, revision: photo.id, savedAt: new Date(), kind: 'photo', photo });
    const result = JSON.parse((await prepareInspectionRecoveryFile(project.id)).json);
    expect(result.captureDrafts[0].photo).toMatchObject({ id: photo.id, imageData: photo.imageData });
    expect(await journal.listCaptureDrafts(project.id, project.areas[0].id)).toHaveLength(1);
  });

  it('reports unreadable draft areas explicitly while still safeguarding saved inspections', async () => {
    vi.spyOn(journal, 'listCaptureDrafts').mockRejectedValue(new DOMException('Journal unavailable', 'NotFoundError'));
    const file = await prepareInspectionRecoveryFile(project.id);
    const result = JSON.parse(file.json);
    expect(file.unreadableDraftAreaCount).toBe(2);
    expect(result.limitations.unreadableDraftAreas).toEqual(project.areas.map((area) => area.id));
    expect(result.project.areas[0].notes).toBe('Unsent area note');
  });

  it('rejects a copy whose saved inspection changed while being prepared', async () => {
    vi.spyOn(db, 'captureLocalProjectSaveToken').mockResolvedValueOnce('before').mockResolvedValueOnce('changed');
    const queue = await db.getPendingSharedAreaSyncsForProject(project.id);
    await expect(prepareInspectionRecoveryFile(project.id)).rejects.toThrow('changed while preparing');
    expect(await db.getPendingSharedAreaSyncsForProject(project.id)).toEqual(queue);
  });

  it('does not present a missing project as a successful recovery copy', async () => {
    await expect(prepareInspectionRecoveryFile(crypto.randomUUID())).rejects.toThrow('not available');
  });
});
