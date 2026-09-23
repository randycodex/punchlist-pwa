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
  formatMicrosoftRestoreRetryMessage,
  getMicrosoftErrorMessage,
  getMicrosoftRetryDelayMs,
  isMicrosoftConnectionError,
  isMicrosoftMissingObjectError,
} from '@/lib/microsoftErrors';
import {
  backupProjectsToOneDrive,
  restoreMissingProjectsFromOneDrive,
  type SyncConflict,
} from '@/lib/oneDriveSync';

export type ManualOneDriveSyncResult =
  | { status: 'success'; syncedAt: string; backedUpProjectCount: number; backedUpProjectIds: string[] }
  | { status: 'needs-auth' }
  | { status: 'conflict'; conflicts: SyncConflict[]; message: string }
  | { status: 'retry'; message: string }
  | { status: 'error'; message: string };

export type ManualOneDriveRestoreResult =
  | { status: 'success'; restoredProjectCount: number; restoredProjectIds: string[] }
  | { status: 'needs-auth' }
  | { status: 'retry'; message: string; retryAfterMs: number }
  | { status: 'error'; message: string };

function formatBackupConflictReviewMessage(conflicts: SyncConflict[]) {
  if (conflicts.length === 1) {
    return `OneDrive changed while syncing ${conflicts[0].name}. Your work is safe on this device. Tap Sync Projects again to get the latest backup.`;
  }
  return `OneDrive changed while syncing ${conflicts.length} projects. Your work is safe on this device. Tap Sync Projects again to get the latest backups.`;
}

export async function runManualOneDriveSync(options: {
  ensureAccessToken: () => Promise<string | null>;
  projectIds?: string[];
  forceProjectIds?: string[];
  backupProjects?: typeof backupProjectsToOneDrive;
}): Promise<ManualOneDriveSyncResult> {
  resumePendingSyncAutoRetry();

  try {
    const token = await options.ensureAccessToken();
    if (!token) {
      return { status: 'needs-auth' };
    }

    const pendingSyncState = loadPendingSyncState();
    const requestedProjectIds = pendingSyncState.fullSyncNeeded
      ? undefined
      : [...new Set([...pendingSyncState.projectIds, ...(options.projectIds ?? [])])];
    const backupProjects = options.backupProjects ?? backupProjectsToOneDrive;
    let result;
    try {
      result = options.forceProjectIds?.length
        ? await backupProjects(token, requestedProjectIds, options.forceProjectIds)
        : await backupProjects(token, requestedProjectIds);
    } catch (error) {
      if (!isMicrosoftMissingObjectError(error)) throw error;
      result = options.forceProjectIds?.length
        ? await backupProjects(token, requestedProjectIds, options.forceProjectIds)
        : await backupProjects(token, requestedProjectIds);
    }

    if (result.conflicts.length > 0) {
      pausePendingSyncAutoRetry();
      return {
        status: 'conflict',
        conflicts: result.conflicts,
        message: formatBackupConflictReviewMessage(result.conflicts),
      };
    }

    clearPendingSyncState(pendingSyncState.revision);
    return {
      status: 'success',
      syncedAt: result.syncedAt,
      backedUpProjectCount: result.backedUpProjectIds.length,
      backedUpProjectIds: result.backedUpProjectIds,
    };
  } catch (error) {
    console.error('OneDrive backup failed:', error);
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

    const message = getMicrosoftErrorMessage(error, 'OneDrive backup failed.');
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

export async function runManualOneDriveRestore(options: {
  ensureAccessToken: () => Promise<string | null>;
  restoreProjects?: typeof restoreMissingProjectsFromOneDrive;
}): Promise<ManualOneDriveRestoreResult> {
  try {
    const token = await options.ensureAccessToken();
    if (!token) return { status: 'needs-auth' };

    const restoreProjects = options.restoreProjects ?? restoreMissingProjectsFromOneDrive;
    let result;
    try {
      result = await restoreProjects(token);
    } catch (error) {
      if (!isMicrosoftMissingObjectError(error) && !isMicrosoftConnectionError(error)) throw error;
      result = await restoreProjects(token);
    }
    return {
      status: 'success',
      restoredProjectCount: result.restoredProjectIds.length,
      restoredProjectIds: result.restoredProjectIds,
    };
  } catch (error) {
    console.error('OneDrive restore failed:', error);
    const retryDelayMs = getMicrosoftRetryDelayMs(error);
    if (retryDelayMs) {
      return {
        status: 'retry',
        message: formatMicrosoftRestoreRetryMessage(error, Math.ceil(retryDelayMs / 1000)),
        retryAfterMs: retryDelayMs,
      };
    }
    return {
      status: 'error',
      message: getMicrosoftErrorMessage(error, 'OneDrive restore failed.'),
    };
  }
}
