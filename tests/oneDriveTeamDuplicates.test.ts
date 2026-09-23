import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, getProject, saveProjectPreserveTimestamps } from '@/lib/db';
import { serializeProjectPayload } from '@/lib/projectPayload';

const { listProjectFilesMock, downloadProjectFileMock, uploadProjectFileMock } = vi.hoisted(() => ({
  listProjectFilesMock: vi.fn(),
  downloadProjectFileMock: vi.fn(),
  uploadProjectFileMock: vi.fn(),
}));

vi.mock('@/lib/oneDrive', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/oneDrive')>(),
  acquireSyncLease: async () => async () => {},
  ensurePunchListFolders: async () => {},
  listProjectFiles: listProjectFilesMock,
  downloadProjectFile: downloadProjectFileMock,
  listPhotoProjectFolders: async () => [],
  uploadProjectFile: uploadProjectFileMock,
}));

import { backupProjectsToOneDrive, restoreMissingProjectsFromOneDrive } from '@/lib/oneDriveSync';

describe('OneDrive and team project identity', () => {
  beforeEach(() => {
    listProjectFilesMock.mockReset().mockResolvedValue([]);
    downloadProjectFileMock.mockReset();
    uploadProjectFileMock.mockReset();
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
