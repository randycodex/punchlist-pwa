import { describe, expect, it } from 'vitest';
import { summarizePendingSharedSyncs } from '@/lib/db';

describe('shared sync indicator summary', () => {
  it('keeps permission, invalid payload and lock failures waiting without asking for conflict review', () => {
    const records = [
      { localProjectId: 'project', blockedByConflict: true, lastError: 'Permission denied', lastErrorCode: '42501' },
      { localProjectId: 'project', blockedByConflict: true, lastError: 'Invalid payload', lastErrorCode: '22023' },
      { localProjectId: 'project', blockedByConflict: true, lastError: 'Locked by another device', lastErrorCode: '55P03' },
    ];

    expect(summarizePendingSharedSyncs(records)).toEqual({
      pendingCount: 3, conflictCount: 0, lastConflictError: null,
    });
  });

  it('counts only genuine unreviewed conflicts when other sends are paused', () => {
    const records = [
      { localProjectId: 'project', blockedByConflict: true, lastError: 'Permission denied', lastErrorCode: '42501' },
      { localProjectId: 'project', blockedByConflict: true, lastError: 'Area version changed', lastErrorCode: 'PT409' },
      { localProjectId: 'project', blockedByConflict: false, lastError: null },
    ];

    expect(summarizePendingSharedSyncs(records)).toEqual({
      pendingCount: 3, conflictCount: 1, lastConflictError: 'Area version changed',
    });
  });

  it('shows reviewed areas as waiting to upload instead of asking for another review', () => {
    const records = [
      {
        localProjectId: 'project', blockedByConflict: true,
        readyAfterConflictReview: true, lastErrorCode: '40001',
        lastError: 'Team updates were merged. Review this area, then tap Sync Team Projects.',
      },
      {
        localProjectId: 'project', blockedByConflict: true,
        readyAfterConflictReview: true, lastErrorCode: null,
        lastError: 'Team updates were merged. Review this area, then tap Sync Team Projects.',
      },
    ];

    expect(summarizePendingSharedSyncs(records)).toEqual({
      pendingCount: 2, conflictCount: 0, lastConflictError: null,
    });
  });

  it('recognizes a legacy version rejection while hiding conflicts from inactive copies', () => {
    const records = [
      { localProjectId: 'inactive', blockedByConflict: true, lastError: 'Newer team data' },
      { localProjectId: 'active', blockedByConflict: true, lastError: 'This area has newer team data.' },
      { localProjectId: 'active', blockedByConflict: true, lastError: 'Permission denied' },
    ];

    expect(summarizePendingSharedSyncs(records, new Set(['active']))).toEqual({
      pendingCount: 2, conflictCount: 1, lastConflictError: 'This area has newer team data.',
    });
  });
});
