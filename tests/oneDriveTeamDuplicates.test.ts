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
  saveProjectMetadataOnly,
  saveAreaNotes,
} from '@/lib/db';
import { serializeProjectPayload } from '@/lib/projectPayload';

const { getProjectFileMetadataInFolderMock, listProjectFilesMock, listPhotoProjectFoldersMock, listProjectPhotoFilesMock, downloadProjectFileMock, downloadDriveItemAsDataUrlMock, uploadProjectFileMock, uploadProjectPhotoFileMock, deleteDriveItemMock, moveDriveItemToFolderMock, downloadDeletionLogMock, uploadDeletionLogMock, deleteProjectFolderFromStateMock, deleteProjectPhotoFolderMock } = vi.hoisted(() => ({
  getProjectFileMetadataInFolderMock: vi.fn(),
  listProjectFilesMock: vi.fn(),
  listPhotoProjectFoldersMock: vi.fn(),
  listProjectPhotoFilesMock: vi.fn(),
  downloadProjectFileMock: vi.fn(),
  downloadDriveItemAsDataUrlMock: vi.fn(),
  uploadProjectFileMock: vi.fn(),
  uploadProjectPhotoFileMock: vi.fn(),
  deleteDriveItemMock: vi.fn(),
  moveDriveItemToFolderMock: vi.fn(),
  downloadDeletionLogMock: vi.fn(),
  uploadDeletionLogMock: vi.fn(),
  deleteProjectFolderFromStateMock: vi.fn(),
  deleteProjectPhotoFolderMock: vi.fn(),
}));

vi.mock('@/lib/oneDrive', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/oneDrive')>(),
  acquireSyncLease: async (token: string) => Object.assign(async () => {}, { token }),
  ensurePunchListFolders: async () => {},
  listProjectFiles: listProjectFilesMock,
  downloadProjectFile: downloadProjectFileMock,
  downloadDriveItemAsDataUrl: downloadDriveItemAsDataUrlMock,
  listPhotoProjectFolders: listPhotoProjectFoldersMock,
  listProjectPhotoFiles: listProjectPhotoFilesMock,
  uploadProjectFile: uploadProjectFileMock,
  getProjectFileMetadataInFolder: getProjectFileMetadataInFolderMock,
  uploadProjectPhotoFile: uploadProjectPhotoFileMock,
  deleteDriveItem: deleteDriveItemMock,
  moveDriveItemToFolder: moveDriveItemToFolderMock,
  downloadDeletionLog: downloadDeletionLogMock,
  uploadDeletionLog: uploadDeletionLogMock,
  deleteProjectFolderFromState: deleteProjectFolderFromStateMock,
  deleteProjectPhotoFolder: deleteProjectPhotoFolderMock,
}));

import { backupProjectsToOneDrive, markProjectDeleted, mergePersonalProjectsFromOneDrive, restoreMissingProjectsFromOneDrive, hydrateProjectMediaFromOneDrive, syncProjectsWithOneDrive } from '@/lib/oneDriveSync';

