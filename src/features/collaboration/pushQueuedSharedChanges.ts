import { isPendingSharedSyncLock, isPendingSharedSyncVersionConflict } from '@/lib/collaboration/sharedSyncFailure';
import {
  getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject,
  resumeReviewedPendingSharedAreaSyncs,
  resumePausedPendingSharedProjectMetadataSync,
  type PendingSharedAreaSyncRecord,
  type PendingSharedProjectMetadataSyncRecord,
} from '@/lib/db';
import { flushPendingSharedAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';
import { flushPendingSharedProjectMetadataSyncs } from '@/lib/collaboration/sharedProjectMetadataSyncQueue';

export type QueuedSharedPushResult = {
  lockedAreaIds?: string[];
  blockedAreaErrors?: Array<{ areaId: string; message: string }>;
  blockedMetadataError?: string;
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
  resumePausedMetadataSyncs?(localProjectId: string): Promise<unknown>;
};

const defaultDependencies: QueuedSharedPushDependencies = {
  getPendingAreaSyncs: getPendingSharedAreaSyncsForProject,
  getPendingMetadataSync: getPendingSharedProjectMetadataSyncForProject,
  flushAreaSyncs: flushPendingSharedAreaSyncs,
  flushMetadataSyncs: flushPendingSharedProjectMetadataSyncs,
  resumeReviewedAreaSyncs: resumeReviewedPendingSharedAreaSyncs,
  resumePausedMetadataSyncs: resumePausedPendingSharedProjectMetadataSync,
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
  await dependencies.resumePausedMetadataSyncs?.(localProjectId);
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
  const lockedAreaIds = areaSyncsAfter.filter(isPendingSharedSyncLock).map((record) => record.areaId);
  const blockedAreaErrors = areaSyncsAfter
    .filter((record) => record.blockedByConflict && !isPendingSharedSyncVersionConflict(record) && !isPendingSharedSyncLock(record))
    .map((record) => ({ areaId: record.areaId, message: record.lastError || 'This area could not be sent to the team.' }));
  const metadataConflicted = Boolean(metadataSyncAfter && isPendingSharedSyncVersionConflict(metadataSyncAfter));
  const blockedMetadataError = metadataSyncAfter?.blockedByConflict && !metadataConflicted
    ? metadataSyncAfter.lastError || 'Project details could not be sent to the team.'
    : undefined;
  const remainingAreaKeys = new Set(areaSyncsAfter.map((record) => record.key));

  return {
    ...(lockedAreaIds.length ? { lockedAreaIds } : {}),
    ...(blockedAreaErrors.length ? { blockedAreaErrors } : {}),
    ...(blockedMetadataError ? { blockedMetadataError } : {}),
    attemptedAreaCount: areaSyncsBefore.length,
    pushedAreaCount: areaSyncsBefore.filter((record) => !remainingAreaKeys.has(record.key)).length,
    remainingAreaCount: areaSyncsAfter.length,
    conflictedAreaCount: areaSyncsAfter.filter(isPendingSharedSyncVersionConflict).length,
    attemptedMetadata: Boolean(metadataSyncBefore),
    pushedMetadata: Boolean(metadataSyncBefore && !metadataSyncAfter),
    metadataRemaining: Boolean(metadataSyncAfter),
    metadataConflicted,
  };
}

export function formatQueuedSharedPushMessage(result: QueuedSharedPushResult) {
  if (result.lockedAreaIds?.length) return `${result.lockedAreaIds.length} area(s) are waiting for another user or device to sync and release them. Your pending work is kept. Merging again will not release these locks.`;
  if (result.blockedAreaErrors?.length || result.blockedMetadataError) {
    const messages = [...new Set([
      ...(result.blockedAreaErrors ?? []).map((error) => error.message),
      ...(result.blockedMetadataError ? [result.blockedMetadataError] : []),
    ])];
    return `${messages.join(' ')} Your work is saved on this device. No area locks were released.`;
  }
  const conflictCount = result.conflictedAreaCount + (result.metadataConflicted ? 1 : 0);
  if (conflictCount > 0) {
    return `${conflictCount} change${conflictCount === 1 ? '' : 's'} need review before the team can take them. Tap Sync Team Projects, review the project, then sync again.`;
  }

  if (result.remainingAreaCount > 0 || result.metadataRemaining) {
    return 'Some of your work is still waiting to reach the team. Your work is saved on this device. The app will retry while it is open.';
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
