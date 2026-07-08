import {
  syncProjectsWithOneDrive,
  type SyncConflict,
  type SyncOptions,
  type SyncResult,
} from '@/lib/oneDriveSync';

export type SyncRecoveryResult = SyncResult & {
  recoveredConflictCount: number;
};

export function formatSyncConflictReviewMessage(conflicts: SyncConflict[]) {
  if (conflicts.length === 1) {
    return `Sync needs review for ${conflicts[0].name}. Your local changes are safe. Review the project, then retry sync.`;
  }

  return `Sync needs review for ${conflicts.length} projects. Your local changes are safe. Review them, then retry sync.`;
}

export async function syncProjectsWithOneDriveRecovery(
  token: string,
  options: SyncOptions = {}
): Promise<SyncRecoveryResult> {
  const firstResult = await syncProjectsWithOneDrive(token, options);
  if (firstResult.conflicts.length === 0) {
    return { ...firstResult, recoveredConflictCount: 0 };
  }

  const conflictProjectIds = firstResult.conflicts.map((conflict) => conflict.id);
  const recoveryResult = await syncProjectsWithOneDrive(token, {
    pushProjectIds: conflictProjectIds,
  });

  return {
    ...recoveryResult,
    recoveredConflictCount: Math.max(0, firstResult.conflicts.length - recoveryResult.conflicts.length),
  };
}
