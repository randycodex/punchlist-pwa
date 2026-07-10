import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingProjectSync,
  clearPendingSyncState,
  hasPendingSyncState,
  isPendingSyncAutoRetryPaused,
  loadPendingSyncState,
  pausePendingSyncAutoRetry,
  queuePendingSync,
  recordPendingSyncRetry,
  resumePendingSyncAutoRetry,
} from '@/lib/pendingSync';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('window', {});
  clearPendingSyncState();
});

describe('pending manual sync state', () => {
  it('coalesces repeated edits and preserves a full-sync request', () => {
    queuePendingSync('project-1');
    queuePendingSync('project-1');
    queuePendingSync('project-2');
    queuePendingSync(undefined, { fullSync: true });

    expect(loadPendingSyncState()).toMatchObject({
      projectIds: ['project-1', 'project-2'],
      fullSyncNeeded: true,
    });
    expect(hasPendingSyncState()).toBe(true);
  });

  it('clears only projects confirmed by a successful sync', () => {
    queuePendingSync('project-1');
    queuePendingSync('project-2');
    clearPendingProjectSync(['project-1']);

    expect(loadPendingSyncState().projectIds).toEqual(['project-2']);
  });

  it('keeps manual work pending while automatic retry is paused and resumed', () => {
    queuePendingSync('project-1');
    pausePendingSyncAutoRetry();
    expect(isPendingSyncAutoRetryPaused()).toBe(true);

    resumePendingSyncAutoRetry();
    expect(isPendingSyncAutoRetryPaused()).toBe(false);
    expect(hasPendingSyncState()).toBe(true);
  });

  it('records bounded retry metadata without clearing pending work', () => {
    queuePendingSync('project-1');
    const retry = recordPendingSyncRetry(1_000, { minDelayMs: 1_000, maxDelayMs: 5_000 });

    expect(retry.delayMs).toBe(1_000);
    expect(loadPendingSyncState()).toMatchObject({
      projectIds: ['project-1'],
      retryCount: 1,
      autoRetryPaused: false,
    });
  });
});
