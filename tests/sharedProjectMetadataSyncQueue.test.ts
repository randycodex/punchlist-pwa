import { describe, expect, it } from 'vitest';
import {
  clearPendingSharedProjectMetadataSyncForProject,
  completePendingSharedProjectMetadataSync,
  createArea,
  createProject,
  getPendingSharedProjectMetadataSyncForProject,
  getPendingSharedProjectMetadataSyncs,
  getProjectMetadata,
  saveProjectMetadataWithSharedSync,
  saveProjectPreserveTimestamps,
} from '@/lib/db';

describe('durable shared project metadata sync queue', () => {
  it('coalesces rapid edits and advances a newer queued edit after an older request completes', async () => {
    const project = createProject('Original project details');
    project.sharedProjectId = 'shared-project-metadata-queue';
    project.sharedSnapshotPublishedAt = new Date('2026-07-17T12:00:00.000Z');
    project.sharedBaselinePublishedAt = project.sharedSnapshotPublishedAt;
    await saveProjectPreserveTimestamps(project);
    await clearPendingSharedProjectMetadataSyncForProject(project.id);

    project.projectName = 'First project name';
    const first = await saveProjectMetadataWithSharedSync(project);
    project.projectName = 'Second project name';
    const second = await saveProjectMetadataWithSharedSync(project);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await getPendingSharedProjectMetadataSyncs()).toContainEqual(second);
    expect(second!.revision).toBe(first!.revision + 1);
    expect(second!.clientId).not.toBe(first!.clientId);

    const firstCompletion = await completePendingSharedProjectMetadataSync({
      key: first!.key,
      clientId: first!.clientId,
      revision: first!.revision,
      metadataVersion: 1,
      publishedAt: '2026-07-17T12:01:00.000Z',
    });
    expect(firstCompletion.stillPending).toBe(true);
    expect(await getPendingSharedProjectMetadataSyncForProject(project.id)).toMatchObject({
      clientId: second!.clientId,
      baseVersion: 1,
    });

    const secondCompletion = await completePendingSharedProjectMetadataSync({
      key: second!.key,
      clientId: second!.clientId,
      revision: second!.revision,
      metadataVersion: 2,
      publishedAt: '2026-07-17T12:02:00.000Z',
    });
    expect(secondCompletion.stillPending).toBe(false);
    expect(await getPendingSharedProjectMetadataSyncForProject(project.id)).toBeUndefined();
    expect(await getProjectMetadata(project.id)).toMatchObject({
      projectName: 'Second project name',
      sharedMetadataVersion: 2,
      sharedMetadataPublishedAt: new Date('2026-07-17T12:02:00.000Z'),
      sharedSnapshotPublishedAt: new Date('2026-07-17T12:02:00.000Z'),
    });
  });

  it('preserves the latest stored server revision when a stale screen queues another edit', async () => {
    const current = createProject('Current project');
    current.sharedProjectId = 'shared-project-stale-screen';
    current.sharedSnapshotPublishedAt = new Date('2026-07-17T13:00:00.000Z');
    current.sharedMetadataVersion = 4;
    current.sharedMetadataPublishedAt = current.sharedSnapshotPublishedAt;
    await saveProjectPreserveTimestamps(current);
    await clearPendingSharedProjectMetadataSyncForProject(current.id);

    const staleScreenProject = {
      ...current,
      projectName: 'Edit from a stale screen',
      sharedMetadataVersion: 2,
      sharedMetadataPublishedAt: new Date('2026-07-17T12:30:00.000Z'),
      sharedSnapshotPublishedAt: new Date('2026-07-17T12:30:00.000Z'),
    };
    const queued = await saveProjectMetadataWithSharedSync(staleScreenProject);

    expect(queued).toMatchObject({ baseVersion: 4 });
    expect(staleScreenProject).toMatchObject({
      sharedMetadataVersion: 4,
      sharedMetadataPublishedAt: new Date('2026-07-17T13:00:00.000Z'),
      sharedSnapshotPublishedAt: new Date('2026-07-17T13:00:00.000Z'),
    });
    await clearPendingSharedProjectMetadataSyncForProject(current.id);
  });

  it('does not overwrite newer stored area data when a stale screen edits project details', async () => {
    const current = createProject('Current project');
    current.sharedProjectId = 'shared-project-stale-areas';
    current.sharedSnapshotPublishedAt = new Date('2026-07-17T14:00:00.000Z');
    const newerArea = createArea(current.id, 'Area added in another screen', 0);
    newerArea.id = 'newer-area';
    current.areas.push(newerArea);
    await saveProjectPreserveTimestamps(current);
    await clearPendingSharedProjectMetadataSyncForProject(current.id);

    const staleScreenProject = {
      ...current,
      projectName: 'Edited from a stale screen',
      areas: [],
    };
    await saveProjectMetadataWithSharedSync(staleScreenProject);

    expect(await getProjectMetadata(current.id)).toMatchObject({
      projectName: 'Edited from a stale screen',
      areas: [{ id: 'newer-area', name: 'Area added in another screen' }],
    });
    await clearPendingSharedProjectMetadataSyncForProject(current.id);
  });

  it('does not move stored metadata revisions backward when an older request finishes late', async () => {
    const project = createProject('Newer metadata already stored');
    project.sharedProjectId = 'shared-project-late-metadata';
    project.sharedSnapshotPublishedAt = new Date('2026-07-17T15:00:00.000Z');
    project.sharedMetadataVersion = 5;
    project.sharedMetadataPublishedAt = project.sharedSnapshotPublishedAt;
    await saveProjectPreserveTimestamps(project);
    await clearPendingSharedProjectMetadataSyncForProject(project.id);

    const queued = await saveProjectMetadataWithSharedSync(project);
    await completePendingSharedProjectMetadataSync({
      key: queued!.key,
      clientId: queued!.clientId,
      revision: queued!.revision,
      metadataVersion: 4,
      publishedAt: '2026-07-17T14:00:00.000Z',
    });

    expect(await getProjectMetadata(project.id)).toMatchObject({
      sharedMetadataVersion: 5,
      sharedMetadataPublishedAt: new Date('2026-07-17T15:00:00.000Z'),
      sharedSnapshotPublishedAt: new Date('2026-07-17T15:00:00.000Z'),
    });
  });
});
