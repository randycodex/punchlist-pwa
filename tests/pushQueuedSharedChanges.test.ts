import { describe, expect, it, vi } from 'vitest';
import {
  formatQueuedSharedPushMessage,
  pushQueuedSharedChanges,
} from '@/features/collaboration/pushQueuedSharedChanges';
import type {
  PendingSharedAreaSyncRecord,
  PendingSharedProjectMetadataSyncRecord,
} from '@/lib/db';

function areaRecord(
  key: string,
  blockedByConflict = false
): PendingSharedAreaSyncRecord {
  return {
    key,
    localProjectId: 'local-project',
    sharedProjectId: 'shared-project',
    areaId: key,
    baseVersion: 1,
    basePublishedAt: '2026-07-18T12:00:00.000Z',
    clientId: `client-${key}`,
    revision: 1,
    attemptCount: 0,
    blockedByConflict,
    queuedAt: new Date('2026-07-18T12:00:00.000Z'),
    lastError: blockedByConflict ? 'Newer team data' : null,
  };
}

function metadataRecord(blockedByConflict = false): PendingSharedProjectMetadataSyncRecord {
  return {
    key: 'local-project',
    localProjectId: 'local-project',
    sharedProjectId: 'shared-project',
    baseVersion: 1,
    clientId: 'metadata-client',
    revision: 1,
    attemptCount: 0,
    blockedByConflict,
    queuedAt: new Date('2026-07-18T12:00:00.000Z'),
    lastError: blockedByConflict ? 'Newer team data' : null,
  };
}

