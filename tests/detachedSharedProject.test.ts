import { describe, expect, it } from 'vitest';
import {
  detachLocalSharedProject,
  findDetachedSharedProject,
  relinkDetachedSharedProject,
} from '@/features/collaboration/detachedSharedProject';
import type { Project } from '@/types';

const baseline = new Date('2026-07-15T16:00:00.000Z');
const detachedAt = new Date('2026-07-15T17:00:00.000Z');
const linkedAt = new Date('2026-07-15T18:00:00.000Z');

function sharedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'local-project-1',
    sharedProjectId: 'shared-project-1',
    sharedProjectLinkedAt: new Date('2026-07-15T15:00:00.000Z'),
    sharedSnapshotPublishedAt: baseline,
    projectName: 'Shared project',
    address: '',
    date: baseline,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas: [],
    createdAt: baseline,
    updatedAt: baseline,
    ...overrides,
  };
}

describe('detached shared project helpers', () => {
  it('preserves the former shared identity while unlinking the local copy', () => {
    const detached = detachLocalSharedProject(sharedProject(), detachedAt);

    expect(detached.id).toBe('local-project-1');
    expect(detached.sharedProjectId).toBeUndefined();
    expect(detached.sharedProjectLinkedAt).toBeUndefined();
    expect(detached.sharedSnapshotPublishedAt).toBeUndefined();
    expect(detached.detachedSharedProjectId).toBe('shared-project-1');
    expect(detached.detachedSharedProjectAt).toEqual(detachedAt);
    expect(detached.detachedSharedSnapshotPublishedAt).toEqual(baseline);
  });

  it('finds only an available detached copy for the same shared project', () => {
    const detached = detachLocalSharedProject(sharedProject(), detachedAt);
    const active = sharedProject({ id: 'active-local-project' });
    const deleted = { ...detached, id: 'deleted-local-project', deletedAt: detachedAt };

    expect(findDetachedSharedProject([active, deleted, detached], 'shared-project-1')?.id)
      .toBe('local-project-1');
    expect(findDetachedSharedProject([active, deleted], 'shared-project-1')).toBeUndefined();
  });

  it('relinks the same local project and restores its merge baseline', () => {
    const detached = detachLocalSharedProject(sharedProject(), detachedAt);
    const relinked = relinkDetachedSharedProject(detached, 'shared-project-1', linkedAt);

    expect(relinked.id).toBe('local-project-1');
    expect(relinked.sharedProjectId).toBe('shared-project-1');
    expect(relinked.sharedProjectLinkedAt).toEqual(linkedAt);
    expect(relinked.sharedSnapshotPublishedAt).toEqual(baseline);
    expect(relinked.detachedSharedProjectId).toBeUndefined();
    expect(relinked.detachedSharedProjectAt).toBeUndefined();
    expect(relinked.detachedSharedSnapshotPublishedAt).toBeUndefined();
  });
});
