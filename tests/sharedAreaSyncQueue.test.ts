import { describe, expect, it } from 'vitest';
import {
  clearPendingSharedAreaSyncsForProject,
  completePendingSharedAreaSync,
  createArea,
  createProject,
  getPendingSharedAreaSyncs,
  getPendingSharedAreaSyncsForProject,
  getProjectMetadata,
  queuePendingSharedAreaSync,
  recordPendingSharedAreaSyncFailure,
  saveProjectPreserveTimestamps,
  summarizePendingSharedAreaSyncs,
} from '@/lib/db';
import { queueSharedProjectAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';

describe('durable shared area sync queue', () => {
  it('coalesces rapid edits without deleting a newer edit when an older request finishes', async () => {
    const project = createProject('Shared queue project');
    project.sharedProjectId = 'shared-project-queue';
    project.sharedSnapshotPublishedAt = new Date('2026-07-17T12:00:00.000Z');
    project.sharedBaselinePublishedAt = project.sharedSnapshotPublishedAt;
    const area = createArea(project.id, 'Apartment 1A', 0);
    project.areas.push(area);
    await saveProjectPreserveTimestamps(project);
    await clearPendingSharedAreaSyncsForProject(project.id);

    const first = await queuePendingSharedAreaSync({
      localProjectId: project.id,
      sharedProjectId: project.sharedProjectId,
      areaId: area.id,
      baseVersion: 0,
      basePublishedAt: project.sharedBaselinePublishedAt.toISOString(),
    });
    const second = await queuePendingSharedAreaSync({
      localProjectId: project.id,
      sharedProjectId: project.sharedProjectId,
      areaId: area.id,
      baseVersion: 0,
      basePublishedAt: project.sharedBaselinePublishedAt.toISOString(),
    });

    expect(await getPendingSharedAreaSyncs()).toHaveLength(1);
    expect(second.revision).toBe(first.revision + 1);
    expect(second.clientId).not.toBe(first.clientId);

    const firstCompletion = await completePendingSharedAreaSync({
      key: first.key,
      clientId: first.clientId,
      revision: first.revision,
      areaVersion: 1,
      publishedAt: '2026-07-17T12:01:00.000Z',
    });
    expect(firstCompletion.stillPending).toBe(true);
    expect((await getPendingSharedAreaSyncs())[0]).toMatchObject({
      clientId: second.clientId,
      revision: second.revision,
      baseVersion: 1,
    });

    const secondCompletion = await completePendingSharedAreaSync({
      key: second.key,
      clientId: second.clientId,
      revision: second.revision,
      areaVersion: 2,
      publishedAt: '2026-07-17T12:02:00.000Z',
    });
    expect(secondCompletion.stillPending).toBe(false);
    expect(await getPendingSharedAreaSyncs()).toHaveLength(0);
    expect((await getProjectMetadata(project.id))?.areas[0]).toMatchObject({
      sharedVersion: 2,
      sharedPublishedAt: new Date('2026-07-17T12:02:00.000Z'),
    });
  });

  it('pauses conflicted work until another local edit deliberately requeues it', async () => {
    const project = createProject('Conflict queue project');
    const area = createArea(project.id, 'Apartment 2A', 0);
    const queued = await queuePendingSharedAreaSync({
      localProjectId: project.id,
      sharedProjectId: 'shared-project-conflict',
      areaId: area.id,
      baseVersion: 2,
      basePublishedAt: '2026-07-17T12:00:00.000Z',
    });
    await recordPendingSharedAreaSyncFailure(queued.key, queued.clientId, 'Newer team data', true);
    const conflictedRecords = await getPendingSharedAreaSyncs();
    expect(conflictedRecords[0]).toMatchObject({ blockedByConflict: true });
    expect(summarizePendingSharedAreaSyncs(conflictedRecords)).toEqual({
      pendingCount: 1,
      conflictCount: 1,
      lastConflictError: 'Newer team data',
    });

    const requeued = await queuePendingSharedAreaSync({
      localProjectId: project.id,
      sharedProjectId: 'shared-project-conflict',
      areaId: area.id,
      baseVersion: 3,
      basePublishedAt: '2026-07-17T12:05:00.000Z',
    });
    expect(requeued).toMatchObject({
      blockedByConflict: false,
      baseVersion: 3,
      attemptCount: 0,
      lastError: null,
    });
    await clearPendingSharedAreaSyncsForProject(project.id);
  });

  it('does not move stored area revisions backward when an older request finishes late', async () => {
    const project = createProject('Newer area already stored');
    project.sharedProjectId = 'shared-project-late-area';
    project.sharedSnapshotPublishedAt = new Date('2026-07-17T15:00:00.000Z');
    const area = createArea(project.id, 'Apartment 2B', 0);
    area.sharedVersion = 5;
    area.sharedPublishedAt = project.sharedSnapshotPublishedAt;
    project.areas.push(area);
    await saveProjectPreserveTimestamps(project);
    await clearPendingSharedAreaSyncsForProject(project.id);

    const queued = await queuePendingSharedAreaSync({
      localProjectId: project.id,
      sharedProjectId: project.sharedProjectId,
      areaId: area.id,
      baseVersion: 3,
      basePublishedAt: '2026-07-17T13:00:00.000Z',
    });
    await completePendingSharedAreaSync({
      key: queued.key,
      clientId: queued.clientId,
      revision: queued.revision,
      areaVersion: 4,
      publishedAt: '2026-07-17T14:00:00.000Z',
    });

    expect((await getProjectMetadata(project.id))?.areas[0]).toMatchObject({
      sharedVersion: 5,
      sharedPublishedAt: new Date('2026-07-17T15:00:00.000Z'),
    });
  });

  it('keeps edits queued while an older full-publish cleanup is in flight', async () => {
    const project = createProject('Concurrent full publish project');
    const area = createArea(project.id, 'Apartment 3A', 0);
    const first = await queuePendingSharedAreaSync({
      localProjectId: project.id,
      sharedProjectId: 'shared-project-full-publish',
      areaId: area.id,
      baseVersion: 1,
      basePublishedAt: '2026-07-17T12:00:00.000Z',
    });
    const newer = await queuePendingSharedAreaSync({
      localProjectId: project.id,
      sharedProjectId: 'shared-project-full-publish',
      areaId: area.id,
      baseVersion: 1,
      basePublishedAt: '2026-07-17T12:00:00.000Z',
    });

    await clearPendingSharedAreaSyncsForProject(project.id, [first]);

    expect(await getPendingSharedAreaSyncsForProject(project.id)).toEqual([newer]);
    await clearPendingSharedAreaSyncsForProject(project.id, [newer]);
    expect(await getPendingSharedAreaSyncsForProject(project.id)).toHaveLength(0);
  });

  it('queues multiple area lifecycle changes in one durable batch', async () => {
    const project = createProject('Area lifecycle project');
    project.sharedProjectId = 'shared-project-lifecycle';
    project.sharedSnapshotPublishedAt = new Date('2026-07-17T12:00:00.000Z');
    project.sharedBaselinePublishedAt = project.sharedSnapshotPublishedAt;
    const createdArea = createArea(project.id, 'Apartment 4A', 0);
    const deletedArea = createArea(project.id, 'Apartment 4B', 1);
    deletedArea.deletedAt = new Date('2026-07-17T12:05:00.000Z');
    project.areas.push(createdArea, deletedArea);
    await saveProjectPreserveTimestamps(project);

    const result = await queueSharedProjectAreaSyncs(project, [
      createdArea.id,
      deletedArea.id,
      createdArea.id,
      'missing-area',
    ]);

    expect(result.queued).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(new Set(result.records.map((record) => record.areaId))).toEqual(
      new Set([createdArea.id, deletedArea.id])
    );
    expect(summarizePendingSharedAreaSyncs(await getPendingSharedAreaSyncsForProject(project.id))).toEqual({
      pendingCount: 2,
      conflictCount: 0,
      lastConflictError: null,
    });
    await clearPendingSharedAreaSyncsForProject(project.id);
  });
});
