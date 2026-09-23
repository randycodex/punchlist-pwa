import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, getProject, saveProjectPreserveTimestamps } from '@/lib/db';
import { serializeProjectPayload } from '@/lib/projectPayload';

const { listProjectFilesMock, downloadProjectFileMock, uploadProjectFileMock, deleteDriveItemMock } = vi.hoisted(() => ({
  listProjectFilesMock: vi.fn(),
  downloadProjectFileMock: vi.fn(),
  uploadProjectFileMock: vi.fn(),
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
  deleteDriveItem: deleteDriveItemMock,
}));

import { backupProjectsToOneDrive, mergePersonalProjectsFromOneDrive, restoreMissingProjectsFromOneDrive } from '@/lib/oneDriveSync';

describe('OneDrive and team project identity', () => {
  beforeEach(() => {
    listProjectFilesMock.mockReset().mockResolvedValue([]);
    downloadProjectFileMock.mockReset();
    uploadProjectFileMock.mockReset();
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
