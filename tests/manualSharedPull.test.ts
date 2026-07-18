import { describe, expect, it } from 'vitest';
import { mergeSharedProjectAreas } from '@/features/collaboration/manualSharedPull';
import type { Area, Project } from '@/types';

const base = new Date('2026-01-01T12:00:00.000Z');

function area(id: string, name: string, updatedAt: string): Area {
  return {
    id,
    projectId: 'project-1',
    name,
    sortOrder: 0,
    isComplete: false,
    notes: name,
    locations: [],
    createdAt: base,
    updatedAt: new Date(updatedAt),
  };
}

function project(areas: Area[], updatedAt: string): Project {
  return {
    id: 'project-1',
    sharedProjectId: 'shared-1',
    sharedSnapshotPublishedAt: base,
    projectName: 'Project',
    address: '',
    date: base,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas,
    createdAt: base,
    updatedAt: new Date(updatedAt),
  };
}

describe('manual shared project area merge', () => {
  it('preserves local and remote work made in different areas', () => {
    const local = project([
      area('a', 'Local area', '2026-01-01T12:10:00.000Z'),
      area('b', 'Old remote area', '2026-01-01T11:00:00.000Z'),
    ], '2026-01-01T12:10:00.000Z');
    const remote = project([
      area('a', 'Old local area', '2026-01-01T11:00:00.000Z'),
      area('b', 'Remote area', '2026-01-01T12:12:00.000Z'),
    ], '2026-01-01T12:12:00.000Z');

    const result = mergeSharedProjectAreas(local, remote);
    expect(result.resolutionProject.areas.map((entry) => entry.name)).toEqual(['Local area', 'Remote area']);
    expect(result.conflictingAreaNames).toEqual([]);
  });

  it('keeps the local area and reports when both sides changed it', () => {
    const local = project([area('a', 'Apartment 1A', '2026-01-01T12:10:00.000Z')], '2026-01-01T12:10:00.000Z');
    const remoteArea = area('a', 'Apartment 1A remote', '2026-01-01T12:12:00.000Z');
    remoteArea.sharedVersion = 4;
    remoteArea.sharedPublishedAt = new Date('2026-01-01T12:12:00.000Z');
    const remote = project([remoteArea], '2026-01-01T12:12:00.000Z');

    const result = mergeSharedProjectAreas(local, remote);
    expect(result.resolutionProject.areas[0].name).toBe('Apartment 1A');
    expect(result.resolutionProject.areas[0]).toMatchObject({
      sharedVersion: 4,
      sharedPublishedAt: new Date('2026-01-01T12:12:00.000Z'),
    });
    expect(result.conflictingAreaNames).toEqual(['Apartment 1A']);
  });

  it('preserves a local-only newly created area', () => {
    const local = project([area('local-only', 'New local area', '2026-01-01T12:10:00.000Z')], '2026-01-01T12:10:00.000Z');
    const remote = project([], '2026-01-01T12:12:00.000Z');

    expect(mergeSharedProjectAreas(local, remote).resolutionProject.areas[0].name).toBe('New local area');
  });

  it('does not restore remote area contents after a local purge', () => {
    const localArea = area('a', 'Purged area', '2026-01-01T12:10:00.000Z');
    localArea.deletedAt = new Date('2026-01-01T12:10:00.000Z');
    localArea.purgedAt = new Date('2026-01-01T12:10:00.000Z');
    localArea.locations = [];
    const remoteArea = area('a', 'Remote area', '2026-01-01T12:12:00.000Z');
    remoteArea.locations = [{
      id: 'location-1',
      areaId: 'a',
      name: 'Room',
      sortOrder: 0,
      items: [],
      createdAt: base,
      updatedAt: new Date('2026-01-01T12:12:00.000Z'),
    }];

    const result = mergeSharedProjectAreas(
      project([localArea], '2026-01-01T12:10:00.000Z'),
      project([remoteArea], '2026-01-01T12:12:00.000Z')
    );

    expect(result.resolutionProject.areas[0]).toMatchObject({
      name: 'Purged area',
      purgedAt: new Date('2026-01-01T12:10:00.000Z'),
      locations: [],
    });
  });

  it('applies a remote purge over local area contents', () => {
    const localArea = area('a', 'Local area', '2026-01-01T12:12:00.000Z');
    const remoteArea = area('a', 'Purged area', '2026-01-01T12:10:00.000Z');
    remoteArea.deletedAt = new Date('2026-01-01T12:10:00.000Z');
    remoteArea.purgedAt = new Date('2026-01-01T12:10:00.000Z');

    const result = mergeSharedProjectAreas(
      project([localArea], '2026-01-01T12:12:00.000Z'),
      project([remoteArea], '2026-01-01T12:10:00.000Z')
    );

    expect(result.resolutionProject.areas[0].purgedAt).toEqual(
      new Date('2026-01-01T12:10:00.000Z')
    );
  });

  it('keeps queued local project details while advancing their remote revision', () => {
    const local = project([], '2026-01-01T12:10:00.000Z');
    local.projectName = 'Local project name';
    local.address = 'Local address';
    local.sharedMetadataVersion = 2;
    const remote = project([], '2026-01-01T12:12:00.000Z');
    remote.projectName = 'Remote project name';
    remote.address = 'Remote address';
    remote.sharedMetadataVersion = 3;
    remote.sharedMetadataPublishedAt = new Date('2026-01-01T12:12:00.000Z');

    const result = mergeSharedProjectAreas(local, remote, {
      preserveLocalProjectMetadata: true,
    });

    expect(result.preservedLocalProjectMetadata).toBe(true);
    expect(result.resolutionProject).toMatchObject({
      projectName: 'Local project name',
      address: 'Local address',
      sharedMetadataVersion: 3,
      sharedMetadataPublishedAt: new Date('2026-01-01T12:12:00.000Z'),
    });
  });
});
