import { isAreaLockError } from './areaLockError';

type PausedSharedSyncRecord = {
  blockedByConflict: boolean;
  lastError: string | null;
  lastErrorCode?: string | null;
  readyAfterConflictReview?: boolean;
};

/** Supabase errors are plain objects; browser and validation errors can be Error instances. */
export function getSharedSyncFailureCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const input = error as { code?: unknown; name?: unknown };
  const code = typeof input.code === 'string' ? input.code : null;
  if (code === 'SHARED_PROJECT_AREA_CONFLICT' || code === 'SHARED_PROJECT_METADATA_CONFLICT') return '40001';
  return code || (typeof input.name === 'string' ? input.name : null);
}

/** Retry pauses for permission or invalid payloads do not indicate competing edits. */
export function isPendingSharedSyncVersionConflict(record: PausedSharedSyncRecord): boolean {
  if (!record.blockedByConflict) return false;
  if (record.lastErrorCode) {
    return record.lastErrorCode === '40001' || record.lastErrorCode === 'PT409'
      || record.lastErrorCode === 'SHARED_PROJECT_AREA_CONFLICT'
      || record.lastErrorCode === 'SHARED_PROJECT_METADATA_CONFLICT';
  }
  if (record.readyAfterConflictReview) return true;
  const message = (record.lastError ?? '').toLowerCase();
  return message.includes('newer team data')
    || message.includes('newer team area data')
    || message.includes('newer team details')
    || message.includes('team updates were merged. review this area');
}

export function isPendingSharedSyncLock(record: PausedSharedSyncRecord): boolean {
  if (!record.blockedByConflict) return false;
  if (isPendingSharedSyncVersionConflict(record)) return false;
  if (record.lastErrorCode) return record.lastErrorCode === '55P03';
  return isAreaLockError(record.lastError);
}