describe('queued shared changes push', () => {
  it('keeps permission, schema and invalid-input failures pending without requesting another merge', async () => {
    const paused = [
      { ...areaRecord('203', true), lastErrorCode: '42501', lastError: 'You do not have access to sync this shared area.' },
      { ...areaRecord('207', true), lastErrorCode: 'PGRST202', lastError: 'The team sync function is unavailable.' },
      { ...areaRecord('209', true), lastErrorCode: '22023', lastError: 'Shared area payload does not match its area id.' },
    ];
    const details = { ...metadataRecord(true), lastErrorCode: '22023', lastError: 'Shared project metadata fields are invalid.' };
    const result = await pushQueuedSharedChanges('local-project', {
      getPendingAreaSyncs: vi.fn().mockResolvedValue(paused),
      getPendingMetadataSync: vi.fn().mockResolvedValue(details),
      flushAreaSyncs: vi.fn(), flushMetadataSyncs: vi.fn(),
    });
    expect(result.remainingAreaCount).toBe(3);
    expect(result.metadataRemaining).toBe(true);
    expect(result.conflictedAreaCount).toBe(0);
    expect(result.metadataConflicted).toBe(false);
    expect(result.blockedAreaErrors).toEqual(paused.map((record) => ({ areaId: record.areaId, message: record.lastError })));
    expect(result.blockedMetadataError).toBe(details.lastError);
    expect(formatQueuedSharedPushMessage(result)).toContain('No area locks were released');
    expect(formatQueuedSharedPushMessage(result)).not.toContain('review the project');
    expect(formatQueuedSharedPushMessage(result)).not.toContain('retry automatically');
  });

  it('keeps legacy uncoded access failures out of review while preserving recognizable version conflicts', async () => {
    const paused = [
      { ...areaRecord('203', true), lastError: 'Shared area revision input is invalid.' },
      areaRecord('207', true),
      { ...areaRecord('209', true), lastError: null, readyAfterConflictReview: true },
    ];
    const result = await pushQueuedSharedChanges('local-project', {
      getPendingAreaSyncs: vi.fn().mockResolvedValue(paused),
      getPendingMetadataSync: vi.fn().mockResolvedValue({ ...metadataRecord(true), lastError: 'You do not have access to sync project details.' }),
      flushAreaSyncs: vi.fn(), flushMetadataSyncs: vi.fn(),
    });
    expect(result.conflictedAreaCount).toBe(2);
    expect(result.blockedAreaErrors).toEqual([{ areaId: '203', message: paused[0].lastError }]);
    expect(result.metadataConflicted).toBe(false);
  });

  it('uses authoritative version codes even when error wording mentions a lock', async () => {
    const paused = [
      { ...areaRecord('203', true), lastErrorCode: '40001', lastError: 'Another device owns this lock, and the area revision changed.' },
      { ...areaRecord('207', true), lastErrorCode: 'PT409', lastError: 'This revision is stale.' },
      { ...areaRecord('209', true), lastErrorCode: '42501', lastError: 'You cannot replace newer team data without team access.' },
    ];
    const result = await pushQueuedSharedChanges('local-project', {
      getPendingAreaSyncs: vi.fn().mockResolvedValue(paused),
      getPendingMetadataSync: vi.fn().mockResolvedValue({ ...metadataRecord(true), lastErrorCode: '40001', lastError: 'Details revision is stale.' }),
      flushAreaSyncs: vi.fn(), flushMetadataSyncs: vi.fn(),
    });
    expect(result.conflictedAreaCount).toBe(2);
    expect(result.metadataConflicted).toBe(true);
    expect(result.lockedAreaIds).toBeUndefined();
    expect(result.blockedAreaErrors).toEqual([{ areaId: '209', message: paused[2].lastError }]);
  });

  it('recognizes a coded lock even when legacy lock wording is absent', async () => {
    const locked = { ...areaRecord('203', true), lastErrorCode: '55P03', lastError: 'The claiming device must finish first.' };
    const result = await pushQueuedSharedChanges('local-project', {
      getPendingAreaSyncs: vi.fn().mockResolvedValue([locked]),
      getPendingMetadataSync: vi.fn().mockResolvedValue(undefined),
      flushAreaSyncs: vi.fn(), flushMetadataSyncs: vi.fn(),
    });
    expect(result.lockedAreaIds).toEqual(['203']);
    expect(result.conflictedAreaCount).toBe(0);
    expect(result.blockedAreaErrors).toBeUndefined();
  });

  it('distinguishes an owning-device lock from a newer-data conflict', async () => {
    const locked = { ...areaRecord('5B', true), lastError: 'This area is locked by another user or another device.' };
    const result = await pushQueuedSharedChanges('local-project', {
      getPendingAreaSyncs: vi.fn().mockResolvedValue([locked]),
      getPendingMetadataSync: vi.fn().mockResolvedValue(undefined),
      flushAreaSyncs: vi.fn(), flushMetadataSyncs: vi.fn(),
    });
    expect(result.lockedAreaIds).toEqual(['5B']);
    expect(result.conflictedAreaCount).toBe(0);
    expect(formatQueuedSharedPushMessage(result)).toContain('Merging again will not release');
  });

  it('flushes area and metadata queues without invoking a snapshot publisher', async () => {
    const getPendingAreaSyncs = vi
      .fn()
      .mockResolvedValueOnce([areaRecord('area-1'), areaRecord('area-2')])
      .mockResolvedValueOnce([]);
    const getPendingMetadataSync = vi
      .fn()
      .mockResolvedValueOnce(metadataRecord())
      .mockResolvedValueOnce(undefined);
    const flushAreaSyncs = vi.fn().mockResolvedValue(undefined);
    const flushMetadataSyncs = vi.fn().mockResolvedValue(undefined);

    const result = await pushQueuedSharedChanges('local-project', {
      getPendingAreaSyncs,
      getPendingMetadataSync,
      flushAreaSyncs,
      flushMetadataSyncs,
      resumeReviewedAreaSyncs: vi.fn().mockResolvedValue(undefined),
    });

    expect(flushAreaSyncs).toHaveBeenCalledOnce();
    expect(flushMetadataSyncs).toHaveBeenCalledOnce();
    expect(result).toEqual({
      attemptedAreaCount: 2,
      pushedAreaCount: 2,
      remainingAreaCount: 0,
      conflictedAreaCount: 0,
      attemptedMetadata: true,
      pushedMetadata: true,
      metadataRemaining: false,
      metadataConflicted: false,
    });
    expect(formatQueuedSharedPushMessage(result)).toBe(
      'Sent to the team: 2 areas and project details.'
    );
  });

  it('waits for area writes before flushing project details', async () => {
    let finishAreas: (() => void) | undefined;
    const flushAreaSyncs = vi.fn(() => new Promise<void>((resolve) => { finishAreas = resolve; }));
    const flushMetadataSyncs = vi.fn().mockResolvedValue(undefined);
    const pending = pushQueuedSharedChanges('local-project', {
      getPendingAreaSyncs: vi.fn().mockResolvedValue([]),
      getPendingMetadataSync: vi.fn().mockResolvedValue(undefined),
      flushAreaSyncs,
      flushMetadataSyncs,
    });
    await vi.waitFor(() => expect(flushAreaSyncs).toHaveBeenCalledOnce());
    expect(flushMetadataSyncs).not.toHaveBeenCalled();
    finishAreas?.();
    await pending;
    expect(flushMetadataSyncs).toHaveBeenCalledOnce();
  });

  it('reports version conflicts that remain paused for review', async () => {
    const conflict = areaRecord('area-1', true);
    const result = await pushQueuedSharedChanges('local-project', {
      getPendingAreaSyncs: vi
        .fn()
        .mockResolvedValueOnce([conflict])
        .mockResolvedValueOnce([conflict]),
      getPendingMetadataSync: vi
        .fn()
        .mockResolvedValueOnce(metadataRecord(true))
        .mockResolvedValueOnce(metadataRecord(true)),
      flushAreaSyncs: vi.fn().mockResolvedValue(undefined),
      flushMetadataSyncs: vi.fn().mockResolvedValue(undefined),
      resumeReviewedAreaSyncs: vi.fn().mockResolvedValue(undefined),
    });

    expect(formatQueuedSharedPushMessage(result)).toBe(
      '2 changes need review before the team can take them. Tap Sync Team Projects, review the project, then sync again.'
    );
  });

  it('reports an established project with empty queues as current', async () => {
    const result = await pushQueuedSharedChanges('local-project', {
      getPendingAreaSyncs: vi.fn().mockResolvedValue([]),
      getPendingMetadataSync: vi.fn().mockResolvedValue(undefined),
      flushAreaSyncs: vi.fn().mockResolvedValue(undefined),
      flushMetadataSyncs: vi.fn().mockResolvedValue(undefined),
      resumeReviewedAreaSyncs: vi.fn().mockResolvedValue(undefined),
    });

    expect(formatQueuedSharedPushMessage(result)).toBe('Your work is already with the team. Nothing new to send.');
  });
});
