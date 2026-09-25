import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createArea,
  createCheckpoint,
  createItem,
  createLocation,
  createPhotoAttachment,
  createProject,
  getProject,
  deleteProject,
  saveProjectPreserveTimestamps,
} from '@/lib/db';
import { serializeProjectPayload } from '@/lib/projectPayload';

const { listProjectFilesMock, listPhotoProjectFoldersMock, listProjectPhotoFilesMock, downloadProjectFileMock, uploadProjectFileMock, uploadProjectPhotoFileMock, deleteDriveItemMock, downloadDeletionLogMock, uploadDeletionLogMock, deleteProjectFolderFromStateMock, deleteProjectPhotoFolderMock } = vi.hoisted(() => ({
  listProjectFilesMock: vi.fn(),
  listPhotoProjectFoldersMock: vi.fn(),
  listProjectPhotoFilesMock: vi.fn(),
  downloadProjectFileMock: vi.fn(),
  uploadProjectFileMock: vi.fn(),
  uploadProjectPhotoFileMock: vi.fn(),
  deleteDriveItemMock: vi.fn(),
  downloadDeletionLogMock: vi.fn(),
  uploadDeletionLogMock: vi.fn(),
  deleteProjectFolderFromStateMock: vi.fn(),
  deleteProjectPhotoFolderMock: vi.fn(),
}));

vi.mock('@/lib/oneDrive', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/oneDrive')>(),
  acquireSyncLease: async () => async () => {},
  ensurePunchListFolders: async () => {},
  listProjectFiles: listProjectFilesMock,
  downloadProjectFile: downloadProjectFileMock,
  listPhotoProjectFolders: listPhotoProjectFoldersMock,
  listProjectPhotoFiles: listProjectPhotoFilesMock,
  uploadProjectFile: uploadProjectFileMock,
  uploadProjectPhotoFile: uploadProjectPhotoFileMock,
  deleteDriveItem: deleteDriveItemMock,
  downloadDeletionLog: downloadDeletionLogMock,
  uploadDeletionLog: uploadDeletionLogMock,
  deleteProjectFolderFromState: deleteProjectFolderFromStateMock,
  deleteProjectPhotoFolder: deleteProjectPhotoFolderMock,
}));

import { backupProjectsToOneDrive, markProjectDeleted, mergePersonalProjectsFromOneDrive, restoreMissingProjectsFromOneDrive } from '@/lib/oneDriveSync';

