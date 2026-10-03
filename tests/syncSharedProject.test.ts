import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllProjects: vi.fn(),
  getProject: vi.fn(),
  getProjectMetadata: vi.fn(),
  publishSnapshot: vi.fn(),
  getPendingAreas: vi.fn(),
  getPendingMetadata: vi.fn(),
  getMetadata: vi.fn(),
  getPendingPull: vi.fn(),
  pushChanges: vi.fn(),
  releaseClaims: vi.fn(),
  saveDownloaded: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getAllProjects: mocks.getAllProjects,
  getProject: mocks.getProject,
  getProjectMetadata: mocks.getProjectMetadata,
  getPendingSharedAreaSyncsForProject: mocks.getPendingAreas,
  getPendingSharedProjectMetadataSyncForProject: mocks.getPendingMetadata,
  acknowledgePublishedSharedProject: vi.fn(),
  captureLocalProjectSaveToken: vi.fn(async () => 'original-local-copy'),
  saveDownloadedProjectIfUnchanged: mocks.saveDownloaded,
}));
vi.mock('@/lib/collaboration', () => ({
  getSharedProjectSnapshotMetadata: mocks.getMetadata,
  hasNewerLocalChangesThanSharedSnapshot: () => false,
  isSharedSnapshotNewer: (_project: unknown, publishedAt: string) => publishedAt.endsWith('01.000Z'),
  publishSharedProjectSnapshot: mocks.publishSnapshot,
  releaseAllMySharedProjectAreaClaims: mocks.releaseClaims,
  getCollaborationErrorMessage: (error: { message?: string }) => error.message ?? 'Could not complete this team action.',
}));
vi.mock('@/features/collaboration/manualSharedPull', () => ({
  getPendingSharedPullState: mocks.getPendingPull,
}));
vi.mock('@/features/collaboration/pushQueuedSharedChanges', () => ({
  pushQueuedSharedChanges: mocks.pushChanges,
}));

import { syncSharedProject } from '@/features/sync/syncSharedProject';

const project = {
  id: 'selected-project',
  areas: [],
  sharedProjectId: 'selected-team',
  sharedSnapshotPublishedAt: new Date('2026-01-01T12:00:00.000Z'),
  updatedAt: new Date('2026-01-01T12:00:00.000Z'),
};

