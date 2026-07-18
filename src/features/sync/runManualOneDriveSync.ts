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
import {
  backupProjectsToOneDrive,
  restoreMissingProjectsFromOneDrive,
  type SyncConflict,
} from '@/lib/oneDriveSync';

export type ManualOneDriveSyncResult =
  | { status: 'success'; syncedAt: string; backedUpProjectCount: number }
  | { status: 'needs-auth' }
  | { status: 'conflict'; conflicts: SyncConflict[]; message: string }
  | { status: 'retry'; message: string }
  | { status: 'error'; message: string };

export type ManualOneDriveRestoreResult =
  | { status: 'success'; restoredProjectCount: number }
  | { status: 'needs-auth' }
  | { status: 'retry'; message: string }
  | { status: 'error'; message: string };

function formatBackupConflictReviewMessage(conflicts: SyncConflict[]) {
  if (conflicts.length === 1) {
    return `OneDrive has a newer backup for ${conflicts[0].name}. Restore that backup on another device or review it before replacing it.`;
  }
  return `OneDrive has newer backups for ${conflicts.length} projects. Restore or review them before replacing them.`;
}

export async function runManualOneDriveSync(options: {
  ensureAccessToken: () => Promise<string | null>;
  projectIds?: string[];
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
    const result = await (options.backupProjects ?? backupProjectsToOneDrive)(
      token,
      requestedProjectIds
    );

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

    const result = await (options.restoreProjects ?? restoreMissingProjectsFromOneDrive)(token);
    return {
      status: 'success',
      restoredProjectCount: result.restoredProjectIds.length,
    };
  } catch (error) {
    console.error('OneDrive restore failed:', error);
    const retryDelayMs = getMicrosoftRetryDelayMs(error);
    if (retryDelayMs) {
      return {
        status: 'retry',
        message: `OneDrive is still catching up. Try Restore Backup again in about ${Math.ceil(retryDelayMs / 1000)} seconds.`,
      };
    }
    return {
      status: 'error',
      message: getMicrosoftErrorMessage(error, 'OneDrive restore failed.'),
    };
  }
}
