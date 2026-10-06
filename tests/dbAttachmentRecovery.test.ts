import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
const { copies, publish } = vi.hoisted(() => ({ copies: vi.fn(), publish: vi.fn() }));
vi.mock('@/lib/collaboration/sharedProjectSnapshots', () => ({ getSharedAttachmentRecoveryCopies: copies }));
vi.mock('@/lib/collaboration/supabaseClient', () => ({ getCollaborationSupabaseClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'member' } } }, error: null }) },
}) }));
vi.mock('@/lib/collaboration/sharedProjectAreas', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/collaboration/sharedProjectAreas')>(),
  publishSharedProjectAreaSnapshot: publish,
}));
import {
  createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment,
  getProject, getProjectMetadata, saveProjectPreserveTimestamps, saveAreaNotes, deleteProject,
  getPendingSharedAreaSyncsForProject, getUnreadableAttachmentIds, restoreUnreadableAttachments,
  listSharedProjectRecoveries, createFileAttachment, resumeReviewedPendingSharedAreaSyncs, getProjectForAreaPreview,
  getLocalAttachmentRecoveryCopies,
} from '@/lib/db';
import { flushPendingSharedAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';
import { registerLocalMediaRecovery } from '@/lib/localMediaRecovery';
import { recoverLocalTeamAttachments } from '@/features/sync/recoverLocalTeamAttachments';
import { stageCaptureDraft, listCaptureDrafts } from '@/lib/captureJournal';
import { loadProjectForExport } from '@/features/export/loadProjectForExport';
import type { Project } from '@/types';

let project: Project;
let unregister: (() => void) | undefined;
beforeEach(async () => {
  copies.mockReset();
  publish.mockReset();
  publish.mockImplementation(async ({ baseVersion }: { baseVersion: number }) => ({ areaVersion: baseVersion + 1, publishedAt: new Date().toISOString() }));
  project = createProject('Unreadable device photo');
  project.sharedProjectId = crypto.randomUUID();
  project.sharedSnapshotPublishedAt = project.sharedBaselinePublishedAt = new Date('2026-10-01');
  const area = createArea(project.id, 'Unit 203', 0);
  const room = createLocation(area.id, 'Bedroom', 0);
  const item = createItem(room.id, 'Door', 0);
  const checkpoint = createCheckpoint(item.id, 'Finish', 0);
  checkpoint.photos = [createPhotoAttachment(checkpoint.id, 'data:image/png;base64,YQ==')];
  item.checkpoints = [checkpoint]; room.items = [item]; area.locations = [room];
  area.sharedVersion = 3; project.areas = [area];
  await saveProjectPreserveTimestamps(project);
});
afterEach(async () => { unregister?.(); unregister = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); await deleteProject(project.id); });

