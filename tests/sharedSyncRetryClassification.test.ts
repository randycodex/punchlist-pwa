import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createArea, createProject, getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject, queuePendingSharedAreaSync,
  queuePendingSharedProjectMetadataSync, saveProjectPreserveTimestamps,
} from '@/lib/db';
import { getSharedSyncFailureCode } from '@/lib/collaboration/sharedSyncFailure';
import { ProjectPayloadValidationError } from '@/lib/projectPayload';

const { areaPublish, metadataPublish } = vi.hoisted(() => ({ areaPublish: vi.fn(), metadataPublish: vi.fn() }));
vi.mock('@/lib/collaboration/supabaseClient', () => ({ getCollaborationSupabaseClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: 'member' } } }, error: null }) } }) }));
vi.mock('@/lib/collaboration/sharedProjectAreas', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/collaboration/sharedProjectAreas')>(),
  publishSharedProjectAreaSnapshot: areaPublish,
}));
vi.mock('@/lib/collaboration/sharedProjectMetadata', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/collaboration/sharedProjectMetadata')>(),
  publishSharedProjectMetadataSnapshot: metadataPublish,
}));
import { flushPendingSharedAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';
import { flushPendingSharedProjectMetadataSyncs, settlePendingSharedProjectMetadataSync } from '@/lib/collaboration/sharedProjectMetadataSyncQueue';
import { SharedProjectAreaConflictError } from '@/lib/collaboration/sharedProjectAreas';
import { SharedProjectMetadataConflictError } from '@/lib/collaboration/sharedProjectMetadata';

beforeEach(() => {
  areaPublish.mockReset().mockResolvedValue({ areaVersion: 3, publishedAt: '2026-10-02T12:00:00Z' });
  metadataPublish.mockReset().mockResolvedValue({ metadataVersion: 3, publishedAt: '2026-10-02T12:00:00Z' });
});

async function fixture() {
  const project = createProject('Retry classification'); project.sharedProjectId = crypto.randomUUID();
  project.sharedSnapshotPublishedAt = new Date('2026-10-02T11:00:00Z');
  const area = createArea(project.id, 'Unit 203', 0); area.sharedVersion = 2; project.areas.push(area);
  await saveProjectPreserveTimestamps(project);
  return { project, area };
}

describe('paused team sends and actual version conflicts', () => {
  it.each(['42501', '22023', 'PGRST202'])('reports %s as pending and does not retry it during another automatic flush', async (code) => {
    const { project, area } = await fixture();
    const queued = await queuePendingSharedAreaSync({ localProjectId: project.id, sharedProjectId: project.sharedProjectId!, areaId: area.id, baseVersion: 2, basePublishedAt: project.sharedSnapshotPublishedAt!.toISOString() });
    areaPublish.mockRejectedValue({ code, message: 'The team service rejected this change.' });
    expect(await flushPendingSharedAreaSyncs(project.id)).toEqual({ synced: 0, pending: 1, conflicted: 0 });
    expect(await flushPendingSharedAreaSyncs(project.id)).toEqual({ synced: 0, pending: 1, conflicted: 0 });
    expect(areaPublish).toHaveBeenCalledOnce();
    expect((await getPendingSharedAreaSyncsForProject(project.id))[0]).toMatchObject({
      clientId: queued.clientId, revision: queued.revision, baseVersion: queued.baseVersion,
      blockedByConflict: true, lastErrorCode: code,
    });
  });

  it('pauses local payload validation instead of repeatedly sending or asking for a merge', async () => {
    const { project, area } = await fixture();
    await queuePendingSharedAreaSync({ localProjectId: project.id, sharedProjectId: project.sharedProjectId!, areaId: area.id, baseVersion: 2, basePublishedAt: project.sharedSnapshotPublishedAt!.toISOString() });
    areaPublish.mockRejectedValue(new ProjectPayloadValidationError('Area identity is invalid.'));
    expect(await flushPendingSharedAreaSyncs(project.id)).toEqual({ synced: 0, pending: 1, conflicted: 0 });
    expect((await getPendingSharedAreaSyncsForProject(project.id))[0]).toMatchObject({ blockedByConflict: true, lastErrorCode: 'ProjectPayloadValidationError' });
  });

  it('manually retries rejected project details once with the original revision and leaves other projects queued', async () => {
    const first = await fixture(); const other = await fixture();
    const queued = await queuePendingSharedProjectMetadataSync({ localProjectId: first.project.id, sharedProjectId: first.project.sharedProjectId!, baseVersion: 2 });
    await queuePendingSharedProjectMetadataSync({ localProjectId: other.project.id, sharedProjectId: other.project.sharedProjectId!, baseVersion: 1 });
    metadataPublish.mockRejectedValueOnce({ code: '42501', message: 'Team access is required.' });
    expect(await flushPendingSharedProjectMetadataSyncs(first.project.id)).toEqual({ synced: 0, pending: 1, conflicted: 0 });
    expect(await flushPendingSharedProjectMetadataSyncs(first.project.id)).toEqual({ synced: 0, pending: 1, conflicted: 0 });
    expect(metadataPublish).toHaveBeenCalledOnce();
    await settlePendingSharedProjectMetadataSync(first.project);
    expect(metadataPublish).toHaveBeenCalledTimes(2);
    expect(metadataPublish.mock.calls[1][0]).toMatchObject({ clientId: queued.clientId, baseVersion: queued.baseVersion, project: { id: first.project.id } });
    expect(await getPendingSharedProjectMetadataSyncForProject(first.project.id)).toBeUndefined();
    expect(await getPendingSharedProjectMetadataSyncForProject(other.project.id)).toBeDefined();
  });

  it('returns a repeated rejected metadata send with its cause rather than a version-conflict exception', async () => {
    const { project } = await fixture();
    const queued = await queuePendingSharedProjectMetadataSync({ localProjectId: project.id, sharedProjectId: project.sharedProjectId!, baseVersion: 2 });
    metadataPublish.mockRejectedValue({ code: '22023', message: 'Metadata fields are invalid.' });
    await flushPendingSharedProjectMetadataSyncs(project.id);
    await expect(settlePendingSharedProjectMetadataSync(project)).rejects.toMatchObject({ code: '22023', message: 'Metadata fields are invalid.' });
    expect(metadataPublish).toHaveBeenCalledTimes(2);
    expect(await getPendingSharedProjectMetadataSyncForProject(project.id)).toMatchObject({ clientId: queued.clientId, revision: queued.revision, baseVersion: queued.baseVersion, blockedByConflict: true, lastErrorCode: '22023' });
  });

  it('keeps an unreviewed metadata version conflict paused across manual and automatic attempts', async () => {
    const { project } = await fixture();
    await queuePendingSharedProjectMetadataSync({ localProjectId: project.id, sharedProjectId: project.sharedProjectId!, baseVersion: 2 });
    metadataPublish.mockRejectedValue(new SharedProjectMetadataConflictError());
    expect(await flushPendingSharedProjectMetadataSyncs(project.id)).toEqual({ synced: 0, pending: 0, conflicted: 1 });
    expect(await flushPendingSharedProjectMetadataSyncs(project.id)).toEqual({ synced: 0, pending: 0, conflicted: 1 });
    await expect(settlePendingSharedProjectMetadataSync(project)).rejects.toBeInstanceOf(SharedProjectMetadataConflictError);
    expect(metadataPublish).toHaveBeenCalledOnce();
    expect((await getPendingSharedProjectMetadataSyncForProject(project.id))?.lastErrorCode).toBe('40001');
  });

  it('extracts guarded error codes and normalizes converted version-conflict classes', () => {
    expect(getSharedSyncFailureCode(new SharedProjectAreaConflictError())).toBe('40001');
    expect(getSharedSyncFailureCode(new SharedProjectMetadataConflictError())).toBe('40001');
    expect(getSharedSyncFailureCode({ code: 'PT409' })).toBe('PT409');
    expect(getSharedSyncFailureCode(new TypeError('Network request failed'))).toBe('TypeError');
    expect(getSharedSyncFailureCode(null)).toBeNull();
    expect(getSharedSyncFailureCode('42501')).toBeNull();
    expect(getSharedSyncFailureCode({ code: 42501 })).toBeNull();
  });
});
