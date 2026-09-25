import { describe, expect, it, vi } from 'vitest';
import { createProject, createArea, saveProjectPreserveTimestamps, queuePendingSharedAreaSync, queuePendingSharedProjectMetadataSync, getPendingSharedAreaSyncsForProject, getPendingSharedProjectMetadataSyncForProject } from '@/lib/db';
const { areaPublish, metadataPublish } = vi.hoisted(() => ({ areaPublish: vi.fn(async () => ({ areaVersion: 1, publishedAt: '2026-09-25T12:00:00Z' })), metadataPublish: vi.fn(async () => ({ metadataVersion: 1, publishedAt: '2026-09-25T12:00:00Z' })) }));
vi.mock('@/lib/collaboration/supabaseClient', () => ({ getCollaborationSupabaseClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: 'member' } } } }) } }) }));
vi.mock('@/lib/collaboration/sharedProjectAreas', () => ({ publishSharedProjectAreaSnapshot: areaPublish, isSharedProjectAreaConflictError: () => false }));
vi.mock('@/lib/collaboration/sharedProjectMetadata', () => ({ publishSharedProjectMetadataSnapshot: metadataPublish, isSharedProjectMetadataConflictError: () => false }));
import { pushQueuedSharedChanges } from '@/features/collaboration/pushQueuedSharedChanges';

describe('selected project queue draining', () => {
  it('leaves another project pending in both durable queues', async () => {
    const projects = [createProject('Selected'), createProject('Other')];
    for (const project of projects) {
      project.sharedProjectId = crypto.randomUUID(); project.sharedSnapshotPublishedAt = new Date('2026-09-25T11:00:00Z');
      project.areas.push(createArea(project.id, 'Area', 0));
      await saveProjectPreserveTimestamps(project);
      await queuePendingSharedAreaSync({ localProjectId: project.id, sharedProjectId: project.sharedProjectId, areaId: project.areas[0].id, baseVersion: 0, basePublishedAt: project.sharedSnapshotPublishedAt.toISOString() });
      await queuePendingSharedProjectMetadataSync({ localProjectId: project.id, sharedProjectId: project.sharedProjectId, baseVersion: 0 });
    }
    await pushQueuedSharedChanges(projects[0].id);
    expect(areaPublish).toHaveBeenCalledOnce(); expect(metadataPublish).toHaveBeenCalledOnce();
    expect(await getPendingSharedAreaSyncsForProject(projects[1].id)).toHaveLength(1);
    expect(await getPendingSharedProjectMetadataSyncForProject(projects[1].id)).toBeDefined();
  });
});
