import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runManualOneDriveRestore,
  runManualOneDriveSync,
} from '@/features/sync/runManualOneDriveSync';
import {
  clearPendingSyncState,
  hasPendingSyncState,
  loadPendingSyncState,
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

describe('manual OneDrive backup coordinator', () => {
  it('requires an explicit authenticated action', async () => {
    const backupProjects = vi.fn();
    const result = await runManualOneDriveSync({
      ensureAccessToken: async () => null,
      backupProjects,
    });

    expect(result).toEqual({ status: 'needs-auth' });
    expect(backupProjects).not.toHaveBeenCalled();
  });

  it('backs up only queued projects and clears them after remote confirmation', async () => {
    queuePendingSync('project-1');
    const backupProjects = vi.fn(async () => ({
      conflicts: [],
      backedUpProjectIds: ['project-1'],
      syncedAt: '2026-01-01T12:00:00.000Z',
    }));

    const result = await runManualOneDriveSync({
      ensureAccessToken: async () => 'token',
      backupProjects,
    });

    expect(backupProjects).toHaveBeenCalledWith('token', ['project-1']);
    expect(result).toEqual({
      status: 'success',
      syncedAt: '2026-01-01T12:00:00.000Z',
      backedUpProjectCount: 1,
    });
    expect(hasPendingSyncState()).toBe(false);
  });

  it('keeps local work pending when OneDrive has a newer backup', async () => {
    queuePendingSync('project-1');
    const result = await runManualOneDriveSync({
      ensureAccessToken: async () => 'token',
      backupProjects: async () => ({
        conflicts: [{ id: 'project-1', name: 'Project 1' }],
        backedUpProjectIds: [],
        syncedAt: '2026-01-01T12:00:00.000Z',
      }),
    });

    expect(result.status).toBe('conflict');
    expect(hasPendingSyncState()).toBe(true);
  });

  it('does not clear edits queued while a sync is still running', async () => {
    queuePendingSync('project-1');

    const result = await runManualOneDriveSync({
      ensureAccessToken: async () => 'token',
      backupProjects: async () => {
        queuePendingSync('project-2');
        return {
          conflicts: [],
          backedUpProjectIds: ['project-1'],
          syncedAt: '2026-01-01T12:00:00.000Z',
        };
      },
    });

    expect(result.status).toBe('success');
    expect(loadPendingSyncState().projectIds).toEqual(['project-1', 'project-2']);
  });

  it('refreshes and retries once when Microsoft loses a remote object', async () => {
    queuePendingSync('project-1');
    const backupProjects = vi.fn()
      .mockRejectedValueOnce(new Error('The object can not be found here.'))
      .mockResolvedValueOnce({
        conflicts: [],
        backedUpProjectIds: ['project-1'],
        syncedAt: '2026-01-01T12:00:00.000Z',
      });

    const result = await runManualOneDriveSync({
      ensureAccessToken: async () => 'token',
      backupProjects,
    });

    expect(backupProjects).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
    expect(hasPendingSyncState()).toBe(false);
  });

  it('keeps work queued with a retry message when the missing object persists', async () => {
    queuePendingSync('project-1');
    const backupProjects = vi.fn()
      .mockRejectedValue(new Error('The object can not be found here.'));

    const result = await runManualOneDriveSync({
      ensureAccessToken: async () => 'token',
      backupProjects,
    });

    expect(backupProjects).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      status: 'retry',
      message: 'Saved locally. OneDrive is still catching up. Tap Backup to try again in about 15 seconds.',
    });
    expect(hasPendingSyncState()).toBe(true);
  });

  it('restores missing projects without invoking backup', async () => {
    const restoreProjects = vi.fn(async () => ({
      restoredProjectIds: ['project-2'],
      skippedProjectIds: ['project-1'],
    }));
    const result = await runManualOneDriveRestore({
      ensureAccessToken: async () => 'token',
      restoreProjects,
    });

    expect(restoreProjects).toHaveBeenCalledWith('token');
    expect(result).toEqual({ status: 'success', restoredProjectCount: 1 });
  });
});
