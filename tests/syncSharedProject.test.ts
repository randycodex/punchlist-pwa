import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllProjects: vi.fn(),
  getProject: vi.fn(),
  getPendingAreas: vi.fn(),
  getMetadata: vi.fn(),
  getPendingPull: vi.fn(),
  pushChanges: vi.fn(),
  releaseClaims: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getAllProjects: mocks.getAllProjects,
  getProject: mocks.getProject,
  getPendingSharedAreaSyncsForProject: mocks.getPendingAreas,
  saveProjectMetadataOnly: vi.fn(),
  saveProjectPreserveTimestamps: vi.fn(),
}));
vi.mock('@/lib/collaboration', () => ({
  getSharedProjectSnapshotMetadata: mocks.getMetadata,
  hasNewerLocalChangesThanSharedSnapshot: () => false,
  isSharedSnapshotNewer: (_project: unknown, publishedAt: string) => publishedAt.endsWith('01.000Z'),
  publishSharedProjectSnapshot: vi.fn(),
  releaseAllMySharedProjectAreaClaims: mocks.releaseClaims,
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
  sharedProjectId: 'selected-team',
  sharedSnapshotPublishedAt: new Date('2026-01-01T12:00:00.000Z'),
  updatedAt: new Date('2026-01-01T12:00:00.000Z'),
};

describe('selected shared project sync', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getProject.mockResolvedValue(project);
    mocks.getAllProjects.mockResolvedValue([project]);
    mocks.getMetadata.mockResolvedValue({ publishedAt: '2026-01-01T12:00:00.000Z' });
    mocks.pushChanges.mockResolvedValue({ remainingAreaCount: 0, metadataRemaining: false });
    mocks.releaseClaims.mockResolvedValue({ releasedCount: 2 });
  });

  it('pushes and releases only the selected team project', async () => {
    await expect(syncSharedProject(project.id, 'user-1')).resolves.toEqual({ status: 'synced', releasedAreaCount: 2 });
    expect(mocks.getProject).toHaveBeenCalledWith('selected-project');
    expect(mocks.pushChanges).toHaveBeenCalledOnce();
    expect(mocks.pushChanges).toHaveBeenCalledWith('selected-project');
    expect(mocks.releaseClaims).toHaveBeenCalledWith('selected-team');
  });

  it('keeps its locks when the selected project needs a team merge', async () => {
    mocks.getMetadata.mockResolvedValue({ publishedAt: '2026-01-01T12:00:01.000Z' });
    mocks.getPendingAreas.mockResolvedValue([{ areaId: 'local-area' }]);
    const pull = { preservedLocalAreaCount: 1, preservedLocalProjectMetadata: false, hasNewerLocalChanges: true };
    mocks.getPendingPull.mockResolvedValue(pull);

    await expect(syncSharedProject(project.id, 'user-1')).resolves.toEqual({ status: 'review', pull });
    expect(mocks.pushChanges).not.toHaveBeenCalled();
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

    expect(result).toMatchObject({ status: 'pending', message: expect.stringContaining('release any remaining area locks') });
    expect(mocks.pushChanges).not.toHaveBeenCalled();
    expect(mocks.releaseClaims).not.toHaveBeenCalled();
  });

  it('reports pending when release needs another attempt after the team copy is verified', async () => {
    mocks.releaseClaims.mockRejectedValue(new Error('Too many connections issued to the database'));

    const result = await syncSharedProject(project.id, 'user-1');

    expect(result.status).toBe('pending');
    expect(mocks.releaseClaims).toHaveBeenCalledOnce();
  });
});
