import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runManualOneDriveSync } from '@/features/sync/runManualOneDriveSync';
import {
  clearPendingSyncState,
  hasPendingSyncState,
  queuePendingSync,
} from '@/lib/pendingSync';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('window', {});
  clearPendingSyncState();
});

describe('manual OneDrive sync coordinator', () => {
  it('requires an explicit authenticated action', async () => {
    const syncProjects = vi.fn();
    const result = await runManualOneDriveSync({
      ensureAccessToken: async () => null,
      syncProjects,
    });

    expect(result).toEqual({ status: 'needs-auth' });
    expect(syncProjects).not.toHaveBeenCalled();
  });

  it('syncs only queued projects and clears them after remote confirmation', async () => {
    queuePendingSync('project-1');
    const syncProjects = vi.fn(async () => ({
      conflicts: [],
      syncedAt: '2026-01-01T12:00:00.000Z',
      recoveredConflictCount: 0,
    }));

    const result = await runManualOneDriveSync({
      ensureAccessToken: async () => 'token',
      syncProjects,
    });

    expect(syncProjects).toHaveBeenCalledWith('token', { pushProjectIds: ['project-1'] });
    expect(result).toEqual({ status: 'success', syncedAt: '2026-01-01T12:00:00.000Z' });
    expect(hasPendingSyncState()).toBe(false);
  });

  it('keeps local work pending when OneDrive reports a conflict', async () => {
    queuePendingSync('project-1');
    const result = await runManualOneDriveSync({
      ensureAccessToken: async () => 'token',
      syncProjects: async () => ({
        conflicts: [{ id: 'project-1', name: 'Project 1' }],
        syncedAt: '2026-01-01T12:00:00.000Z',
        recoveredConflictCount: 0,
      }),
    });

    expect(result.status).toBe('conflict');
    expect(hasPendingSyncState()).toBe(true);
  });
});