describe('OneDrive and team project identity', () => {
  it('refreshes a clean personal copy from another browser without uploading or forcing a backup', async () => {
    const project = createProject('Cross browser personal');
    project.areas = [createArea(project.id, 'Room', 0)];
    await saveProjectPreserveTimestamps(project);
    const remote = structuredClone(project);
    remote.areas[0].notes = 'Written in the other browser';
    remote.updatedAt = remote.areas[0].updatedAt = new Date(project.updatedAt.getTime() + 10000);
    listProjectFilesMock.mockResolvedValue([{ id: 'cross-browser', name: `Cross-browser-personal_${project.id}.json` }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(remote));
    const result = await mergePersonalProjectsFromOneDrive('test-token', [project.id], { canApply: () => true });
    expect(result.updatedLocalProjectIds).toEqual([project.id]);
    expect((await getProject(project.id))!.areas[0].notes).toBe('Written in the other browser');
    expect(uploadProjectFileMock).not.toHaveBeenCalled();
  });

  it('does not apply a personal download after navigation changes during transfer', async () => {
    const project = createProject('Navigation during sync');
    project.areas = [createArea(project.id, 'Room', 0)];
    await saveProjectPreserveTimestamps(project);
    const remote = structuredClone(project);
    remote.areas[0].notes = 'Cloud edit';
    remote.updatedAt = remote.areas[0].updatedAt = new Date(project.updatedAt.getTime() + 10000);
    listProjectFilesMock.mockResolvedValue([{ id: 'navigation', name: `Navigation-during-sync_${project.id}.json` }]);
    let canApply = true;
    downloadProjectFileMock.mockImplementation(async () => { canApply = false; return serializeProjectPayload(remote); });
    expect((await mergePersonalProjectsFromOneDrive('test-token', [project.id], { canApply: () => canApply })).updatedLocalProjectIds).toEqual([]);
    expect((await getProject(project.id))!.areas[0].notes).toBe('');
  });

  it('downloads missing personal copies without performing permanent deletion cleanup', async () => {
    const deleted = createProject('Deleted personal');
    deleted.updatedAt = new Date('2026-07-01');
    await saveProjectPreserveTimestamps(deleted);
    const missing = createProject('Other browser project');
    listProjectFilesMock.mockResolvedValue([
      { id: 'deleted-file', name: `Deleted-personal_${deleted.id}.json` },
      { id: 'missing-file', name: `Other-browser-project_${missing.id}.json` },
    ]);
    downloadDeletionLogMock.mockResolvedValue({ [deleted.id]: { scope: 'personal', updatedAt: '2026-07-02T00:00:00Z' } });
    downloadProjectFileMock.mockImplementation(async (_token, id) => serializeProjectPayload(id === 'deleted-file' ? deleted : missing));
    const result = await restoreMissingProjectsFromOneDrive('test-token', { downloadOnly: true, canApply: () => true });
    expect(result.restoredProjectIds).toContain(missing.id);
    expect(await getProject(deleted.id)).toBeDefined();
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
    expect(uploadDeletionLogMock).not.toHaveBeenCalled();
  });

  it('guards the older full-sync entry point against a project appearing during download', async () => {
    const backup = createProject('Legacy download race');
    listProjectFilesMock.mockResolvedValue([{ id: 'legacy-download', name: `Legacy-download-race_${backup.id}.json` }]);
    downloadProjectFileMock.mockImplementationOnce(async () => {
      await saveProjectPreserveTimestamps({ ...backup, projectName: 'Newer local copy' });
      return serializeProjectPayload(backup);
    });
    await expect(syncProjectsWithOneDrive('test-token')).rejects.toThrow('Local work changed');
    expect((await getProject(backup.id))!.projectName).toBe('Newer local copy');
    expect(uploadProjectFileMock).not.toHaveBeenCalled();
  });

  it('rejects a personal backup whose payload ID disagrees with its filename', async () => {
    const local = createProject('Expected project');
    await saveProjectPreserveTimestamps(local);
    const unrelated = createProject('Different project in wrong file');
    listProjectFilesMock.mockResolvedValue([{ id: 'wrong-payload', name: `Expected-project_${local.id}.json` }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(unrelated));
    await expect(mergePersonalProjectsFromOneDrive('test-token', [local.id])).rejects.toThrow('does not match its filename');
    expect((await getProject(local.id))!.projectName).toBe('Expected project');
    expect(await getProject(unrelated.id)).toBeUndefined();
  });

  it('does not overwrite a project created locally while its missing backup downloads', async () => {
    const backup = createProject('Missing backup race');
    listProjectFilesMock.mockResolvedValue([{ id: 'missing-backup-race', name: `Missing-backup-race_${backup.id}.json` }]);
    downloadProjectFileMock.mockImplementationOnce(async () => {
      await saveProjectPreserveTimestamps({ ...backup, projectName: 'Created locally during restore' });
      return serializeProjectPayload(backup);
    });
    const result = await restoreMissingProjectsFromOneDrive('test-token');
    expect(result.restoredProjectIds).not.toContain(backup.id);
    expect(result.failedProjects).toEqual([expect.objectContaining({ id: backup.id, message: expect.stringContaining('created or changed') })]);
    expect((await getProject(backup.id))!.projectName).toBe('Created locally during restore');
  });

  it('does not replace a concurrent local note with a personal cloud merge', async () => {
    const project = createProject('Personal merge race');
    const area = createArea(project.id, 'Room', 0);
    project.areas.push(area);
    await saveProjectPreserveTimestamps(project);
    const remote = structuredClone(project);
    remote.areas[0].notes = 'Cloud note';
    remote.areas[0].updatedAt = new Date(project.updatedAt.getTime() + 10000);
    remote.updatedAt = remote.areas[0].updatedAt;
    listProjectFilesMock.mockResolvedValue([{ id: 'personal-merge', name: `Personal-merge-race_${project.id}.json` }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(remote));
    listPhotoProjectFoldersMock.mockImplementationOnce(async () => {
      await saveAreaNotes(project.id, area.id, 'Local note during cloud merge');
      return [];
    });
    await expect(mergePersonalProjectsFromOneDrive('test-token', [project.id])).rejects.toThrow('Local work changed');
    expect((await getProject(project.id))!.areas[0].notes).toBe('Local note during cloud merge');
  });

  it('preserves notes saved while OneDrive media is loading', async () => {
    const project = createProject('Photo recovery race');
    const area = createArea(project.id, 'Room', 0);
    project.areas.push(area);
    await saveProjectPreserveTimestamps(project);
    listPhotoProjectFoldersMock.mockImplementationOnce(async () => {
      await saveAreaNotes(project.id, area.id, 'Saved while loading photos');
      return [];
    });
    await expect(hydrateProjectMediaFromOneDrive('test-token', project.id)).rejects.toThrow('Local work changed');
    expect((await getProject(project.id))!.areas[0].notes).toBe('Saved while loading photos');
  });

  beforeEach(() => {
    getProjectFileMetadataInFolderMock.mockReset().mockResolvedValue(null);
    listProjectFilesMock.mockReset().mockResolvedValue([]);
    listPhotoProjectFoldersMock.mockReset().mockResolvedValue([]);
    listProjectPhotoFilesMock.mockReset().mockResolvedValue([]);
    downloadProjectFileMock.mockReset();
    downloadDriveItemAsDataUrlMock.mockReset();
    uploadProjectFileMock.mockReset();
    uploadProjectPhotoFileMock.mockReset().mockResolvedValue(undefined);
    deleteDriveItemMock.mockReset().mockResolvedValue(undefined);
    moveDriveItemToFolderMock.mockReset().mockResolvedValue({ id: 'moved-photo' });
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

  it('keeps a malformed deletion-era backup for review while restoring another project', async () => {
    const malformed = createProject('Older damaged copy');
    const valid = createProject('Restorable copy');
    await saveProjectPreserveTimestamps(malformed);
    downloadDeletionLogMock.mockResolvedValue({
      [malformed.id]: { updatedAt: new Date(Date.now() + 60_000).toISOString(), scope: 'personal' },
    });
    listProjectFilesMock.mockResolvedValue([
      { id: 'damaged-file', name: `Older-damaged-copy_${malformed.id}.json` },
      { id: 'valid-file', name: `Restorable-copy_${valid.id}.json` },
    ]);
    downloadProjectFileMock.mockImplementation(async (_token: string, id: string) =>
      id === 'damaged-file'
        ? JSON.stringify({ payloadVersion: 1, project: { ...malformed, areas: 'broken' } })
        : serializeProjectPayload(valid)
    );

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect(result.restoredProjectIds).toContain(valid.id);
    expect(result.failedProjects).toEqual([expect.objectContaining({
      id: malformed.id,
      message: expect.stringContaining('project.areas must be an array'),
    })]);
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
    expect((await getProject(malformed.id))?.projectName).toBe('Older damaged copy');
    expect(await getProject(valid.id)).toBeDefined();
  });

  it('restores both legacy sibling checkpoints and their shared OneDrive photo bytes', async () => {
    const backup = createProject('Legacy restore');
    const area = createArea(backup.id, 'Unit 1', 0);
    const location = createLocation(area.id, 'Kitchen', 0);
    const item = createItem(location.id, 'Appliances', 0);
    const checkpoint = createCheckpoint(item.id, 'Refrigerator', 0);
    const photo = createPhotoAttachment(checkpoint.id, '');
    checkpoint.photos.push(photo);
    const sibling = structuredClone(checkpoint);
    sibling.name = 'Yes/No';
    item.checkpoints.push(checkpoint, sibling);
    location.items.push(item);
    area.locations.push(location);
    backup.areas.push(area);
    listProjectFilesMock.mockResolvedValue([{ id: 'legacy-file', name: `Legacy-restore_${backup.id}.json` }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(backup));
    listPhotoProjectFoldersMock.mockResolvedValue([{ id: 'photo-folder', name: 'Legacy-restore' }]);
    listProjectPhotoFilesMock.mockResolvedValue([{ id: 'photo-file', name: `legacy_${photo.id}.jpg` }]);
    downloadDriveItemAsDataUrlMock.mockResolvedValue('data:image/jpeg;base64,cGhvdG8=');

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect(result.failedProjects).toEqual([]);
    expect(result.restoredProjectIds).toContain(backup.id);
    const checkpoints = (await getProject(backup.id))!.areas[0].locations[0].items[0].checkpoints;
    expect(checkpoints.map((entry) => entry.name)).toEqual(['Refrigerator', 'Yes/No']);
    expect(checkpoints[0].id).not.toBe(checkpoints[1].id);
    expect(checkpoints[0].photos[0].id).not.toBe(checkpoints[1].photos[0].id);
    expect(checkpoints.map((entry) => entry.photos[0].imageData)).toEqual([
      'data:image/jpeg;base64,cGhvdG8=', 'data:image/jpeg;base64,cGhvdG8=',
    ]);
    expect(downloadDriveItemAsDataUrlMock).toHaveBeenCalledTimes(2);

    const missingPhotoBackup = structuredClone(backup);
    missingPhotoBackup.id = crypto.randomUUID();
    missingPhotoBackup.areas[0].projectId = missingPhotoBackup.id;
    listProjectFilesMock.mockResolvedValue([{ id: 'legacy-missing-photo', name: `Legacy-restore_${missingPhotoBackup.id}.json` }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(missingPhotoBackup));
    listPhotoProjectFoldersMock.mockResolvedValue([]);
    const missingPhotoResult = await restoreMissingProjectsFromOneDrive('test-token');
    expect(missingPhotoResult.failedProjects).toEqual([expect.objectContaining({
      id: missingPhotoBackup.id,
      message: expect.stringContaining('older OneDrive backup is missing'),
    })]);
    expect(await getProject(missingPhotoBackup.id)).toBeUndefined();
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

  it.each([true, false])('preserves work appearing during permanent deletion review (already present: %s)', async (alreadyPresent) => {
    const project = createProject('Deletion race');
    if (alreadyPresent) await saveProjectPreserveTimestamps(project);
    downloadDeletionLogMock.mockResolvedValue({
      [project.id]: { updatedAt: new Date(Date.now() + 60_000).toISOString(), scope: 'personal' },
    });
    listProjectFilesMock.mockResolvedValue([{
      id: 'deletion-race-file', name: `Deletion_race_${project.id}.json`,
      lastModifiedDateTime: project.updatedAt.toISOString(),
    }]);
    downloadProjectFileMock.mockImplementationOnce(async () => {
      // Same timestamp deliberately: safety must compare the record, not clocks.
      await saveProjectPreserveTimestamps({ ...project, projectName: 'New field work' });
      return serializeProjectPayload(project);
    });

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect((await getProject(project.id))?.projectName).toBe('New field work');
    expect(result.permanentlyDeletedProjectNames).toEqual([]);
    expect(result.failedProjects?.[0]?.message).toContain('changed while its deletion');
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
    expect(deleteProjectFolderFromStateMock).not.toHaveBeenCalled();
    expect(deleteProjectPhotoFolderMock).not.toHaveBeenCalled();
  });

  it('does not delete a backup whose payload belongs to a different project', async () => {
    const local = createProject('Expected deletion target');
    const other = createProject('Different backup');
    await saveProjectPreserveTimestamps(local);
    downloadDeletionLogMock.mockResolvedValue({
      [local.id]: { updatedAt: new Date(Date.now() + 60_000).toISOString(), scope: 'personal' },
    });
    listProjectFilesMock.mockResolvedValue([{ id: 'wrong-payload', name: `Expected_${local.id}.json` }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(other));

    const result = await restoreMissingProjectsFromOneDrive('test-token');

    expect(await getProject(local.id)).toBeDefined();
    expect(result.failedProjects?.[0]?.message).toContain('ID does not match');
    expect(result.permanentlyDeletedProjectNames).toEqual([]);
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
    expect(deleteProjectPhotoFolderMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not overwrite another project payload during backup (trashed: %s)', async (trashed) => {
    const local = createProject('Expected backup');
    if (trashed) local.deletedAt = new Date();
    await saveProjectPreserveTimestamps(local);
    const other = createProject('Unrelated backup');
    other.updatedAt = new Date(0);
    listProjectFilesMock.mockResolvedValue([{ id: 'wrong-payload', name: `Expected_${local.id}.json` }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(other));

    const result = await backupProjectsToOneDrive('test-token', [local.id]);

    expect(result.failedProjects?.[0]?.message).toContain('ID does not match');
    expect(result.backedUpProjectIds).toEqual([]);
    expect(uploadProjectFileMock).not.toHaveBeenCalled();
    expect(uploadProjectPhotoFileMock).not.toHaveBeenCalled();
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
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

  it('backs up a team project without making its OneDrive copy eligible for personal restore', async () => {
    const team = createProject('Alafia');
    team.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(team);
    uploadProjectFileMock.mockResolvedValue({ id: 'team-backup' });

    const result = await backupProjectsToOneDrive('test-token', [team.id]);

    expect(result.backedUpProjectIds).toEqual([team.id]);
    const payload = uploadProjectFileMock.mock.calls[0][3];
    expect(payload).toContain(team.sharedProjectId);
    await deleteProject(team.id);
    listProjectFilesMock.mockResolvedValue([{ id: 'team-backup', name: `Alafia_${team.id}.json` }]);
    downloadProjectFileMock.mockResolvedValue(payload);
    const restored = await restoreMissingProjectsFromOneDrive('test-token');
    expect(restored.restoredProjectIds).toEqual([]);
    expect(restored.skippedProjectIds).toContain(team.id);
    expect(await getProject(team.id)).toBeUndefined();
  });

  it('preserves a newer team backup while saving an independent device snapshot', async () => {
    const team = createProject('Alafia');
    team.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(team);
    const remote = { ...team, projectName: 'Newer team backup', updatedAt: new Date(team.updatedAt.getTime() + 60_000) };
    listProjectFilesMock.mockResolvedValue([{ id: 'team-backup', name: `Alafia_${team.id}.json` }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(remote));
    uploadProjectFileMock.mockResolvedValue({ id: 'device-snapshot' });

    const result = await backupProjectsToOneDrive('test-token', [team.id]);
    expect(result.conflicts).toEqual([]);
    expect(result.failedProjects).toEqual([]);
    expect(result.backedUpProjectIds).toEqual([team.id]);
    expect(uploadProjectFileMock).toHaveBeenCalledWith(
      'test-token', expect.stringMatching(/^Team Backups\//), expect.stringContaining(team.id),
      expect.stringContaining(team.sharedProjectId), false, undefined, 'fail'
    );
    await mergePersonalProjectsFromOneDrive('test-token', [team.id]);
    await restoreMissingProjectsFromOneDrive('test-token');
    expect((await getProject(team.id))?.projectName).toBe('Alafia');
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
  });

  it('retains the OneDrive backup when a team copy is archived on this device', async () => {
    const team = createProject('Alafia');
    team.sharedProjectId = crypto.randomUUID();
    team.deletedAt = new Date();
    await saveProjectPreserveTimestamps(team);
    listProjectFilesMock.mockResolvedValue([{ id: 'team-backup', name: `Alafia_${team.id}.json` }]);
    const result = await backupProjectsToOneDrive('test-token', [team.id]);
    expect(result.backedUpProjectIds).toEqual([]);
    expect(uploadProjectFileMock).not.toHaveBeenCalled();
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
    expect(deleteProjectFolderFromStateMock).not.toHaveBeenCalled();
  });

  it('keeps both devices and earlier snapshots, and reuses an unchanged snapshot', async () => {
    const team = createProject('Alafia');
    team.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(team);
    const snapshots = new Map<string, string>();
    getProjectFileMetadataInFolderMock.mockImplementation(async (_token: string, folder: string, name: string) => {
      const path = `${folder}/${name}`;
      return snapshots.has(path) ? { id: path } : null;
    });
    downloadProjectFileMock.mockImplementation(async (_token: string, id: string) => snapshots.get(id));
    uploadProjectFileMock.mockImplementation(async (_token: string, folder: string, name: string, content: string, _trash: boolean, _etag: undefined, behavior: string) => {
      expect(behavior).toBe('fail');
      const path = `${folder}/${name}`;
      expect(snapshots.has(path)).toBe(false);
      snapshots.set(path, content);
      return { id: path };
    });

    for (let repeat = 0; repeat < 2; repeat += 1) {
      expect((await backupProjectsToOneDrive('test-token', [team.id])).backedUpProjectIds).toEqual([team.id]);
    }
    expect(uploadProjectFileMock).toHaveBeenCalledTimes(1);
    const firstPath = [...snapshots.keys()][0];
    const firstContent = snapshots.get(firstPath);
    const updatedTeam = { ...team, address: 'Updated address', updatedAt: new Date(team.updatedAt.getTime() + 10000) };
    await saveProjectPreserveTimestamps(updatedTeam);
    await backupProjectsToOneDrive('test-token', [team.id]);
    const deviceOneFolder = uploadProjectFileMock.mock.calls[0][1];
    expect(uploadProjectFileMock.mock.calls[1][1]).toBe(deviceOneFolder);

    localStorage.setItem('punchlist:collaboration-device-id', crypto.randomUUID());
    await backupProjectsToOneDrive('test-token', [team.id]);
    expect(uploadProjectFileMock.mock.calls[2][1]).not.toBe(deviceOneFolder);
    expect(snapshots.size).toBe(3);
    expect(snapshots.get(firstPath)).toBe(firstContent);
    for (const [path, content] of snapshots) {
      const payload = JSON.parse(content);
      expect(path).toContain(payload.oneDriveBackup.deviceId);
      expect(payload.oneDriveBackup.photosPath).toBe(`PunchList/${path.slice(0, path.lastIndexOf('/'))}/photos`);
      expect(payload.project.sharedProjectId).toBe(team.sharedProjectId);
    }
    expect((await getProject(team.id))?.oneDriveFolderName).toBe(team.oneDriveFolderName);
    expect(listProjectFilesMock).not.toHaveBeenCalled();
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
  });

  it.each(['network', 'timeout'])('recognizes a saved snapshot after losing the upload response: %s', async (failure) => {
    const team = createProject('Lost response');
    team.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(team);
    let savedContent: string | undefined;
    getProjectFileMetadataInFolderMock.mockImplementation(async () => savedContent ? { id: 'saved-snapshot' } : null);
    downloadProjectFileMock.mockImplementation(async () => savedContent);
    uploadProjectFileMock.mockImplementationOnce(async (_token: string, _folder: string, _name: string, content: string) => {
      savedContent = content;
      throw failure === 'timeout' ? new DOMException('Request timed out', 'TimeoutError') : new TypeError('Failed to fetch');
    });
    const result = await backupProjectsToOneDrive('test-token', [team.id]);
    expect(result.backedUpProjectIds).toEqual([team.id]);
    expect(result.failedProjects).toEqual([]);
    expect(uploadProjectFileMock).toHaveBeenCalledTimes(1);
  });

  it.each([409, 412])('retries a rejected snapshot upload safely: HTTP %i', async (status) => {
    const team = createProject('Upload race');
    team.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(team);
    uploadProjectFileMock.mockRejectedValueOnce(Object.assign(new Error('Upload conflict'), { status }))
      .mockResolvedValue({ id: 'snapshot' });
    const result = await backupProjectsToOneDrive('test-token', [team.id]);
    expect(result.backedUpProjectIds).toEqual([team.id]);
    expect(result.conflicts).toEqual([]);
    expect(uploadProjectFileMock).toHaveBeenCalledTimes(2);
    expect(uploadProjectFileMock.mock.calls[0]).toEqual(uploadProjectFileMock.mock.calls[1]);
    expect(uploadProjectFileMock.mock.calls[1][6]).toBe('fail');
  });

  it('bounds repeated snapshot rejections and leaves the backup incomplete', async () => {
    const team = createProject('Persistent rejection');
    team.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(team);
    uploadProjectFileMock.mockRejectedValue(Object.assign(new Error('Upload conflict'), { status: 409 }));
    const result = await backupProjectsToOneDrive('test-token', [team.id]);
    expect(uploadProjectFileMock).toHaveBeenCalledTimes(3);
    expect(result.backedUpProjectIds).toEqual([]);
    expect(result.failedProjects).toEqual([expect.objectContaining({ id: team.id, message: expect.stringContaining('three attempts') })]);
  });

  it('preserves a modified snapshot instead of overwriting it', async () => {
    const team = createProject('Modified snapshot');
    team.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(team);
    getProjectFileMetadataInFolderMock.mockResolvedValue({ id: 'modified-snapshot' });
    downloadProjectFileMock.mockResolvedValue('Externally modified contents');
    const result = await backupProjectsToOneDrive('test-token', [team.id]);
    expect(uploadProjectFileMock).not.toHaveBeenCalled();
    expect(result.backedUpProjectIds).toEqual([]);
    expect(result.failedProjects).toEqual([expect.objectContaining({ message: expect.stringContaining('preserved') })]);
  });

  it('does not retry a permission rejection as an upload race', async () => {
    const team = createProject('Permission rejection');
    team.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(team);
    uploadProjectFileMock.mockRejectedValue(Object.assign(new Error('Access denied'), { status: 403 }));
    const result = await backupProjectsToOneDrive('test-token', [team.id]);
    expect(uploadProjectFileMock).toHaveBeenCalledTimes(1);
    expect(result.failedProjects).toEqual([expect.objectContaining({ message: 'Access denied' })]);
  });

  it('does not write a personal file if the team link changes after backup selection', async () => {
    const team = createProject('Team link race');
    team.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(team);
    const database = await import('@/lib/db');
    const originalGetProject = database.getProject;
    const read = vi.spyOn(database, 'getProject').mockImplementationOnce(async (id) => {
      const project = await originalGetProject(id);
      return project ? { ...project, sharedProjectId: undefined } : project;
    });
    try {
      const result = await backupProjectsToOneDrive('test-token', [team.id]);
      expect(result.backedUpProjectIds).toEqual([]);
      expect(result.failedProjects).toEqual([expect.objectContaining({ message: expect.stringContaining('team link changed') })]);
      expect(uploadProjectFileMock).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('keeps each device photo folder independent and publishes JSON after its photos', async () => {
    const team = createProject('Alafia photos');
    team.sharedProjectId = crypto.randomUUID();
    const area = createArea(team.id, 'Room', 0);
    const location = createLocation(area.id, 'Kitchen', 0);
    const item = createItem(location.id, 'Window', 0);
    const checkpoint = createCheckpoint(item.id, 'Finish', 0);
    checkpoint.photos.push(createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8='));
    item.checkpoints.push(checkpoint);
    location.items.push(item);
    area.locations.push(location);
    team.areas.push(area);
    await saveProjectPreserveTimestamps(team);
    const photoFolders = new Map<string, Array<{ id: string; name: string }>>();
    listProjectPhotoFilesMock.mockImplementation(async (_token: string, folder: string) => photoFolders.get(folder) ?? []);
    uploadProjectPhotoFileMock.mockImplementation(async (_token: string, folder: string, name: string, bytes: Blob) => {
      expect(await bytes.text()).toBe('photo');
      photoFolders.set(folder, [{ id: `photo-${folder}`, name }]);
    });
    uploadProjectFileMock.mockImplementation(async (_token: string, folder: string, _name: string, content: string) => {
      const payload = JSON.parse(content);
      expect(photoFolders.get(folder)?.[0].name).toContain(payload.project.areas[0].locations[0].items[0].checkpoints[0].photos[0].id);
      return { id: 'snapshot' };
    });
    await backupProjectsToOneDrive('test-token', [team.id]);
    await backupProjectsToOneDrive('test-token', [team.id]);
    expect(uploadProjectPhotoFileMock).toHaveBeenCalledTimes(1);
    localStorage.setItem('punchlist:collaboration-device-id', crypto.randomUUID());
    await backupProjectsToOneDrive('test-token', [team.id]);
    expect(uploadProjectPhotoFileMock).toHaveBeenCalledTimes(2);
    expect(photoFolders.size).toBe(2);
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
  });

  it('still protects a newer personal backup and identifies that cause', async () => {
    const personal = createProject('Personal project');
    await saveProjectPreserveTimestamps(personal);
    listProjectFilesMock.mockResolvedValue([{ id: 'newer-personal', name: `Personal-project_${personal.id}.json` }]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload({ ...personal, updatedAt: new Date(personal.updatedAt.getTime() + 60000) }));
    const result = await backupProjectsToOneDrive('test-token', [personal.id]);
    expect(result.conflicts).toEqual([{ id: personal.id, name: personal.projectName, reason: 'newer-backup' }]);
    expect(uploadProjectFileMock).not.toHaveBeenCalled();
  });

  it.each([{ hasArea: false, team: false }, { hasArea: true, team: false }, { hasArea: false, team: true }, { hasArea: true, team: true }])('backs up Alafia before any inspection: %j', async ({ hasArea, team }) => {
    const project = createProject('Alafia');
    if (team) project.sharedProjectId = crypto.randomUUID();
    if (hasArea) project.areas.push(createArea(project.id, 'Uninspected area', 0));
    await saveProjectMetadataOnly(project);
    uploadProjectFileMock.mockResolvedValue({ id: 'alafia-backup' });

    const result = await backupProjectsToOneDrive('test-token', [project.id]);

    expect(result.failedProjects).toEqual([]);
    expect(result.backedUpProjectIds).toEqual([project.id]);
    expect(uploadProjectFileMock).toHaveBeenCalledWith(
      'test-token', expect.stringContaining('Alafia'), expect.stringContaining(project.id),
      expect.stringContaining('Alafia'), false, undefined, ...(team ? ['fail'] : [])
    );
    expect(uploadProjectPhotoFileMock).not.toHaveBeenCalled();
  });

  it.each([
    { state: 'missing', team: false }, { state: 'upload-failed', team: false }, { state: 'available', team: false },
    { state: 'missing', team: true }, { state: 'upload-failed', team: true }, { state: 'available', team: true },
  ])(
    'publishes project references only after photos are available: %j', async ({ state, team }) => {
      const project = createProject('Photo safety');
      if (team) project.sharedProjectId = crypto.randomUUID();
      const area = createArea(project.id, 'Room', 0);
      const location = createLocation(area.id, 'Kitchen', 0);
      const item = createItem(location.id, 'Window', 0);
      const checkpoint = createCheckpoint(item.id, 'Finish', 0);
      checkpoint.photos.push(createPhotoAttachment(checkpoint.id,
        state === 'missing' ? '' : 'data:image/jpeg;base64,cGhvdG8='));
      item.checkpoints.push(checkpoint);
      location.items.push(item);
      area.locations.push(location);
      project.areas.push(area);
      await saveProjectPreserveTimestamps(project);
      uploadProjectFileMock.mockResolvedValue({ id: 'project-upload' });
      if (state === 'upload-failed') uploadProjectPhotoFileMock.mockRejectedValue(new Error('Upload failed'));

      const result = await backupProjectsToOneDrive('test-token', [project.id]);

      if (state === 'available') {
        expect(result.backedUpProjectIds).toEqual([project.id]);
        expect(uploadProjectPhotoFileMock.mock.invocationCallOrder[0])
          .toBeLessThan(uploadProjectFileMock.mock.invocationCallOrder[0]);
      } else {
        expect(result.backedUpProjectIds).toEqual([]);
        expect(result.failedProjects).toEqual([expect.objectContaining({ id: project.id })]);
        expect(uploadProjectFileMock).not.toHaveBeenCalled();
        expect((await getProject(project.id))?.oneDriveFolderName).toBe(project.oneDriveFolderName);
      }
    }
  );

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
    expect(uploadProjectPhotoFileMock).toHaveBeenCalledWith(
      'test-token', `Photo-project_${project.id}`, expect.stringContaining(checkpoint.photos[0].id),
      expect.any(Blob), false
    );
  });

  it('separates a personal backup from a mixed folder after verifying its photos', async () => {
    const personal = createProject('Ilse Hoffman House - K&J (Kwassi)');
    personal.oneDriveFolderName = 'Ilse-Hoffman-House';
    const area = createArea(personal.id, 'Unit 1', 0);
    const location = createLocation(area.id, 'Kitchen', 0);
    const item = createItem(location.id, 'Window', 0);
    const checkpoint = createCheckpoint(item.id, 'Finish', 0);
    const photo = createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8=');
    checkpoint.photos.push(photo);
    item.checkpoints.push(checkpoint);
    location.items.push(item);
    area.locations.push(location);
    personal.areas.push(area);
    await saveProjectPreserveTimestamps(personal);

    const historical = createProject('Ilse Hoffman House');
    const filename = `Ilse-Hoffman-House-K-J-Kwassi_${personal.id}.json`;
    const oldPhotoName = `Ilse-Hoffman-House-K-J-Kwassi_Unit-1_001_${photo.id}.jpg`;
    const newFolder = `Ilse-Hoffman-House-K-J-Kwassi_${personal.id}`;
    const remotePhotos: Array<{ id: string; name: string }> = [];
    listProjectFilesMock.mockResolvedValue([
      { id: 'old-personal', name: filename, punchlistPath: `PunchList/Ilse-Hoffman-House/${filename}` },
      { id: 'historical', name: `Ilse-Hoffman-House_${historical.id}.json`, punchlistPath: `PunchList/Ilse-Hoffman-House/Ilse-Hoffman-House_${historical.id}.json` },
    ]);
    downloadProjectFileMock.mockImplementation(async (_token: string, id: string) =>
      serializeProjectPayload(id === 'historical' ? historical : personal)
    );
    listPhotoProjectFoldersMock.mockResolvedValue([{ id: 'old-folder', name: 'Ilse-Hoffman-House' }]);
    listProjectPhotoFilesMock.mockImplementation(async (_token: string, folder: string) =>
      folder === newFolder ? remotePhotos : [{ id: 'old-photo', name: oldPhotoName }]
    );
    uploadProjectPhotoFileMock.mockImplementation(async (_token: string, _folder: string, name: string) => {
      remotePhotos.push({ id: 'new-photo', name });
    });
    uploadProjectFileMock.mockResolvedValue({ id: 'new-personal' });

    const result = await backupProjectsToOneDrive('test-token', [personal.id]);

    expect(result.failedProjects).toEqual([]);
    expect(result.backedUpProjectIds).toContain(personal.id);
    expect(uploadProjectFileMock).toHaveBeenCalledWith(
      'test-token', newFolder, filename, expect.any(String), false, undefined
    );
    expect(moveDriveItemToFolderMock).toHaveBeenCalledWith(
      'test-token', 'old-photo', `PunchList/${newFolder}/photos/previous`
    );
    expect(deleteDriveItemMock).toHaveBeenCalledWith('test-token', 'old-personal');
    expect(deleteDriveItemMock).not.toHaveBeenCalledWith('test-token', 'historical');
    expect(uploadProjectPhotoFileMock.mock.invocationCallOrder[0])
      .toBeLessThan(uploadProjectFileMock.mock.invocationCallOrder[0]);
    expect(uploadProjectFileMock.mock.invocationCallOrder[0])
      .toBeLessThan(moveDriveItemToFolderMock.mock.invocationCallOrder[0]);
    expect((await getProject(personal.id))?.oneDriveFolderName).toBe(newFolder);
  });

  it('keeps the mixed-folder backup if the new photo cannot be verified', async () => {
    const personal = createProject('Ilse Hoffman House - K&J (Kwassi)');
    personal.oneDriveFolderName = 'Ilse-Hoffman-House';
    const area = createArea(personal.id, 'Unit 1', 0);
    const location = createLocation(area.id, 'Kitchen', 0);
    const item = createItem(location.id, 'Window', 0);
    const checkpoint = createCheckpoint(item.id, 'Finish', 0);
    checkpoint.photos.push(createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8='));
    item.checkpoints.push(checkpoint);
    location.items.push(item);
    area.locations.push(location);
    personal.areas.push(area);
    await saveProjectPreserveTimestamps(personal);
    const historical = createProject('Ilse Hoffman House');
    const filename = `Ilse-Hoffman-House-K-J-Kwassi_${personal.id}.json`;
    listProjectFilesMock.mockResolvedValue([
      { id: 'old-personal', name: filename, punchlistPath: `PunchList/Ilse-Hoffman-House/${filename}` },
      { id: 'historical', name: `Ilse-Hoffman-House_${historical.id}.json`, punchlistPath: `PunchList/Ilse-Hoffman-House/Ilse-Hoffman-House_${historical.id}.json` },
    ]);
    downloadProjectFileMock.mockResolvedValue(serializeProjectPayload(personal));
    listPhotoProjectFoldersMock.mockResolvedValue([{ id: 'old-folder', name: 'Ilse-Hoffman-House' }]);
    listProjectPhotoFilesMock.mockResolvedValue([]);

    const result = await backupProjectsToOneDrive('test-token', [personal.id]);

    expect(result.failedProjects?.[0]?.message).toContain('Could not verify every photo');
    expect(uploadProjectFileMock).not.toHaveBeenCalled();
    expect(deleteDriveItemMock).not.toHaveBeenCalled();
    expect((await getProject(personal.id))?.oneDriveFolderName).toBe('Ilse-Hoffman-House');
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
