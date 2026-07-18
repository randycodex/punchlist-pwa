import { describe, expect, it } from 'vitest';
import { resolveProjectSyncStates } from '@/lib/oneDriveSync';

describe('OneDrive hard-delete reconciliation', () => {
  it('keeps a deletion tombstone when the OneDrive file is older', () => {
    const deletion = { updatedAt: '2026-07-18T12:00:00.000Z' };
    const result = resolveProjectSyncStates(
      { 'project-1': deletion },
      new Map(),
      new Map([
        [
          'project-1',
          [
            {
              id: 'remote-project-1',
              name: 'project-1.json',
              lastModifiedDateTime: '2026-07-18T11:59:00.000Z',
            },
          ],
        ],
      ])
    );

    expect(result.syncStates).toEqual({ 'project-1': deletion });
    expect(result.revivedRemoteProjectIds.has('project-1')).toBe(false);
  });

  it('revives a project only when its OneDrive file was recreated after deletion', () => {
    const result = resolveProjectSyncStates(
      { 'project-1': { updatedAt: '2026-07-18T12:00:00.000Z' } },
      new Map(),
      new Map([
        [
          'project-1',
          [
            {
              id: 'remote-project-1',
              name: 'project-1.json',
              lastModifiedDateTime: '2026-07-18T12:01:00.000Z',
            },
          ],
        ],
      ])
    );

    expect(result.syncStates).toEqual({});
    expect(result.revivedRemoteProjectIds.has('project-1')).toBe(true);
  });
});
