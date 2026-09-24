import {
  clearPendingProjectSync,
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
  | { status: 'conflict'; conflicts: SyncConflict[]; backedUpProjectIds: string[]; message: string }
  | { status: 'partial'; backedUpProjectIds: string[]; message: string }
  | { status: 'retry'; message: string }
  | { status: 'error'; message: string };

export type ManualOneDriveRestoreResult =
  | { status: 'success'; restoredProjectCount: number; restoredProjectIds: string[]; recoveredLocalCopies?: Array<{ id: string; name: string }> }
  | { status: 'partial'; restoredProjectCount: number; restoredProjectIds: string[]; recoveredLocalCopies?: Array<{ id: string; name: string }>; failedProjects: Array<{ id: string; name: string; message: string }> }
  | { status: 'needs-auth' }
  | { status: 'retry'; message: string; retryAfterMs: number }
  | { status: 'error'; message: string };

function formatBackupConflictReviewMessage(conflicts: SyncConflict[], actionLabel = 'Sync Projects') {
  if (conflicts.length === 1) {
    return `OneDrive changed while syncing ${conflicts[0].name}. Your work is safe on this device. Tap ${actionLabel} again to get the latest backup.`;
  }
  return `OneDrive changed while syncing ${conflicts.length} projects. Your work is safe on this device. Tap ${actionLabel} again to get the latest backups.`;
}

export async function runManualOneDriveSync(options: {
  ensureAccessToken: () => Promise<string | null>;
  projectIds?: string[];
  forceProjectIds?: string[];
  backupProjects?: typeof backupProjectsToOneDrive;
  scope?: 'all' | 'selected';
}): Promise<ManualOneDriveSyncResult> {
  const selectedProjectIds = options.scope === 'selected' ? [...new Set(options.projectIds ?? [])] : null;
  if (selectedProjectIds && selectedProjectIds.length === 0) {
    return { status: 'error', message: 'Choose a project to sync.' };
  }
  if (!selectedProjectIds) resumePendingSyncAutoRetry();

  const queueSelectedProjects = () => {
    selectedProjectIds?.forEach((projectId) => queuePendingSync(projectId));
  };
  const actionLabel = selectedProjectIds ? 'Sync This Project' : 'Sync Projects';
  const manualRetryMessage = (seconds?: number) =>
    formatMicrosoftManualRetryMessage(seconds).replace('Sync Projects', actionLabel);

  try {
    const token = await options.ensureAccessToken();
    if (!token) {
      return { status: 'needs-auth' };
    }

    const pendingSyncState = loadPendingSyncState();
    const requestedProjectIds = selectedProjectIds ?? (pendingSyncState.fullSyncNeeded
      ? undefined
      : [...new Set([...pendingSyncState.projectIds, ...(options.projectIds ?? [])])]);
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
      if (selectedProjectIds) queueSelectedProjects();
      else {
        if (!hasPendingSyncState()) queuePendingSync(undefined, { fullSync: true });
        pausePendingSyncAutoRetry();
      }
      return {
        status: 'conflict',
        conflicts: result.conflicts,
        backedUpProjectIds: result.backedUpProjectIds,
        message: [
          formatBackupConflictReviewMessage(result.conflicts, actionLabel),
          ...(result.failedProjects ?? []).map((project) => `${project.name}: ${project.message}`),
        ].join('\n'),
      };
    }

    if (result.failedProjects?.length) {
      if (selectedProjectIds) queueSelectedProjects();
      else {
        if (!hasPendingSyncState()) queuePendingSync(undefined, { fullSync: true });
        pausePendingSyncAutoRetry();
      }
      return {
        status: 'partial',
        backedUpProjectIds: result.backedUpProjectIds,
        message: [
          ...(result.failedProjects ?? []).map((project) => `${project.name}: ${project.message}`),
          `These personal backups stayed queued. Tap ${actionLabel} again to retry them.`,
        ].join('\n'),
      };
    }

    if (selectedProjectIds) clearPendingProjectSync(selectedProjectIds, pendingSyncState.revision);
    else clearPendingSyncState(pendingSyncState.revision);
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
      if (selectedProjectIds) queueSelectedProjects();
      else if (!hasQueuedSync) {
        queuePendingSync(undefined, { fullSync: true });
      }
      if (!selectedProjectIds) pausePendingSyncAutoRetry();
      return {
        status: 'retry',
        message: manualRetryMessage(Math.ceil(retryDelayMs / 1000)),
      };
    }

    const message = getMicrosoftErrorMessage(error, 'OneDrive backup failed.');
    if (message.startsWith('Saved locally.')) {
      if (selectedProjectIds) queueSelectedProjects();
      else if (!hasQueuedSync) {
        queuePendingSync(undefined, { fullSync: true });
      }
      if (!selectedProjectIds) pausePendingSyncAutoRetry();
      return {
        status: 'retry',
        message: manualRetryMessage(),
      };
    }

    if (selectedProjectIds) queueSelectedProjects();
    return { status: 'error', message };
  }
}

export async function runManualOneDriveRestore(options: {
  ensureAccessToken: () => Promise<string | null>;
  restoreProjects?: typeof restoreMissingProjectsFromOneDrive;
  recoverInactiveSharedProjectIds?: string[];
}): Promise<ManualOneDriveRestoreResult> {
  try {
    const token = await options.ensureAccessToken();
    if (!token) return { status: 'needs-auth' };

    const restoreProjects = options.restoreProjects ?? restoreMissingProjectsFromOneDrive;
    const restoreOptions = options.recoverInactiveSharedProjectIds?.length
      ? { recoverInactiveSharedProjectIds: options.recoverInactiveSharedProjectIds }
      : undefined;
    let result;
    try {
      result = restoreOptions ? await restoreProjects(token, restoreOptions) : await restoreProjects(token);
    } catch (error) {
      if (!isMicrosoftMissingObjectError(error) && !isMicrosoftConnectionError(error)) throw error;
      result = restoreOptions ? await restoreProjects(token, restoreOptions) : await restoreProjects(token);
    }
    if (result.failedProjects?.length) {
      return {
        status: 'partial',
        restoredProjectCount: result.restoredProjectIds.length,
        restoredProjectIds: result.restoredProjectIds,
        ...(result.recoveredLocalCopies?.length ? { recoveredLocalCopies: result.recoveredLocalCopies } : {}),
        failedProjects: result.failedProjects,
      };
    }
    return {
      status: 'success',
      restoredProjectCount: result.restoredProjectIds.length,
      restoredProjectIds: result.restoredProjectIds,
      ...(result.recoveredLocalCopies?.length ? { recoveredLocalCopies: result.recoveredLocalCopies } : {}),
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
