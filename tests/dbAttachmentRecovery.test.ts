import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  listSharedProjectRecoveries, createFileAttachment, resumeReviewedPendingSharedAreaSyncs,
} from '@/lib/db';
import { flushPendingSharedAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';
import { registerLocalMediaRecovery } from '@/lib/localMediaRecovery';
import { recoverLocalTeamAttachments } from '@/features/sync/recoverLocalTeamAttachments';
import { stageCaptureDraft, listCaptureDrafts } from '@/lib/captureJournal';
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
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('Missing backing file'); });
}
describe('saved attachment recovery', () => {
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
