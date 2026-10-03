import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { publishMock, rpcMock, fromMock, getSessionMock } = vi.hoisted(() => ({
  publishMock: vi.fn(), rpcMock: vi.fn(), fromMock: vi.fn(), getSessionMock: vi.fn(),
}));

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({
    auth: { getSession: getSessionMock }, from: fromMock, rpc: rpcMock,
  }),
}));
vi.mock('@/lib/collaboration/deviceIdentity', () => ({ getCollaborationDeviceId: () => 'this-phone' }));
vi.mock('@/lib/collaboration/sharedProjectAreas', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/collaboration/sharedProjectAreas')>(),
  publishSharedProjectAreaSnapshot: publishMock,
}));

import {
  createArea, createProject, deleteProject, getPendingSharedAreaSyncsForProject,
  getProject, recordPendingSharedAreaSyncFailure, saveAreaNotes,
  saveProjectPreserveTimestamps, saveReviewedSharedProject,
} from '@/lib/db';
import { SharedProjectAreaConflictError } from '@/lib/collaboration/sharedProjectAreas';
import { flushPendingSharedAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';
import { releaseSharedArea } from '@/features/collaboration/releaseSharedArea';
import { stageCaptureDraft } from '@/lib/captureJournal';

const projectIds: string[] = [];
const publishedAt = '2026-10-03T00:00:00.000Z';

beforeEach(() => {
  publishMock.mockReset(); rpcMock.mockReset(); fromMock.mockReset(); getSessionMock.mockReset();
  getSessionMock.mockResolvedValue({ data: { session: { user: { id: 'member' } } }, error: null });
  publishMock.mockImplementation(async (input: { baseVersion: number }) => ({
    areaVersion: input.baseVersion + 1, publishedAt,
  }));
  rpcMock.mockResolvedValue({ data: true, error: null });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const id of projectIds.splice(0)) await deleteProject(id);
});

async function reviewedFixture() {
  const project = createProject('Alafia release regression');
  project.sharedProjectId = crypto.randomUUID();
  project.sharedSnapshotPublishedAt = new Date('2026-10-02T12:00:00.000Z');
  project.sharedBaselinePublishedAt = project.sharedSnapshotPublishedAt;
  const selected = createArea(project.id, 'Unit 203', 0);
  const other = createArea(project.id, 'Unit 207', 1);
  selected.sharedVersion = 3;
  other.sharedVersion = 6;
  selected.notes = 'Keep my 203 inspection';
  other.notes = 'Keep my 207 inspection';
  project.areas.push(selected, other);
  await saveProjectPreserveTimestamps(project);
  projectIds.push(project.id);
  const source = (await getProject(project.id))!;
  const resolution = structuredClone(source);
  resolution.areas[0].sharedVersion = 4;
  resolution.areas[1].sharedVersion = 7;
  resolution.areas.forEach((area) => { area.sharedPublishedAt = new Date('2026-10-02T13:00:00.000Z'); });
  expect(await saveReviewedSharedProject(resolution, source, [selected.id, other.id], false)).toBe(true);

  fromMock.mockReturnValue({
    select: () => ({ eq: () => ({ eq: async () => ({
      data: project.areas.map((area) => ({
        id: `claim-${area.id}`, project_id: project.sharedProjectId, area_id: area.id,
        claimed_by_user_id: 'member', device_id: 'this-phone', status: 'active',
        claimed_at: '2026-10-02T12:00:00.000Z', expires_at: null, released_at: null,
        transferred_to_user_id: null,
      })), error: null,
    }) }) }),
  });
  const input = { localProjectId: project.id, sharedProjectId: project.sharedProjectId, areaId: selected.id };
  return { project, selected, other, input };
}

