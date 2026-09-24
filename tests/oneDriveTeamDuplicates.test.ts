import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createArea,
  createCheckpoint,
  createItem,
  createLocation,
  createPhotoAttachment,
  createProject,
  getProject,
  saveProjectPreserveTimestamps,
} from '@/lib/db';
import { serializeProjectPayload } from '@/lib/projectPayload';

const { listProjectFilesMock, downloadProjectFileMock, uploadProjectFileMock, uploadProjectPhotoFileMock, deleteDriveItemMock } = vi.hoisted(() => ({
  listProjectFilesMock: vi.fn(),
  downloadProjectFileMock: vi.fn(),
  uploadProjectFileMock: vi.fn(),
  uploadProjectPhotoFileMock: vi.fn(),
  deleteDriveItemMock: vi.fn(),
}));

vi.mock('@/lib/oneDrive', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/oneDrive')>(),
  acquireSyncLease: async () => async () => {},
  ensurePunchListFolders: async () => {},
  listProjectFiles: listProjectFilesMock,
  downloadProjectFile: downloadProjectFileMock,
  listPhotoProjectFolders: async () => [],
  uploadProjectFile: uploadProjectFileMock,
  uploadProjectPhotoFile: uploadProjectPhotoFileMock,
  deleteDriveItem: deleteDriveItemMock,
}));

import { backupProjectsToOneDrive, mergePersonalProjectsFromOneDrive, restoreMissingProjectsFromOneDrive } from '@/lib/oneDriveSync';

describe('OneDrive and team project identity', () => {
  beforeEach(() => {
    listProjectFilesMock.mockReset().mockResolvedValue([]);
    downloadProjectFileMock.mockReset();
    uploadProjectFileMock.mockReset();
    uploadProjectPhotoFileMock.mockReset().mockResolvedValue(undefined);
    deleteDriveItemMock.mockReset().mockResolvedValue(undefined);
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
