import {
  getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject,
  type PendingSharedAreaSyncRecord,
  type PendingSharedProjectMetadataSyncRecord,
} from '@/lib/db';
import { flushPendingSharedAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';
import { flushPendingSharedProjectMetadataSyncs } from '@/lib/collaboration/sharedProjectMetadataSyncQueue';

export type QueuedSharedPushResult = {
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
  flushAreaSyncs(): Promise<unknown>;
  flushMetadataSyncs(): Promise<unknown>;
};

const defaultDependencies: QueuedSharedPushDependencies = {
  getPendingAreaSyncs: getPendingSharedAreaSyncsForProject,
  getPendingMetadataSync: getPendingSharedProjectMetadataSyncForProject,
  flushAreaSyncs: flushPendingSharedAreaSyncs,
  flushMetadataSyncs: flushPendingSharedProjectMetadataSyncs,
};

/**
 * Pushes the durable, versioned collaboration queues for an established shared
 * project. This deliberately avoids publishing a whole-project snapshot.
 */
export async function pushQueuedSharedChanges(
  localProjectId: string,
  dependencies: QueuedSharedPushDependencies = defaultDependencies
): Promise<QueuedSharedPushResult> {
  const [areaSyncsBefore, metadataSyncBefore] = await Promise.all([
    dependencies.getPendingAreaSyncs(localProjectId),
    dependencies.getPendingMetadataSync(localProjectId),
  ]);

  await Promise.all([
    dependencies.flushAreaSyncs(),
    dependencies.flushMetadataSyncs(),
  ]);

  const [areaSyncsAfter, metadataSyncAfter] = await Promise.all([
    dependencies.getPendingAreaSyncs(localProjectId),
    dependencies.getPendingMetadataSync(localProjectId),
  ]);
  const remainingAreaKeys = new Set(areaSyncsAfter.map((record) => record.key));

  return {
    attemptedAreaCount: areaSyncsBefore.length,
    pushedAreaCount: areaSyncsBefore.filter((record) => !remainingAreaKeys.has(record.key)).length,
    remainingAreaCount: areaSyncsAfter.length,
    conflictedAreaCount: areaSyncsAfter.filter((record) => record.blockedByConflict).length,
    attemptedMetadata: Boolean(metadataSyncBefore),
    pushedMetadata: Boolean(metadataSyncBefore && !metadataSyncAfter),
    metadataRemaining: Boolean(metadataSyncAfter),
    metadataConflicted: Boolean(metadataSyncAfter?.blockedByConflict),
  };
}

export function formatQueuedSharedPushMessage(result: QueuedSharedPushResult) {
  const conflictCount = result.conflictedAreaCount + (result.metadataConflicted ? 1 : 0);
  if (conflictCount > 0) {
    return `${conflictCount} shared change${conflictCount === 1 ? '' : 's'} need review. Pull Changes before editing the affected area or project details.`;
  }

  if (result.remainingAreaCount > 0 || result.metadataRemaining) {
    return 'Some shared changes are still queued. Check your connection; the app will retry automatically.';
  }

  if (result.attemptedAreaCount === 0 && !result.attemptedMetadata) {
    return 'Shared changes are already up to date.';
  }

  const pushedParts: string[] = [];
  if (result.pushedAreaCount > 0) {
    pushedParts.push(
      `${result.pushedAreaCount} area change${result.pushedAreaCount === 1 ? '' : 's'}`
    );
  }
  if (result.pushedMetadata) {
    pushedParts.push('project details');
  }

  return `Pushed ${pushedParts.join(' and ')}.`;
}