describe('OneDrive and team project identity', () => {
  beforeEach(() => {
    listProjectFilesMock.mockReset().mockResolvedValue([]);
    listPhotoProjectFoldersMock.mockReset().mockResolvedValue([]);
    listProjectPhotoFilesMock.mockReset().mockResolvedValue([]);
    downloadProjectFileMock.mockReset();
    uploadProjectFileMock.mockReset();
    uploadProjectPhotoFileMock.mockReset().mockResolvedValue(undefined);
    deleteDriveItemMock.mockReset().mockResolvedValue(undefined);
    downloadDeletionLogMock.mockReset().mockResolvedValue({});
    uploadDeletionLogMock.mockReset().mockResolvedValue({ id: 'deletion-log' });
    deleteProjectFolderFromStateMock.mockReset().mockResolvedValue(undefined);
    deleteProjectPhotoFolderMock.mockReset().mockResolvedValue(undefined);
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
  });

  it('does not restore a recovery copy after it was permanently deleted from Trash', async () => {
    const recovery = createProject('Recovered local copy - Ilse Hoffman House');
    recovery.recoveredFromProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(recovery);
    const deletedAt = new Date(Date.now() + 60_000);
    markProjectDeleted(recovery, deletedAt);
    await deleteProject(recovery.id);
    listProjectFilesMock.mockResolvedValue([{
      id: 'recovery-file', name: `Recovered_local_copy_${recovery.id}.json`,
      lastModifiedDateTime: recovery.updatedAt.toISOString(),
    }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(recovery));

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect(result.restoredProjectIds).toEqual([]);
    expect(result.permanentlyDeletedProjectNames).toEqual([recovery.projectName]);
    expect(await getProject(recovery.id)).toBeUndefined();
    expect(uploadDeletionLogMock).toHaveBeenCalledWith('test-token', expect.objectContaining({
      [recovery.id]: expect.objectContaining({ scope: 'personal' }),
    }));
    expect(deleteDriveItemMock).toHaveBeenCalledWith('test-token', 'recovery-file');
  });

  it('recognizes an older deletion marker after the old app restored the recovery copy', async () => {
    const recovery = createProject('Recovered local copy - Ilse Hoffman House');
    recovery.recoveredFromProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(recovery);
    const deletedAt = new Date(Date.now() + 60_000);
    localStorage.setItem('punchlist-onedrive-deletions', JSON.stringify({
      [recovery.id]: { updatedAt: deletedAt.toISOString() },
    }));
    listProjectFilesMock.mockResolvedValue([{
      id: 'recovery-file', name: `Recovered_local_copy_${recovery.id}.json`,
      lastModifiedDateTime: new Date(Date.now() + 120_000).toISOString(),
    }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(recovery));

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect(result.restoredProjectIds).toEqual([]);
    expect(result.permanentlyDeletedProjectNames).toEqual([recovery.projectName]);
    expect(await getProject(recovery.id)).toBeUndefined();
    expect(deleteDriveItemMock).toHaveBeenCalledWith('test-token', 'recovery-file');
  });

  it('applies a personal deletion from OneDrive before another device can back up the old copy', async () => {
    const recovery = createProject('Recovered local copy - Ilse Hoffman House');
    recovery.recoveredFromProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(recovery);
    const deletedAt = new Date(Date.now() + 60_000);
    downloadDeletionLogMock.mockResolvedValue({
      [recovery.id]: { updatedAt: deletedAt.toISOString(), scope: 'personal' },
    });
    listProjectFilesMock.mockResolvedValue([{
      id: 'recovery-file', name: `Recovered_local_copy_${recovery.id}.json`,
      lastModifiedDateTime: recovery.updatedAt.toISOString(),
    }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(recovery));

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect(result.restoredProjectIds).toEqual([]);
    expect(result.permanentlyDeletedProjectNames).toEqual([recovery.projectName]);
    expect(await getProject(recovery.id)).toBeUndefined();
  });

  it('does not re-upload a permanently deleted copy during a project-only backup', async () => {
    const staleCopy = createProject('Recovered local copy - Ilse Hoffman House');
    staleCopy.recoveredFromProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(staleCopy);
    downloadDeletionLogMock.mockResolvedValue({
      [staleCopy.id]: { updatedAt: new Date(Date.now() + 60_000).toISOString(), scope: 'personal' },
    });

    const result = await backupProjectsToOneDrive('test-token', [staleCopy.id]);

    expect(result.backedUpProjectIds).toEqual([]);
    expect(result.failedProjects?.[0]?.message).toContain('permanent deletion');
    expect(uploadProjectFileMock).not.toHaveBeenCalled();
  });

  it('does not apply an old team deletion marker to a separate personal backup with the same ID', async () => {
    const personal = createProject('Ilse Hoffman House - K&J (Kwassi)');
    await saveProjectPreserveTimestamps(personal);
    localStorage.setItem('punchlist-onedrive-deletions', JSON.stringify({
      [personal.id]: { updatedAt: new Date(Date.now() + 60_000).toISOString() },
    }));
    listProjectFilesMock.mockResolvedValue([{
      id: 'personal-file', name: `Ilse_Hoffman_House_KJ_${personal.id}.json`,
    }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(personal));

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect(result.permanentlyDeletedProjectNames).toEqual([]);
    expect(await getProject(personal.id)).toBeDefined();
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
  });

  it('does not restore another local copy of a team project with a different device ID', async () => {
    const localTeam = createProject('Team site');
    localTeam.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(localTeam);

    const remoteTeam = createProject('Team site');
    remoteTeam.sharedProjectId = localTeam.sharedProjectId;
    const remotePersonal = createProject('Personal site');
    listProjectFilesMock.mockResolvedValue([
      { id: 'remote-team-file', name: `Team_site_${remoteTeam.id}.json` },
      { id: 'remote-personal-file', name: `Personal_site_${remotePersonal.id}.json` },
    ]);
    downloadProjectFileMock.mockImplementation(async (_token: string, fileId: string) =>
      serializeProjectPayload(fileId === 'remote-team-file' ? remoteTeam : remotePersonal)
    );

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect(result.skippedProjectIds).toContain(remoteTeam.id);
    expect(result.restoredProjectIds).toContain(remotePersonal.id);
    expect(await getProject(remoteTeam.id)).toBeUndefined();
    expect(await getProject(remotePersonal.id)).toBeDefined();
    expect(await getProject(localTeam.id)).toBeDefined();
  });

  it('recovers an inactive team copy before restoring a personal backup with the same ID', async () => {
    const officeCopy = createProject('Ilse Hoffman House');
    officeCopy.sharedProjectId = crypto.randomUUID();
    const area = createArea(officeCopy.id, 'Unit 5A', 0);
    const location = createLocation(area.id, 'Kitchen', 0);
    const item = createItem(location.id, 'Window', 0);
    const checkpoint = createCheckpoint(item.id, 'Finish', 0);
    const drawingId = crypto.randomUUID();
    officeCopy.facadeElevationDrawings = [{
      id: drawingId,
      orientation: 'West',
      name: 'West elevation',
      fileName: 'west.png',
      mimeType: 'image/png',
      size: 5,
      dataUrl: 'data:image/png;base64,cG5n',
      createdAt: new Date(),
      updatedAt: new Date(),
    }];
    area.elevationDrawingId = drawingId;
    checkpoint.elevationMarker = { drawingId, xPercent: 25, yPercent: 40 };
    checkpoint.photos.push(createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8='));
    item.checkpoints.push(checkpoint);
    location.items.push(item);
    area.locations.push(location);
    officeCopy.areas.push(area);
    await saveProjectPreserveTimestamps(officeCopy);
    const activeTeam = createProject('Ilse Hoffman House');
    activeTeam.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(activeTeam);

    const personalBackup = {
      ...officeCopy,
      sharedProjectId: undefined,
      projectName: 'Ilse Hoffman House - K&J (Kwassi)',
      areas: [...officeCopy.areas, createArea(officeCopy.id, 'Unit 6A', 1)],
    };
    listProjectFilesMock.mockResolvedValue([{
      id: 'personal-file',
      name: `Ilse-Hoffman-House-K-J-Kwassi_${officeCopy.id}.json`,
    }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(personalBackup));

    const blocked = await restoreMissingProjectsFromOneDrive('test-token');
    expect(blocked.failedProjects).toEqual([]);
    expect(blocked.skippedProjectIds).toEqual([officeCopy.id]);
    expect(blocked.recoveredLocalCopies).toEqual([]);
    expect((await getProject(officeCopy.id))?.sharedProjectId).toBe(officeCopy.sharedProjectId);

    const result = await restoreMissingProjectsFromOneDrive('test-token', {
      recoverInactiveSharedProjectIds: [officeCopy.id],
    });
    expect(result.failedProjects).toEqual([]);
    expect(result.restoredProjectIds).toEqual([officeCopy.id]);
    expect(result.recoveredLocalCopies).toHaveLength(1);
    const restored = await getProject(officeCopy.id);
    const recovery = await getProject(result.recoveredLocalCopies![0].id);
    expect(restored?.projectName).toBe('Ilse Hoffman House - K&J (Kwassi)');
    expect(restored?.sharedProjectId).toBeUndefined();
    expect(restored?.areas).toHaveLength(2);
    expect(recovery?.projectName).toBe('Recovered local copy - Ilse Hoffman House');
    expect(recovery?.sharedProjectId).toBeUndefined();
    expect(recovery?.areas[0].projectId).toBe(recovery?.id);
    expect(recovery?.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData)
      .toBe('data:image/jpeg;base64,cGhvdG8=');
    expect(recovery?.facadeElevationDrawings?.[0].dataUrl).toBe('data:image/png;base64,cG5n');
    expect(recovery?.facadeElevationDrawings?.[0].id).not.toBe(drawingId);
    expect(recovery?.areas[0].elevationDrawingId).toBe(recovery?.facadeElevationDrawings?.[0].id);
    expect(recovery?.areas[0].locations[0].items[0].checkpoints[0].elevationMarker?.drawingId)
      .toBe(recovery?.facadeElevationDrawings?.[0].id);
    expect((await getProject(activeTeam.id))?.sharedProjectId).toBe(activeTeam.sharedProjectId);
  });

  it('backs up personal projects without creating another OneDrive copy of a team project', async () => {
    const team = createProject('Team site');
    team.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(team);

    const result = await backupProjectsToOneDrive('test-token', [team.id]);

    expect(result.backedUpProjectIds).toEqual([]);
    expect(uploadProjectFileMock).not.toHaveBeenCalled();
  });

  it('keeps local photo records intact while saving personal backup folder metadata', async () => {
    const project = createProject('Photo project');
    const area = createArea(project.id, 'Unit 1', 0);
    const location = createLocation(area.id, 'Kitchen', 0);
    const item = createItem(location.id, 'Window', 0);
    const checkpoint = createCheckpoint(item.id, 'Finish', 0);
    const imageData = 'data:image/jpeg;base64,cGhvdG8=';
    checkpoint.photos.push(createPhotoAttachment(checkpoint.id, imageData));
    item.checkpoints.push(checkpoint);
    location.items.push(item);
    area.locations.push(location);
    project.areas.push(area);
    await saveProjectPreserveTimestamps(project);
    uploadProjectFileMock.mockResolvedValue({ id: 'project-upload' });
    listPhotoProjectFoldersMock.mockResolvedValue([{ id: 'photo-folder', name: 'Photo-project' }]);
    listProjectPhotoFilesMock.mockResolvedValue([{
      id: 'remote-photo',
      name: `older_photo_name_001_${checkpoint.photos[0].id}.jpg`,
    }]);

    const mediaPut = vi.spyOn(IDBObjectStore.prototype, 'put');
    const result = await backupProjectsToOneDrive('test-token', [project.id]);
    const stored = await getProject(project.id);
    const mediaWrites = mediaPut.mock.instances.filter((store) =>
      (store as IDBObjectStore).name === 'checkpointMedia'
    );
    mediaPut.mockRestore();

    expect(result.failedProjects).toEqual([]);
    expect(result.backedUpProjectIds).toContain(project.id);
    expect(stored?.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe(imageData);
    expect(stored?.oneDriveFolderName).toBeTruthy();
    expect(mediaWrites).toHaveLength(0);
    expect(uploadProjectPhotoFileMock).not.toHaveBeenCalled();
  });

  it('finishes another personal backup when one project upload fails', async () => {
    const first = createProject('First personal project');
    const second = createProject('Second personal project');
    await saveProjectPreserveTimestamps(first);
    await saveProjectPreserveTimestamps(second);
    uploadProjectFileMock.mockImplementation(async (_token: string, _folder: string, filename: string) => {
      if (filename.includes(first.id)) throw new Error('First upload unavailable');
      return { id: 'second-upload' };
    });

    const result = await backupProjectsToOneDrive('test-token', [first.id, second.id]);

    expect(result.backedUpProjectIds).toContain(second.id);
    expect(result.backedUpProjectIds).not.toContain(first.id);
    expect(result.failedProjects).toEqual([{ id: first.id, name: first.projectName, message: 'First upload unavailable' }]);
    expect(uploadProjectFileMock).toHaveBeenCalledTimes(2);
  });

  it('archives a trashed personal copy in OneDrive so another device cannot restore it', async () => {
    const oldCopy = createProject('Personal site');
    oldCopy.updatedAt = new Date('2025-01-01');
    const trashedCopy = { ...oldCopy, deletedAt: new Date('2026-09-23'), updatedAt: new Date('2026-09-23') };
    await saveProjectPreserveTimestamps(trashedCopy);
    listProjectFilesMock.mockResolvedValue([{
      id: 'active-file',
      name: `Personal_site_${oldCopy.id}.json`,
      punchlistPath: `PunchList/Personal_site/Personal_site_${oldCopy.id}.json`,
    }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(oldCopy));
    uploadProjectFileMock.mockResolvedValue({ id: 'trash-file' });

    const result = await backupProjectsToOneDrive('test-token', [oldCopy.id]);

    expect(result.conflicts).toEqual([]);
    expect(uploadProjectFileMock).toHaveBeenCalledWith(
      'test-token', 'Personal_site', `Personal-site_${oldCopy.id}.json`,
      expect.any(String), true, undefined
    );
    expect(deleteDriveItemMock).toHaveBeenCalledWith('test-token', 'active-file');
  });

  it('writes a deletion marker when the active backup has the same timestamp', async () => {
    const active = createProject('Personal site');
    active.updatedAt = new Date('2026-09-23T12:00:00Z');
    const trashed = { ...active, deletedAt: active.updatedAt };
    await saveProjectPreserveTimestamps(trashed);
    listProjectFilesMock.mockResolvedValue([{
      id: 'active-file', eTag: 'active-etag',
      name: `Personal-site_${active.id}.json`,
      punchlistPath: `PunchList/Personal-site/Personal-site_${active.id}.json`,
    }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(active));
    uploadProjectFileMock.mockResolvedValue({ id: 'trash-file' });

    const result = await backupProjectsToOneDrive('test-token', [active.id]);

    expect(result.conflicts).toEqual([]);
    expect(uploadProjectFileMock).toHaveBeenCalledTimes(1);
    const uploadedPayload = uploadProjectFileMock.mock.calls[0][3] as string;
    expect(JSON.parse(uploadedPayload).project.deletedAt).toBe(active.updatedAt.toISOString());
    expect(uploadProjectFileMock.mock.calls[0][4]).toBe(true);
  });

  it('does not restore a personal backup marked as deleted even if its file is still active', async () => {
    const trashedCopy = createProject('Personal site');
    trashedCopy.deletedAt = new Date();
    listProjectFilesMock.mockResolvedValue([{
      id: 'stale-active-file',
      name: `Personal-site_${trashedCopy.id}.json`,
    }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(trashedCopy));

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect(result.restoredProjectIds).toEqual([]);
    expect(result.skippedProjectIds).toContain(trashedCopy.id);
    expect(await getProject(trashedCopy.id)).toBeUndefined();
  });

  it('waits for an in-flight restore before reporting another project failure', async () => {
    const first = createProject('Unavailable backup');
    const second = createProject('Available backup');
    listProjectFilesMock.mockResolvedValue([
      { id: 'failed-file', name: `Unavailable_${first.id}.json` },
      { id: 'slow-file', name: `Available_${second.id}.json` },
    ]);
    let releaseSlowDownload!: (value: string) => void;
    let markSlowStarted!: () => void;
    const slowDownload = new Promise<string>((resolve) => { releaseSlowDownload = resolve; });
    const slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve; });
    downloadProjectFileMock.mockImplementation(async (_token: string, fileId: string) => {
      if (fileId === 'failed-file') throw new Error('First download unavailable');
      markSlowStarted();
      return slowDownload;
    });

    let settled = false;
    const restore = restoreMissingProjectsFromOneDrive('test-token').then((result) => {
      settled = true;
      return result;
    });
    await slowStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    releaseSlowDownload(serializeProjectPayload(second));
    expect(await restore).toMatchObject({
      restoredProjectIds: [second.id],
      failedProjects: [{ id: first.id, message: 'First download unavailable' }],
    });
    expect(await getProject(second.id)).toBeDefined();
  });

  it('moves an older local personal copy to Trash when another device archived it', async () => {
    const localCopy = createProject('Personal site');
    localCopy.updatedAt = new Date('2025-01-01');
    await saveProjectPreserveTimestamps(localCopy);
    const remoteCopy = { ...localCopy, updatedAt: new Date('2026-09-23'), deletedAt: new Date('2026-09-23') };
    listProjectFilesMock.mockResolvedValue([{
      id: 'trash-file',
      name: `Personal-site_${localCopy.id}.json`,
      punchlistPath: `PunchList/Trash Bin/Personal_site/Personal-site_${localCopy.id}.json`,
    }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(remoteCopy));

    const result = await mergePersonalProjectsFromOneDrive('test-token');

    expect(result.archivedLocalProjectIds).toContain(localCopy.id);
    expect((await getProject(localCopy.id))?.deletedAt).toEqual(remoteCopy.deletedAt);
  });

  it('does not merge another personal project during a selected-project sync', async () => {
    const selected = createProject('Selected site');
    const other = createProject('Other site');
    selected.updatedAt = new Date('2025-01-01');
    other.updatedAt = new Date('2025-01-01');
    await saveProjectPreserveTimestamps(selected);
    await saveProjectPreserveTimestamps(other);
    const deletedAt = new Date('2026-09-23');
    listProjectFilesMock.mockResolvedValue([selected, other].map((project) => ({
      id: `trash-${project.id}`,
      name: `${project.projectName.replace(/ /g, '-')}_${project.id}.json`,
      punchlistPath: `PunchList/Trash Bin/${project.projectName}/${project.id}.json`,
    })));
    downloadProjectFileMock.mockImplementation(async (_token: string, remoteId: string) => {
      const project = remoteId === `trash-${selected.id}` ? selected : other;
      return serializeProjectPayload({ ...project, updatedAt: deletedAt, deletedAt });
    });

    const result = await mergePersonalProjectsFromOneDrive('test-token', [selected.id]);

    expect(result.archivedLocalProjectIds).toEqual([selected.id]);
    expect((await getProject(selected.id))?.deletedAt).toEqual(deletedAt);
    expect((await getProject(other.id))?.deletedAt).toBeUndefined();
    expect(downloadProjectFileMock).toHaveBeenCalledTimes(1);
  });

  it('keeps personal edits made after a remote copy was archived', async () => {
    const localCopy = createProject('Personal site');
    localCopy.updatedAt = new Date('2026-09-24');
    await saveProjectPreserveTimestamps(localCopy);
    const remoteCopy = { ...localCopy, updatedAt: new Date('2026-09-23'), deletedAt: new Date('2026-09-23') };
    listProjectFilesMock.mockResolvedValue([{
      id: 'trash-file',
      name: `Personal-site_${localCopy.id}.json`,
      punchlistPath: `PunchList/Trash Bin/Personal_site/Personal-site_${localCopy.id}.json`,
    }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(remoteCopy));

    const result = await mergePersonalProjectsFromOneDrive('test-token');

    expect(result.archivedLocalProjectIds).toEqual([]);
    expect((await getProject(localCopy.id))?.deletedAt).toBeUndefined();
  });

  it('does not restore old team backups after their local copies are removed', async () => {
    const first = createProject('Team site');
    first.sharedProjectId = crypto.randomUUID();
    const second = createProject('Team site');
    second.sharedProjectId = first.sharedProjectId;
    listProjectFilesMock.mockResolvedValue([
      { id: 'first-file', name: `Team_site_${first.id}.json` },
      { id: 'second-file', name: `Team_site_${second.id}.json` },
    ]);
    downloadProjectFileMock.mockImplementation(async (_token: string, fileId: string) =>
      serializeProjectPayload(fileId === 'first-file' ? first : second)
    );

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect(result.restoredProjectIds).toEqual([]);
    expect(result.skippedProjectIds).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(await getProject(first.id)).toBeUndefined();
    expect(await getProject(second.id)).toBeUndefined();
  });
});
