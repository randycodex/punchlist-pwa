import { describe, expect, it } from 'vitest';
import {
  hasNewerLocalChangesThanSharedSnapshot,
  isSharedProjectPublishStale,
  isSharedSnapshotNewer,
} from '@/lib/collaboration/sharedProjectSnapshots';
import type { Project } from '@/types';

function project(overrides: Partial<Project> = {}): Project {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'project-1',
    sharedProjectId: 'shared-project-1',
    sharedSnapshotPublishedAt: new Date('2026-01-01T12:00:00.000Z'),
    projectName: 'Shared project',
    address: '',
    date: createdAt,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas: [],
    createdAt,
    updatedAt: new Date('2026-01-01T12:00:00.000Z'),
    ...overrides,
  };
}

describe('shared snapshot revision safety', () => {
  it('detects a newer remote revision without applying it', () => {
    const local = project();
    const remotePublishedAt = '2026-01-01T12:00:05.000Z';

    expect(isSharedSnapshotNewer(local, remotePublishedAt)).toBe(true);
    expect(isSharedProjectPublishStale(local, remotePublishedAt)).toBe(true);
  });

  it('does not flag timestamps inside the clock-skew tolerance', () => {
    const local = project();
    expect(isSharedSnapshotNewer(local, '2026-01-01T12:00:01.000Z')).toBe(false);
  });

  it('rejects a full publish for any newer server revision, even inside UI clock tolerance', () => {
    const local = project();
    expect(isSharedProjectPublishStale(local, '2026-01-01T12:00:00.001Z')).toBe(true);
  });

  it('protects local edits made after the last published team snapshot', () => {
    const local = project({ updatedAt: new Date('2026-01-01T12:00:10.000Z') });
    expect(hasNewerLocalChangesThanSharedSnapshot(local, '2026-01-01T12:00:05.000Z')).toBe(true);
  });

  it('still detects a team update when this device also has newer local edits', () => {
    const local = project({ updatedAt: new Date('2026-01-01T12:10:00.000Z') });
    expect(isSharedSnapshotNewer(local, '2026-01-01T12:05:00.000Z')).toBe(true);
    expect(hasNewerLocalChangesThanSharedSnapshot(local, '2026-01-01T12:05:00.000Z')).toBe(true);
  });
});
