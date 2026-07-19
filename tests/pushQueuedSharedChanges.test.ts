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
    });

    expect(formatQueuedSharedPushMessage(result)).toBe(
      '2 changes need review before the team can take them. Tap Get Team Updates, review the project, then try Send to Team again.'
    );
  });

  it('reports an established project with empty queues as current', async () => {
    const result = await pushQueuedSharedChanges('local-project', {
      getPendingAreaSyncs: vi.fn().mockResolvedValue([]),
      getPendingMetadataSync: vi.fn().mockResolvedValue(undefined),
      flushAreaSyncs: vi.fn().mockResolvedValue(undefined),
      flushMetadataSyncs: vi.fn().mockResolvedValue(undefined),
    });

    expect(formatQueuedSharedPushMessage(result)).toBe('Your work is already with the team. Nothing new to send.');
  });
});
