import {
  formatSyncConflictReviewMessage,
  syncProjectsWithOneDriveRecovery,
} from '@/lib/oneDriveSyncRecovery';
import {
  clearPendingSyncState,
  hasPendingSyncState,
  loadPendingSyncState,
  pausePendingSyncAutoRetry,
  queuePendingSync,
  resumePendingSyncAutoRetry,
} from '@/lib/pendingSync';
import {
  formatMicrosoftManualRetryMessage,
  getMicrosoftErrorMessage,
  getMicrosoftRetryDelayMs,
} from '@/lib/microsoftErrors';
import type { SyncConflict } from '@/lib/oneDriveSync';

export type ManualOneDriveSyncResult =
  | { status: 'success'; syncedAt: string }
  | { status: 'needs-auth' }
  | { status: 'conflict'; conflicts: SyncConflict[]; message: string }
  | { status: 'retry'; message: string }
  | { status: 'error'; message: string };

export async function runManualOneDriveSync(options: {
  ensureAccessToken: () => Promise<string | null>;
  syncProjects?: typeof syncProjectsWithOneDriveRecovery;
}): Promise<ManualOneDriveSyncResult> {
  resumePendingSyncAutoRetry();

  try {
    const token = await options.ensureAccessToken();
    if (!token) {
      return { status: 'needs-auth' };
    }

    const pendingSyncState = loadPendingSyncState();
    const result = await (options.syncProjects ?? syncProjectsWithOneDriveRecovery)(token, {
      pushProjectIds: pendingSyncState.projectIds,
    });

    if (result.conflicts.length > 0) {
      pausePendingSyncAutoRetry();
      return {
        status: 'conflict',
        conflicts: result.conflicts,
        message: formatSyncConflictReviewMessage(result.conflicts),
      };
    }

    clearPendingSyncState(pendingSyncState.revision);
    return { status: 'success', syncedAt: result.syncedAt };
  } catch (error) {
    console.error('Sync failed:', error);
    const hasQueuedSync = hasPendingSyncState();
    const retryDelayMs = getMicrosoftRetryDelayMs(error);

    if (retryDelayMs) {
      if (!hasQueuedSync) {
        queuePendingSync(undefined, { fullSync: true });
      }
      pausePendingSyncAutoRetry();
      return {
        status: 'retry',
        message: formatMicrosoftManualRetryMessage(Math.ceil(retryDelayMs / 1000)),
      };
    }

    const message = getMicrosoftErrorMessage(error, 'Sync failed.');
    if (message.startsWith('Saved locally.')) {
      if (!hasQueuedSync) {
        queuePendingSync(undefined, { fullSync: true });
      }
      pausePendingSyncAutoRetry();
      return {
        status: 'retry',
        message: formatMicrosoftManualRetryMessage(),
      };
    }

    return { status: 'error', message };
  }
}
