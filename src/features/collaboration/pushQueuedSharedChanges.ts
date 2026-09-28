import { isAreaLockError } from '@/lib/collaboration/areaLockError';
import {
  getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject,
  resumeReviewedPendingSharedAreaSyncs,
  type PendingSharedAreaSyncRecord,
  type PendingSharedProjectMetadataSyncRecord,
} from '@/lib/db';
import { flushPendingSharedAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';
import { flushPendingSharedProjectMetadataSyncs } from '@/lib/collaboration/sharedProjectMetadataSyncQueue';

export type QueuedSharedPushResult = {
  lockedAreaIds?: string[];
  attemptedAreaCount: number;
  pushedAreaCount: number;
  remainingAreaCount: number;
  conflictedAreaCount: number;
  attemptedMetadata: boolean;
  pushedMetadata: boolean;
  metadataRemaining: boolean;
  metadataConflicted: boolean;
};

type QueuedSharedPushDependencies = {
  getPendingAreaSyncs(localProjectId: string): Promise<PendingSharedAreaSyncRecord[]>;
  getPendingMetadataSync(
    localProjectId: string
  ): Promise<PendingSharedProjectMetadataSyncRecord | undefined>;
  flushAreaSyncs(localProjectId: string): Promise<unknown>;
  flushMetadataSyncs(localProjectId: string): Promise<unknown>;
  resumeReviewedAreaSyncs?(localProjectId: string): Promise<unknown>;
};

const defaultDependencies: QueuedSharedPushDependencies = {
  getPendingAreaSyncs: getPendingSharedAreaSyncsForProject,
  getPendingMetadataSync: getPendingSharedProjectMetadataSyncForProject,
  flushAreaSyncs: flushPendingSharedAreaSyncs,
  flushMetadataSyncs: flushPendingSharedProjectMetadataSyncs,
  resumeReviewedAreaSyncs: resumeReviewedPendingSharedAreaSyncs,
};

/**
 * Pushes the durable, versioned collaboration queues for an established shared
 * project. This deliberately avoids publishing a whole-project snapshot.
 */
export async function pushQueuedSharedChanges(
  localProjectId: string,
  dependencies: QueuedSharedPushDependencies = defaultDependencies
): Promise<QueuedSharedPushResult> {
  await dependencies.resumeReviewedAreaSyncs?.(localProjectId);
  const [areaSyncsBefore, metadataSyncBefore] = await Promise.all([
    dependencies.getPendingAreaSyncs(localProjectId),
    dependencies.getPendingMetadataSync(localProjectId),
  ]);

  // These flushes both write to the team database. Keep one project sync from
  // issuing the two sets of writes at the same time.
  await dependencies.flushAreaSyncs(localProjectId);
  await dependencies.flushMetadataSyncs(localProjectId);

  const [areaSyncsAfter, metadataSyncAfter] = await Promise.all([
    dependencies.getPendingAreaSyncs(localProjectId),
    dependencies.getPendingMetadataSync(localProjectId),
  ]);
  const lockedAreaIds = areaSyncsAfter.filter((record) => isAreaLockError(record.lastError)).map((record) => record.areaId);
  const remainingAreaKeys = new Set(areaSyncsAfter.map((record) => record.key));

  return {
    ...(lockedAreaIds.length ? { lockedAreaIds } : {}),
    attemptedAreaCount: areaSyncsBefore.length,
    pushedAreaCount: areaSyncsBefore.filter((record) => !remainingAreaKeys.has(record.key)).length,
    remainingAreaCount: areaSyncsAfter.length,
    conflictedAreaCount: areaSyncsAfter.filter((record) => record.blockedByConflict && !isAreaLockError(record.lastError)).length,
    attemptedMetadata: Boolean(metadataSyncBefore),
    pushedMetadata: Boolean(metadataSyncBefore && !metadataSyncAfter),
    metadataRemaining: Boolean(metadataSyncAfter),
    metadataConflicted: Boolean(metadataSyncAfter?.blockedByConflict),
  };
}

export function formatQueuedSharedPushMessage(result: QueuedSharedPushResult) {
  if (result.lockedAreaIds?.length) return `${result.lockedAreaIds.length} area(s) are waiting for another user or device to sync and release them. Your pending work is kept. Merging again will not release these locks.`;
  const conflictCount = result.conflictedAreaCount + (result.metadataConflicted ? 1 : 0);
  if (conflictCount > 0) {
    return `${conflictCount} change${conflictCount === 1 ? '' : 's'} need review before the team can take them. Tap Sync Team Projects, review the project, then sync again.`;
  }

  if (result.remainingAreaCount > 0 || result.metadataRemaining) {
    return 'Some of your work is still waiting to reach the team. Check your connection — the app will retry automatically.';
  }

  if (result.attemptedAreaCount === 0 && !result.attemptedMetadata) {
    return 'Your work is already with the team. Nothing new to send.';
  }

  const pushedParts: string[] = [];
  if (result.pushedAreaCount > 0) {
    pushedParts.push(
      `${result.pushedAreaCount} area${result.pushedAreaCount === 1 ? '' : 's'}`
    );
  }
  if (result.pushedMetadata) {
    pushedParts.push('project details');
  }

  return `Sent to the team: ${pushedParts.join(' and ')}.`;
}
