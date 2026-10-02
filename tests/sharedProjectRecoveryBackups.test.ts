import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProject, deleteProject, getPendingSharedProjectRecoveryIds, getProject,
  listSharedProjectRecoveries, saveProjectPreserveTimestamps, saveReviewedSharedProject,
  SHARED_SYNC_QUEUE_CHANGED_EVENT, type SharedProjectRecoveryMetadata,
} from '@/lib/db';
import {
  flushSharedProjectRecoveryBackups,
  startSharedProjectRecoveryBackupSync,
} from '@/lib/collaboration/sharedProjectRecoveryBackups';

const { lifecycleCaptureMock } = vi.hoisted(() => ({ lifecycleCaptureMock: vi.fn() }));

vi.mock('@/lib/collaboration/sharedProjectSnapshots', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/collaboration/sharedProjectSnapshots')>(),
  captureSharedProjectBackup: lifecycleCaptureMock,
}));

const now = new Date('2026-10-02T23:00:00Z');
const confirmedId = '81795c6c-0244-4773-af5c-81b7e907565f';

function fixture() {
  const project = createProject('Saved Alafia inspection');
  project.sharedProjectId = confirmedId;
  const record: SharedProjectRecoveryMetadata = {
    id: crypto.randomUUID(), localProjectId: project.id, sharedProjectId: confirmedId,
    projectName: project.projectName, capturedAt: now, reason: 'before_pull',
    uploadStatus: 'pending', cloudBackupId: null, attemptCount: 0,
    nextAttemptAt: now, lastError: null,
  };
  const deps = {
    getPendingSharedProjectRecoveryIds: vi.fn(async () => [record.id]),
    getSharedProjectRecoveryMetadata: vi.fn(async () => record),
    getSharedProjectRecoveryProject: vi.fn(async () => project),
    getPendingSharedAreaSyncsForProject: vi.fn(async () => []),
    getPendingSharedProjectMetadataSyncForProject: vi.fn(async () => undefined),
    captureSharedProjectBackup: vi.fn(async () => confirmedId),
    acknowledgeSharedProjectRecoveryBackup: vi.fn(async () => {}),
    recordSharedProjectRecoveryBackupFailure: vi.fn(async () => {}),
    now: () => now,
  };
  return { deps, record, project };
}

describe('background device recovery upload', () => {
  it('confirms the server backup before acknowledging the immutable device copy', async () => {
    const { deps, record, project } = fixture();
    expect(await flushSharedProjectRecoveryBackups(deps)).toEqual({ uploaded: 1 });
    expect(deps.captureSharedProjectBackup).toHaveBeenCalledWith(
      project, 'before_pull', expect.any(String), record.id
    );
    expect(deps.acknowledgeSharedProjectRecoveryBackup).toHaveBeenCalledWith(record.id, confirmedId);
    expect(deps.recordSharedProjectRecoveryBackupFailure).not.toHaveBeenCalled();
  });

  it('keeps a failed copy pending, backs off, and stops the batch during service interruptions', async () => {
    const { deps, record } = fixture();
    deps.getPendingSharedProjectRecoveryIds.mockResolvedValue([record.id, 'next-copy']);
    deps.captureSharedProjectBackup.mockRejectedValue(new TypeError('Failed to fetch'));
    await flushSharedProjectRecoveryBackups(deps);
    expect(deps.acknowledgeSharedProjectRecoveryBackup).not.toHaveBeenCalled();
    expect(deps.recordSharedProjectRecoveryBackupFailure).toHaveBeenCalledWith(
      record.id, expect.any(String), new Date(now.getTime() + 30_000)
    );
    expect(deps.captureSharedProjectBackup).toHaveBeenCalledTimes(1);
  });

  it('caps repeated failures at a five-minute retry delay', async () => {
    const { deps, record } = fixture();
    record.attemptCount = 20;
    deps.captureSharedProjectBackup.mockRejectedValue(new Error('Service unavailable'));
    await flushSharedProjectRecoveryBackups(deps);
    expect(deps.recordSharedProjectRecoveryBackupFailure).toHaveBeenCalledWith(
      record.id, 'Service unavailable', new Date(now.getTime() + 300_000)
    );
  });

  it('prioritizes unsent inspection edits without loading historical photos', async () => {
    const { deps } = fixture();
    deps.getPendingSharedProjectMetadataSyncForProject.mockResolvedValue({} as never);
    expect(await flushSharedProjectRecoveryBackups(deps)).toEqual({ uploaded: 0 });
    expect(deps.getSharedProjectRecoveryProject).not.toHaveBeenCalled();
    expect(deps.captureSharedProjectBackup).not.toHaveBeenCalled();
    expect(deps.recordSharedProjectRecoveryBackupFailure).not.toHaveBeenCalled();
  });

  it('does not retry copies already acknowledged by another tab', async () => {
    const { deps, record } = fixture();
    record.uploadStatus = 'uploaded';
    await flushSharedProjectRecoveryBackups(deps);
    expect(deps.getSharedProjectRecoveryProject).not.toHaveBeenCalled();
  });

  it('rejects a malformed server acknowledgement and keeps the saved copy pending', async () => {
    const { deps } = fixture();
    deps.captureSharedProjectBackup.mockResolvedValue('');
    await flushSharedProjectRecoveryBackups(deps);
    expect(deps.acknowledgeSharedProjectRecoveryBackup).not.toHaveBeenCalled();
    expect(deps.recordSharedProjectRecoveryBackupFailure).toHaveBeenCalled();
  });

  it('does not start a queued upload after sign-out or hiding the app', async () => {
    const { deps } = fixture();
    let active = true;
    // Use a matching project to exercise the cancellation after hydration.
    const project = createProject('Saved'); project.sharedProjectId = confirmedId;
    deps.getSharedProjectRecoveryProject.mockImplementation(async () => { active = false; return project; });
    await flushSharedProjectRecoveryBackups(deps, () => active);
    expect(deps.captureSharedProjectBackup).not.toHaveBeenCalled();
    expect(deps.recordSharedProjectRecoveryBackupFailure).not.toHaveBeenCalled();
  });
});