function breakSavedBlobs() {
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new DOMException('The object can not be found here.', 'NotFoundError'));
  vi.spyOn(Blob.prototype, 'stream').mockImplementation(() => { throw new DOMException('Missing backing file', 'NotFoundError'); });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('Missing backing file'); });
}
describe('saved attachment recovery', () => {
  async function seedOldRecovery(copy: Project) {
    const db = await openDB('punchlist-db');
    const id = crypto.randomUUID();
    await db.put('sharedProjectRecovery', { id, localProjectId: project.id, project: copy, mediaRecords: [],
      elevationDrawingRecords: [], areaSyncRecords: [], metadataSyncRecords: [] });
    db.close();
  }

  it('recovers an exact readable copy from local history without restoring older inspection work or contacting Team storage', async () => {
    const old = structuredClone(project);
    old.areas[0].notes = 'Old note';
    await seedOldRecovery(old);
    await saveAreaNotes(project.id, project.areas[0].id, 'Current unsent note');
    const queue = await getPendingSharedAreaSyncsForProject(project.id);
    unregister = registerLocalMediaRecovery((id, areaId) => recoverLocalTeamAttachments(id, () => true, areaId));
    breakSavedBlobs();
    const recovered = await getProject(project.id);
    expect(recovered!.areas[0].notes).toBe('Current unsent note');
    expect(recovered!.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('data:image/png;base64,YQ==');
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual(queue);
    expect(copies).not.toHaveBeenCalled();
  });

  it('refuses older photo copies with mismatched identity timestamps or a different Team project', async () => {
    const old = structuredClone(project);
    old.areas[0].locations[0].items[0].checkpoints[0].photos[0].createdAt = new Date('2000-01-01');
    await seedOldRecovery(old);
    const other = structuredClone(project); other.sharedProjectId = 'other-team';
    await seedOldRecovery(other);
    breakSavedBlobs();
    const local = await getLocalAttachmentRecoveryCopies(project.id, () => true);
    expect(local!.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('');
    expect(await restoreUnreadableAttachments(project.id, local!, () => true)).toBe(0);
  });

  it('stops reading local history after the account changes', async () => {
    await seedOldRecovery(structuredClone(project));
    expect(await getLocalAttachmentRecoveryCopies(project.id, () => false)).toBeUndefined();
  });

  it('recovers server photo bytes automatically without replacing local notes, revisions, queues, or drafts', async () => {
    await saveAreaNotes(project.id, project.areas[0].id, 'My unsent inspection');
    const queue = await getPendingSharedAreaSyncsForProject(project.id);
    await stageCaptureDraft({ key: `area-note:${project.id}:${project.areas[0].id}`, revision: 'draft', kind: 'area-note',
      projectId: project.id, areaId: project.areas[0].id, checkpointId: '', savedAt: new Date(), value: 'Typing another note', baseValue: 'My unsent inspection' });
    copies.mockResolvedValue({ ...structuredClone(project), areas: project.areas.map((area) => ({ ...area, sharedVersion: 99, notes: 'Older server note' })) });
    unregister = registerLocalMediaRecovery((id, areaId) => recoverLocalTeamAttachments(id, () => true, areaId));
    breakSavedBlobs();
    const loaded = await getProject(project.id);
    expect(loaded!.areas[0].notes).toBe('My unsent inspection');
    expect(loaded!.areas[0].sharedVersion).toBe(3);
    expect(loaded!.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('data:image/png;base64,YQ==');
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual(queue);
    expect(await listCaptureDrafts(project.id, project.areas[0].id)).toHaveLength(1);
    expect(await listSharedProjectRecoveries(project.sharedProjectId!)).toHaveLength(1);
  });

  it('does not replace readable local bytes with a different server image', async () => {
    const remote = structuredClone(project);
    remote.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData = 'data:image/png;base64,Yg==';
    expect(await restoreUnreadableAttachments(project.id, remote, () => true)).toBe(0);
    expect((await getProject(project.id))!.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('data:image/png;base64,YQ==');
  });

  it('recovers an unreadable file and thumbnail while preserving their attachment identities', async () => {
    const checkpoint = project.areas[0].locations[0].items[0].checkpoints[0];
    checkpoint.photos[0].thumbnail = 'data:image/png;base64,Yg==';
    checkpoint.files = [createFileAttachment(checkpoint.id, 'data:application/pdf;base64,Yw==', 'notes.pdf', 'application/pdf', 1)];
    await saveProjectPreserveTimestamps(project);
    breakSavedBlobs();
    expect(await restoreUnreadableAttachments(project.id, structuredClone(project), () => true)).toBe(2);
    expect((await getProject(project.id))!.areas[0].locations[0].items[0].checkpoints[0]).toMatchObject({
      photos: checkpoint.photos, files: checkpoint.files,
    });
    expect(await getUnreadableAttachmentIds(project.id)).toEqual([]);
  });

  it('sends another unit while retaining an unreadable unit and retries its original queued write after recovery', async () => {
    const readable = createArea(project.id, 'Unit 207', 1);
    project.areas.push(readable);
    await saveProjectPreserveTimestamps(project);
    await saveAreaNotes(project.id, project.areas[0].id, 'My unsent 203 inspection');
    await saveAreaNotes(project.id, readable.id, 'My unsent 207 inspection');
    const original = (await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === project.areas[0].id)!;
    breakSavedBlobs();
    expect(await flushPendingSharedAreaSyncs(project.id)).toEqual({ synced: 1, pending: 1, conflicted: 0 });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0].areaId).toBe(readable.id);
    const retained = await getPendingSharedAreaSyncsForProject(project.id);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ clientId: original.clientId, revision: original.revision,
      baseVersion: original.baseVersion, blockedByConflict: true });
    copies.mockResolvedValue(structuredClone(project));
    unregister = registerLocalMediaRecovery((id, areaId) => recoverLocalTeamAttachments(id, () => true, areaId));
    await resumeReviewedPendingSharedAreaSyncs(project.id);
    expect(await flushPendingSharedAreaSyncs(project.id)).toEqual({ synced: 1, pending: 0, conflicted: 0 });
    const sent = publish.mock.calls[1][0];
    expect(sent.clientId).toBe(original.clientId);
    expect(sent.project.areas[0].notes).toBe('My unsent 203 inspection');
    expect(sent.project.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('data:image/png;base64,YQ==');
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual([]);
  });

  it('keeps an unsent unreadable photo and its queue when no matching cloud copy exists', async () => {
    await saveAreaNotes(project.id, project.areas[0].id, 'Keep unsent work');
    const queue = await getPendingSharedAreaSyncsForProject(project.id);
    const remote = structuredClone(project);
    remote.areas[0].locations[0].items[0].checkpoints[0].photos = [];
    copies.mockResolvedValue(remote);
    unregister = registerLocalMediaRecovery((id, areaId) => recoverLocalTeamAttachments(id, () => true, areaId));
    breakSavedBlobs();
    await expect(getProject(project.id)).rejects.toThrow('opening saved photos and files');
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual(queue);
    expect((await getProjectMetadata(project.id))!.areas[0].notes).toBe('Keep unsent work');
    expect(await getUnreadableAttachmentIds(project.id)).toEqual([project.areas[0].locations[0].items[0].checkpoints[0].photos[0].id]);
  });

  it('opens a read-only display preview with readable media and comments without changing the damaged record or queue', async () => {
    const checkpoint = project.areas[0].locations[0].items[0].checkpoints[0];
    checkpoint.comments = 'Keep checkpoint comment';
    vi.stubGlobal('navigator', { userAgent: 'AppleWebKit Safari' });
    const readable = createPhotoAttachment(checkpoint.id, 'data:image/png;base64,Yg==');
    // Preserve the first existing Blob while adding a readable Safari string.
    await saveAreaNotes(project.id, project.areas[0].id, 'Keep unsent area note');
    const { saveCheckpointInspectionChange } = await import('@/lib/db');
    await saveCheckpointInspectionChange(project.id, project.areas[0].id, checkpoint.id, { comments: checkpoint.comments }, [readable]);
    const queue = await getPendingSharedAreaSyncsForProject(project.id);
    breakSavedBlobs();
    const preview = await getProjectForAreaPreview(project.id, project.areas[0].id);
    const displayed = preview.project!.areas[0].locations[0].items[0].checkpoints[0];
    expect(preview.unreadableAttachments).toEqual([{ id: checkpoint.photos[0].id, checkpointId: checkpoint.id,
      areaId: project.areas[0].id, kind: 'photo', size: 1, mimeType: 'image/png' }]);
    expect(displayed.comments).toBe('Keep checkpoint comment');
    expect(preview.project!.areas[0].notes).toBe('Keep unsent area note');
    expect(displayed.photos.map((photo) => photo.id)).toEqual([checkpoint.photos[0].id, readable.id]);
    expect(displayed.photos[1].imageData).toBe(readable.imageData);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual(queue);
    await expect(getProject(project.id)).rejects.toThrow('opening saved photos and files');
    expect(await getUnreadableAttachmentIds(project.id)).toEqual([checkpoint.photos[0].id]);
  });

  it('sends current inspection work using Team bytes even when Safari cannot save the local repair, retaining the original device record', async () => {
    await saveAreaNotes(project.id, project.areas[0].id, 'Current phone inspection');
    const queued = (await getPendingSharedAreaSyncsForProject(project.id))[0];
    copies.mockResolvedValue(structuredClone(project));
    unregister = registerLocalMediaRecovery(async () => { throw new DOMException('Cannot clone original Safari file', 'NotFoundError'); });
    breakSavedBlobs();
    expect(await flushPendingSharedAreaSyncs(project.id)).toEqual({ synced: 1, pending: 0, conflicted: 0 });
    expect(publish).toHaveBeenCalledOnce();
    const sent = publish.mock.calls[0][0];
    expect(sent.clientId).toBe(queued.clientId);
    expect(sent.baseVersion).toBe(queued.baseVersion);
    expect(sent.project.areas[0].notes).toBe('Current phone inspection');
    expect(sent.project.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('data:image/png;base64,YQ==');
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual([]);
    expect((await getProjectMetadata(project.id))!.areas[0].notes).toBe('Current phone inspection');
    expect(await getUnreadableAttachmentIds(project.id)).toHaveLength(1);
  });

  it('exports selected areas without loading a damaged photo in another unit', async () => {
    const selected = createArea(project.id, 'Unit 207', 1);
    selected.notes = 'Selected unit note'; project.areas.push(selected);
    await saveProjectPreserveTimestamps(project);
    breakSavedBlobs();
    const exported = await loadProjectForExport(project.id, 'full', [selected.id]);
    expect(exported.areas.map((area) => area.id)).toEqual([selected.id]);
    expect(exported.areas[0].notes).toBe('Selected unit note');
    expect(copies).not.toHaveBeenCalled();
    expect(await getUnreadableAttachmentIds(project.id)).toHaveLength(1);
  });

  it('exports issues without requiring media from a non-issue checkpoint in the selected unit', async () => {
    const checkpoint = project.areas[0].locations[0].items[0].checkpoints[0];
    const issue = createCheckpoint(checkpoint.itemId, 'Issue without photos', 1);
    issue.status = 'needsReview'; issue.issueState = 'open'; issue.comments = 'Keep this issue';
    project.areas[0].locations[0].items[0].checkpoints.push(issue);
    await saveProjectPreserveTimestamps(project);
    breakSavedBlobs();
    const exported = await loadProjectForExport(project.id, 'issues', [project.areas[0].id]);
    expect(exported.areas[0].locations[0].items[0].checkpoints[1].comments).toBe('Keep this issue');
    expect(copies).not.toHaveBeenCalled();
    expect(await getUnreadableAttachmentIds(project.id)).toHaveLength(1);
  });

  it('exports local issues with matching Team photos without rewriting the original local media or sync queue', async () => {
    const checkpoint = project.areas[0].locations[0].items[0].checkpoints[0];
    const { saveCheckpointInspectionChange } = await import('@/lib/db');
    await saveCheckpointInspectionChange(project.id, project.areas[0].id, checkpoint.id,
      { status: 'needsReview', issueState: 'open', comments: 'Unsent phone issue' });
    const queued = await getPendingSharedAreaSyncsForProject(project.id);
    copies.mockResolvedValue(structuredClone(project));
    breakSavedBlobs();
    const exported = await loadProjectForExport(project.id, 'issues', [project.areas[0].id]);
    expect(exported.areas[0].locations[0].items[0].checkpoints[0]).toMatchObject({
      comments: 'Unsent phone issue', status: 'needsReview', issueState: 'open', photos: checkpoint.photos,
    });
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual(queued);
    expect(await getUnreadableAttachmentIds(project.id)).toHaveLength(1);
  });

  it('refuses an incomplete export when the required photo has no recoverable Team copy', async () => {
    const checkpoint = project.areas[0].locations[0].items[0].checkpoints[0];
    const { saveCheckpointInspectionChange } = await import('@/lib/db');
    await saveCheckpointInspectionChange(project.id, project.areas[0].id, checkpoint.id, { status: 'needsReview', issueState: 'open' });
    const queued = await getPendingSharedAreaSyncsForProject(project.id);
    const remote = structuredClone(project); remote.areas[0].locations[0].items[0].checkpoints[0].photos = [];
    copies.mockResolvedValue(remote);
    breakSavedBlobs();
    await expect(loadProjectForExport(project.id, 'issues', [project.areas[0].id])).rejects.toThrow('attachment(s) still need recovery');
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual(queued);
    expect(await getUnreadableAttachmentIds(project.id)).toHaveLength(1);
  });

  it('does not repair under an account that changed during download', async () => {
    breakSavedBlobs();
    expect(await restoreUnreadableAttachments(project.id, structuredClone(project), () => false)).toBe(0);
    expect(await getUnreadableAttachmentIds(project.id)).toHaveLength(1);
  });

  it('writes Safari attachments as strings so later Blob failures do not block the area', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' });
    await saveProjectPreserveTimestamps(project);
    breakSavedBlobs();
    expect((await getProject(project.id))!.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('data:image/png;base64,YQ==');
  });
});