describe('direct area release after reviewing team updates', () => {
  it('sends the reviewed selected area and releases only its confirmed version', async () => {
    const { project, selected, other, input } = await reviewedFixture();
    const before = await getPendingSharedAreaSyncsForProject(project.id);
    expect(before.find((record) => record.areaId === selected.id)).toMatchObject({
      baseVersion: 4, blockedByConflict: true, readyAfterConflictReview: true,
    });

    await releaseSharedArea(input);

    expect(publishMock).toHaveBeenCalledOnce();
    expect(publishMock).toHaveBeenCalledWith(expect.objectContaining({ areaId: selected.id, baseVersion: 4 }));
    expect(rpcMock).toHaveBeenCalledOnce();
    expect(rpcMock).toHaveBeenCalledWith('release_shared_project_area_v2', {
      p_project_id: project.sharedProjectId, p_area_id: selected.id, p_claim_id: `claim-${selected.id}`,
      p_device_id: 'this-phone', p_expected_version: 5,
    });
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual([
      before.find((record) => record.areaId === other.id),
    ]);
    expect((await getProject(project.id))?.areas[0].notes).toBe('Keep my 203 inspection');
  });

  it('leaves another area untouched even when that area has unblocked edits ready to send', async () => {
    const { project, other, selected, input } = await reviewedFixture();
    await saveAreaNotes(project.id, other.id, 'New 207 work');
    const otherBefore = (await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === other.id);
    expect(otherBefore?.blockedByConflict).toBe(false);

    await releaseSharedArea(input);

    expect(publishMock.mock.calls.map(([entry]) => entry.areaId)).toEqual([selected.id]);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual([otherBefore]);
    expect((await getProject(project.id))?.areas[1].notes).toBe('New 207 work');
    expect(rpcMock).toHaveBeenCalledOnce();
  });

  it('keeps an unreviewed version conflict blocked and reports its cause without attempting publication or release', async () => {
    const { project, selected, input } = await reviewedFixture();
    const queued = (await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === selected.id)!;
    const conflict = new SharedProjectAreaConflictError();
    await recordPendingSharedAreaSyncFailure(queued.key, queued.clientId, conflict.message, true);

    await expect(releaseSharedArea(input)).rejects.toThrow(conflict.message);

    expect(publishMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect((await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === selected.id))
      .toMatchObject({ blockedByConflict: true, readyAfterConflictReview: false, lastError: conflict.message });
  });

  it('shows a new version rejection after review and keeps the selected queue and lock', async () => {
    const { project, selected, input } = await reviewedFixture();
    const conflict = new SharedProjectAreaConflictError();
    publishMock.mockRejectedValueOnce(conflict);

    await expect(releaseSharedArea(input)).rejects.toThrow(conflict.message);

    expect(publishMock).toHaveBeenCalledOnce();
    expect(rpcMock).not.toHaveBeenCalled();
    expect((await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === selected.id))
      .toMatchObject({ blockedByConflict: true, readyAfterConflictReview: false, lastError: conflict.message });
  });

  it('keeps an unreviewed version-code conflict blocked even if its message mentions another device lock', async () => {
    const { project, selected, input } = await reviewedFixture();
    const queued = (await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === selected.id)!;
    const message = 'This area has newer team data and is locked by another device.';
    await recordPendingSharedAreaSyncFailure(queued.key, queued.clientId, message, true, '40001');

    await expect(releaseSharedArea(input)).rejects.toThrow(message);

    expect(publishMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect((await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === selected.id))
      .toMatchObject({ blockedByConflict: true, readyAfterConflictReview: false, lastErrorCode: '40001' });
  });

  it('retries a resolved permission failure only after an explicit release, using the original write identity and base', async () => {
    const { project, selected, other, input } = await reviewedFixture();
    const before = await getPendingSharedAreaSyncsForProject(project.id);
    const queued = before.find((record) => record.areaId === selected.id)!;
    await recordPendingSharedAreaSyncFailure(queued.key, queued.clientId, 'Permission denied for this area', true, '42501');

    await flushPendingSharedAreaSyncs(project.id, selected.id);
    expect(publishMock).not.toHaveBeenCalled();

    await releaseSharedArea(input);

    expect(publishMock).toHaveBeenCalledOnce();
    expect(publishMock).toHaveBeenCalledWith(expect.objectContaining({
      areaId: selected.id, baseVersion: queued.baseVersion,
      basePublishedAt: queued.basePublishedAt, clientId: queued.clientId,
    }));
    expect(rpcMock).toHaveBeenCalledOnce();
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual([
      before.find((record) => record.areaId === other.id),
    ]);
  });

  it('keeps the original write pending and locked when permission is still denied on an explicit retry', async () => {
    const { project, selected, input } = await reviewedFixture();
    const queued = (await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === selected.id)!;
    await recordPendingSharedAreaSyncFailure(queued.key, queued.clientId, 'Permission denied for this area', true, '42501');
    publishMock.mockRejectedValueOnce({ code: '42501', message: 'Permission denied for this area' });

    await expect(releaseSharedArea(input)).rejects.toThrow('Permission denied for this area');

    expect(publishMock).toHaveBeenCalledOnce();
    expect(rpcMock).not.toHaveBeenCalled();
    expect((await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === selected.id))
      .toMatchObject({
        clientId: queued.clientId, revision: queued.revision, baseVersion: queued.baseVersion,
        basePublishedAt: queued.basePublishedAt, blockedByConflict: true,
        readyAfterConflictReview: false, lastErrorCode: '42501', lastError: 'Permission denied for this area',
      });
  });

  it('retains a new local edit and the lock when it arrives during publication', async () => {
    const { project, selected, input } = await reviewedFixture();
    publishMock.mockImplementationOnce(async () => {
      await saveAreaNotes(project.id, selected.id, 'Typed during upload');
      return { areaVersion: 5, publishedAt };
    });

    await expect(releaseSharedArea(input)).rejects.toThrow('changes are still waiting to reach the team');

    expect(rpcMock).not.toHaveBeenCalled();
    expect((await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === selected.id))
      .toMatchObject({ baseVersion: 5, blockedByConflict: false });
    expect((await getProject(project.id))?.areas[0].notes).toBe('Typed during upload');
  });

  it('keeps the queue and lock while offline', async () => {
    const { project, selected, input } = await reviewedFixture();
    vi.stubGlobal('navigator', { onLine: false });

    await expect(releaseSharedArea(input)).rejects.toThrow('The device is offline');

    expect(publishMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect((await getPendingSharedAreaSyncsForProject(project.id)).some((record) => record.areaId === selected.id)).toBe(true);
  });

  it('reports a service rejection while retaining the pending area and lock', async () => {
    const { project, selected, input } = await reviewedFixture();
    publishMock.mockRejectedValueOnce({ code: '53300', message: 'Too many connections issued to the database' });

    await expect(releaseSharedArea(input)).rejects.toThrow('Too many connections issued to the database');

    expect(rpcMock).not.toHaveBeenCalled();
    expect((await getPendingSharedAreaSyncsForProject(project.id)).find((record) => record.areaId === selected.id))
      .toMatchObject({ lastError: 'Too many connections issued to the database', blockedByConflict: false });
  });

  it('describes a failed request neutrally without claiming the phone lost its connection', async () => {
    const { project, selected, input } = await reviewedFixture();
    publishMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(releaseSharedArea(input)).rejects.toThrow('The request to the team service did not complete');

    expect(rpcMock).not.toHaveBeenCalled();
    expect((await getPendingSharedAreaSyncsForProject(project.id)).some((record) => record.areaId === selected.id)).toBe(true);
  });

  it('keeps the retained-capture guard before releasing a successfully sent area', async () => {
    const { project, selected, input } = await reviewedFixture();
    await stageCaptureDraft({
      key: `area-note:${project.id}:${selected.id}`, revision: crypto.randomUUID(),
      projectId: project.id, areaId: selected.id, checkpointId: selected.id, kind: 'area-note',
      value: 'Unsaved general note', baseValue: selected.notes, savedAt: new Date(),
    });

    await expect(releaseSharedArea(input)).rejects.toThrow('retained captures still waiting to save');

    expect(publishMock).toHaveBeenCalledOnce();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('refuses a changed team link before resuming or sending work', async () => {
    const { project, input } = await reviewedFixture();
    const before = await getPendingSharedAreaSyncsForProject(project.id);

    await expect(releaseSharedArea({ ...input, sharedProjectId: crypto.randomUUID() })).rejects.toThrow('team link changed');

    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual(before);
    expect(publishMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