describe('device recovery upload lifecycle', () => {
  const projectIds: string[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const id of projectIds.splice(0)) await deleteProject(id);
    lifecycleCaptureMock.mockReset();
  });

  async function savedCopy() {
    const project = createProject('Durable pending inspection');
    project.sharedProjectId = crypto.randomUUID();
    await saveProjectPreserveTimestamps(project);
    projectIds.push(project.id);
    const source = (await getProject(project.id))!;
    expect(await saveReviewedSharedProject(source, source, [], false)).toBe(true);
    const [record] = await listSharedProjectRecoveries(project.sharedProjectId);
    return { source, record };
  }

  function browserState(options: { hidden?: boolean; offline?: boolean } = {}) {
    const browser = new EventTarget();
    const page = new EventTarget();
    const state = { hidden: !!options.hidden, offline: !!options.offline };
    Object.defineProperty(page, 'visibilityState', { get: () => state.hidden ? 'hidden' : 'visible' });
    vi.stubGlobal('window', browser);
    vi.stubGlobal('document', page);
    vi.stubGlobal('navigator', { get onLine() { return !state.offline; } });
    // Leave IndexedDB's setImmediate scheduling real while controlling only the worker's clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    lifecycleCaptureMock.mockResolvedValue(confirmedId);
    return { browser, page, state };
  }

  async function waitForUpload() {
    // Real IndexedDB transactions can finish over multiple event-loop turns.
    await vi.waitFor(() => expect(lifecycleCaptureMock).toHaveBeenCalled(), { timeout: 1_000 });
    await vi.waitFor(async () => expect(await getPendingSharedProjectRecoveryIds()).toEqual([]), { timeout: 1_000 });
  }

  it('leaves a hidden Safari workspace pending and starts its saved queue when it becomes visible', async () => {
    const { source, record } = await savedCopy();
    const { page, state } = browserState({ hidden: true });
    cleanups.push(startSharedProjectRecoveryBackupSync());

    await vi.advanceTimersByTimeAsync(5_000);
    expect(lifecycleCaptureMock).not.toHaveBeenCalled();
    expect(await getPendingSharedProjectRecoveryIds()).toContain(record.id);

    state.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForUpload();

    expect(lifecycleCaptureMock).toHaveBeenCalledWith(
      source, 'before_pull', expect.any(String), record.id
    );
  });

  it('keeps offline copies pending and wakes the durable queue when the online event arrives', async () => {
    const { record } = await savedCopy();
    const { browser, state } = browserState({ offline: true });
    cleanups.push(startSharedProjectRecoveryBackupSync());

    await vi.advanceTimersByTimeAsync(5_000);
    expect(lifecycleCaptureMock).not.toHaveBeenCalled();
    expect(await getPendingSharedProjectRecoveryIds()).toContain(record.id);

    state.offline = false;
    browser.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForUpload();
    expect(lifecycleCaptureMock).toHaveBeenCalledTimes(1);
  });

  it('removes timers and event listeners on cleanup, then resumes the saved queue in a new lifecycle', async () => {
    const { record } = await savedCopy();
    const { browser, page } = browserState();
    const stop = startSharedProjectRecoveryBackupSync();
    stop();
    browser.dispatchEvent(new Event('online'));
    browser.dispatchEvent(new Event(SHARED_SYNC_QUEUE_CHANGED_EVENT));
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(lifecycleCaptureMock).not.toHaveBeenCalled();
    expect(await getPendingSharedProjectRecoveryIds()).toContain(record.id);
    expect(vi.getTimerCount()).toBe(0);

    cleanups.push(startSharedProjectRecoveryBackupSync());
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForUpload();
    expect(lifecycleCaptureMock).toHaveBeenCalledTimes(1);
  });
});
