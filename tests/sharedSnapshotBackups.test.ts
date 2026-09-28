import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  fromMock,
  limitMock,
  maybeSingleMock,
  selectMock,
} = vi.hoisted(() => {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  const limitMock = vi.fn();
  const maybeSingleMock = vi.fn();
  const selectMock = vi.fn<(columns: string) => typeof query>(() => query);
  query.select = selectMock;
  query.eq = vi.fn(() => query);
  query.order = vi.fn(() => query);
  query.limit = limitMock;
  query.maybeSingle = maybeSingleMock;
  return {
    fromMock: vi.fn(() => query),
    limitMock,
    maybeSingleMock,
    selectMock,
  };
});

vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({ from: fromMock }),
}));

import { createProject } from '@/lib/db';
import { getSharedProjectBackupPreview, listSharedProjectBackups } from '@/lib/collaboration/sharedProjectSnapshots';

const backupRow = {
  id: 'backup-1',
  project_id: 'shared-project-1',
  project_name: 'Lean backup',
  captured_by_user_id: 'user-1',
  captured_at: '2026-07-17T12:00:00.000Z',
  reason: 'manual' as const,
  note: null,
};

describe('shared snapshot backup listing', () => {
  beforeEach(() => {
    fromMock.mockClear();
    selectMock.mockClear();
    limitMock.mockReset();
    maybeSingleMock.mockReset();
  });

  it('lists backup metadata without downloading historical project payloads', async () => {
    limitMock.mockResolvedValue({ data: [backupRow], error: null });

    const backups = await listSharedProjectBackups('shared-project-1');

    expect(selectMock).toHaveBeenCalledWith(
      'id, project_id, project_name, captured_by_user_id, captured_at, reason, note'
    );
    expect(selectMock.mock.calls[0][0]).not.toContain('project_payload');
    expect(backups[0]).toMatchObject({ projectName: 'Lean backup' });
  });

  it('falls back to the legacy payload only when project_name is unavailable', async () => {
    limitMock
      .mockResolvedValueOnce({ data: null, error: { code: '42703', message: 'project_name does not exist' } })
      .mockResolvedValueOnce({
        data: [{
          ...backupRow,
          project_name: undefined,
          project_payload: { projectName: 'Legacy backup' },
        }],
        error: null,
      });

    const backups = await listSharedProjectBackups('shared-project-1');

    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(selectMock.mock.calls[1][0]).toContain('project_payload');
    expect(backups[0]).toMatchObject({ projectName: 'Legacy backup' });
  });

  it('loads one backup payload on demand for an impact preview', async () => {
    const project = createProject('Team project');
    project.sharedProjectId = 'shared-project-1';
    maybeSingleMock.mockResolvedValue({
      data: { project_payload: JSON.parse(JSON.stringify(project)), payload_version: 1, captured_at: backupRow.captured_at },
      error: null,
    });

    const preview = await getSharedProjectBackupPreview(project, 'backup-1');

    expect(preview.projectName).toBe('Team project');
    expect(selectMock).toHaveBeenCalledWith('project_payload, payload_version, captured_at');
    expect(fromMock).toHaveBeenCalledWith('shared_project_snapshot_history');
  });
});