describe('selected shared project sync', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getProject.mockResolvedValue(project);
    mocks.getProjectMetadata.mockResolvedValue(project);
    mocks.getAllProjects.mockResolvedValue([project]);
    mocks.getPendingAreas.mockResolvedValue([]);
    mocks.getPendingMetadata.mockResolvedValue(undefined);
    mocks.getMetadata.mockResolvedValue({ publishedAt: '2026-01-01T12:00:00.000Z' });
    mocks.pushChanges.mockResolvedValue({ remainingAreaCount: 0, metadataRemaining: false });
    mocks.releaseClaims.mockResolvedValue({ releasedCount: 2 });
    mocks.saveDownloaded.mockResolvedValue(true);
  });

  it('keeps a lock blocker out of the repeated merge flow', async () => {
    mocks.pushChanges.mockResolvedValue({ remainingAreaCount: 1, lockedAreaIds: ['5B'], conflictedAreaCount: 0, metadataRemaining: false });
    await expect(syncSharedProject(project.id, 'user-1')).resolves.toMatchObject({ status: 'pending', message: expect.stringContaining('5B') });
    expect(mocks.getPendingPull).not.toHaveBeenCalled();
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('pushes and releases only the selected team project', async () => {
    await expect(syncSharedProject(project.id, 'user-1')).resolves.toEqual({ status: 'synced', releasedAreaCount: 2 });
    expect(mocks.getProjectMetadata).toHaveBeenCalledWith('selected-project');
    expect(mocks.getProject).not.toHaveBeenCalled();
    expect(mocks.pushChanges).toHaveBeenCalledOnce();
    expect(mocks.pushChanges).toHaveBeenCalledWith('selected-project');
    expect(mocks.releaseClaims).toHaveBeenCalledWith('selected-team', 'selected-project');
  });

  it('sends and releases two owned areas in a 193-area project without downloading or merging the other areas', async () => {
    const largeProject = { ...project, areas: Array.from({ length: 193 }, (_, i) => ({
      id: `area-${i}`, name: `Unit ${i}`, locations: [], sharedVersion: 1,
    })) };
    mocks.getProjectMetadata.mockResolvedValue(largeProject);
    mocks.getAllProjects.mockResolvedValue([largeProject]);
    mocks.getMetadata.mockResolvedValue({ publishedAt: '2026-01-01T12:00:01.000Z' });
    mocks.getPendingAreas.mockResolvedValue([{ areaId: 'area-2' }, { areaId: 'area-7' }]);
    mocks.pushChanges.mockImplementation(async () => {
      mocks.getPendingAreas.mockResolvedValue([]);
      return { remainingAreaCount: 0, metadataRemaining: false };
    });
    mocks.getPendingPull.mockRejectedValue(new Error('Full-project download timed out'));
    await expect(syncSharedProject(project.id, 'user-1')).resolves.toEqual({
      status: 'synced', releasedAreaCount: 2, sharedUpdatesAvailable: true,
    });
    expect(mocks.pushChanges).toHaveBeenCalledWith(project.id);
    expect(mocks.releaseClaims).toHaveBeenCalledWith('selected-team', project.id);
    expect(mocks.getPendingPull).not.toHaveBeenCalled();
    expect(mocks.saveDownloaded).not.toHaveBeenCalled();
  });

  it('loads the complete project including photos before publishing its first baseline', async () => {
    const initial = { ...project, sharedSnapshotPublishedAt: undefined };
    const full = { ...initial, projectName: 'Full media copy' };
    mocks.getProjectMetadata.mockResolvedValue(initial);
    mocks.getProject.mockResolvedValue(full);
    mocks.getMetadata.mockResolvedValue(null);
    await syncSharedProject(project.id, 'user-1');
    expect(mocks.publishSnapshot).toHaveBeenCalledWith(full, 'user-1');
    expect(mocks.pushChanges).not.toHaveBeenCalled();
  });

  it('does not let a concurrent update in another area prevent verified releases', async () => {
    mocks.getMetadata.mockResolvedValueOnce({ publishedAt: '2026-01-01T12:00:00.000Z' })
      .mockResolvedValueOnce({ publishedAt: '2026-01-01T12:00:01.000Z' });
    await expect(syncSharedProject(project.id, 'user-1')).resolves.toMatchObject({
      status: 'synced', sharedUpdatesAvailable: true,
    });
    expect(mocks.getPendingPull).not.toHaveBeenCalled();
    expect(mocks.releaseClaims).toHaveBeenCalledOnce();
  });

  it('keeps its locks when the selected project needs a team merge', async () => {
    mocks.getMetadata.mockResolvedValue({ publishedAt: '2026-01-01T12:00:01.000Z' });
    mocks.getPendingAreas.mockResolvedValue([{ areaId: 'local-area' }]);
    mocks.pushChanges.mockResolvedValue({ remainingAreaCount: 1, conflictedAreaCount: 1, metadataRemaining: false });
    const pull = { preservedLocalAreaCount: 1, preservedLocalProjectMetadata: false, hasNewerLocalChanges: true };
    mocks.getPendingPull.mockResolvedValue(pull);

    await expect(syncSharedProject(project.id, 'user-1')).resolves.toEqual({ status: 'review', pull });
    expect(mocks.pushChanges).toHaveBeenCalledWith(project.id);
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('requires review when the versioned project details were rejected', async () => {
    mocks.pushChanges.mockResolvedValue({ remainingAreaCount: 0, metadataRemaining: true, metadataConflicted: true });
    const pull = { preservedLocalProjectMetadata: true };
    mocks.getPendingPull.mockResolvedValue(pull);
    await expect(syncSharedProject(project.id, 'user-1')).resolves.toEqual({ status: 'review', pull });
    expect(mocks.getPendingPull).toHaveBeenCalledWith(project, 'publish-conflict');
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('keeps an unfinished upload pending without forcing another merge or releasing locks', async () => {
    mocks.pushChanges.mockResolvedValue({ remainingAreaCount: 1, metadataRemaining: false, conflictedAreaCount: 0 });
    await expect(syncSharedProject(project.id, 'user-1')).resolves.toMatchObject({ status: 'pending' });
    expect(mocks.getPendingPull).not.toHaveBeenCalled();
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it.each([
    'Your account does not have permission to update this area.',
    'The area payload has an invalid checkpoint identity.',
  ])('shows an area rejection without asking for team review again: %s', async (message) => {
    mocks.getProjectMetadata.mockResolvedValue({
      ...project, areas: [{ id: 'unit-203', name: 'Unit 203', locations: [] }],
    });
    mocks.pushChanges.mockResolvedValue({
      remainingAreaCount: 1, metadataRemaining: false, conflictedAreaCount: 0,
      blockedAreaErrors: [{ areaId: 'unit-203', message }],
    });

    await expect(syncSharedProject(project.id, 'user-1')).resolves.toEqual({
      status: 'pending',
      message: `Unit 203: ${message} Your work is saved on this device. Its areas stayed locked.`,
    });
    expect(mocks.getPendingPull).not.toHaveBeenCalled();
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('shows rejected project details without treating them as competing team edits', async () => {
    mocks.pushChanges.mockResolvedValue({
      remainingAreaCount: 0, metadataRemaining: true, metadataConflicted: false,
      blockedMetadataError: 'Project details are missing a required value.',
    });

    await expect(syncSharedProject(project.id, 'user-1')).resolves.toMatchObject({
      status: 'pending', message: expect.stringContaining('Project details are missing a required value.'),
    });
    expect(mocks.getPendingPull).not.toHaveBeenCalled();
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('does not report success when a new queued edit arrives during publication', async () => {
    mocks.getPendingAreas.mockResolvedValue([{ areaId: 'edited-during-upload' }]);
    await expect(syncSharedProject(project.id, 'user-1')).resolves.toMatchObject({ status: 'pending', message: expect.stringContaining('New local changes') });
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('keeps local work when it changes during an otherwise clean team download', async () => {
    mocks.getProjectMetadata.mockResolvedValue({ ...project, sharedSnapshotPublishedAt: undefined });
    mocks.getProject.mockResolvedValue({ ...project, sharedSnapshotPublishedAt: undefined });
    mocks.getMetadata.mockResolvedValue({ publishedAt: '2026-01-01T12:00:01.000Z' });
    mocks.getPendingPull.mockResolvedValue({ resolutionProject: project, preservedLocalAreaCount: 0, preservedLocalProjectMetadata: false, hasNewerLocalChanges: false });
    mocks.saveDownloaded.mockResolvedValue(false);
    await expect(syncSharedProject(project.id, 'user-1')).resolves.toMatchObject({ status: 'pending', message: expect.stringContaining('downloading') });
    expect(mocks.saveDownloaded).toHaveBeenCalledWith(project, 'original-local-copy');
    expect(mocks.pushChanges).not.toHaveBeenCalled();
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('does not release locks after the local project disappears during sync', async () => {
    mocks.getProjectMetadata.mockResolvedValueOnce(project).mockResolvedValueOnce(undefined);
    await expect(syncSharedProject(project.id, 'user-1')).resolves.toMatchObject({ status: 'pending', message: expect.stringContaining('team link changed') });
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('does not sync or release a team project with duplicate local copies', async () => {
    mocks.getAllProjects.mockResolvedValue([project, { ...project, id: 'other-copy' }]);

    const result = await syncSharedProject(project.id, 'user-1');

    expect(result.status).toBe('pending');
    expect(mocks.pushChanges).not.toHaveBeenCalled();
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('keeps locks until the sent team snapshot can be verified', async () => {
    mocks.getMetadata.mockResolvedValue(null);

    const result = await syncSharedProject(project.id, 'user-1');

    expect(result.status).toBe('pending');
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('keeps sync pending when the team database is out of connections', async () => {
    mocks.getMetadata.mockRejectedValue({ code: '53300', message: 'Too many connections issued to the database' });

    const result = await syncSharedProject(project.id, 'user-1');

    expect(result).toMatchObject({ status: 'pending', message: expect.stringContaining('Any locks not yet released are still held') });
    expect(mocks.pushChanges).not.toHaveBeenCalled();
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('reports pending when release needs another attempt after the team copy is verified', async () => {
    mocks.releaseClaims.mockRejectedValue(new Error('Too many connections issued to the database'));

    const result = await syncSharedProject(project.id, 'user-1');

    expect(result.status).toBe('pending');
    expect(mocks.releaseClaims).toHaveBeenCalledOnce();
  });

it('identifies whether capacity failure happened before publication or during release', async () => {
  const capacity = { code: '53300', message: 'Too many connections issued to the database' };
  mocks.getMetadata.mockRejectedValueOnce(capacity);
  await expect(syncSharedProject(project.id, 'user-1')).resolves.toMatchObject({status: 'pending', message: expect.stringContaining('checking for team updates')});
  mocks.getProject.mockResolvedValue(project);
  mocks.getProjectMetadata.mockResolvedValue(project);
  mocks.getAllProjects.mockResolvedValue([project]);
  mocks.getMetadata.mockResolvedValue({publishedAt:'2026-01-01T12:00:00.000Z'});
  mocks.getPendingAreas.mockResolvedValue([]);
  mocks.getPendingMetadata.mockResolvedValue(undefined);
  mocks.pushChanges.mockResolvedValue({remainingAreaCount:0,metadataRemaining:false});
  mocks.releaseClaims.mockRejectedValueOnce(capacity);
  await expect(syncSharedProject(project.id, 'user-1')).resolves.toMatchObject({status:'pending',message:expect.stringContaining('releasing saved areas')});
});

});
