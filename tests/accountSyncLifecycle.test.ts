import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ cleanups: [] as Array<() => void>, pathname: '/project/local',
  refresh: vi.fn(), backup: vi.fn(), restore: vi.fn(), token: vi.fn(), status: vi.fn(), mark: vi.fn(),
  microsoft: { isSignedIn: true, accountEmail: 'member@example.com', ensureAccessToken: vi.fn() },
  collaboration: { isSignedIn: true, user: { id: 'member' } },
  sync: { status: 'pending', sharedTransferStatus: null as string | null, localSaveStatus: 'saved',
    setStatus: vi.fn(), setSyncConflicts: vi.fn(), markSharedUpdateAvailable: vi.fn(), clearSharedUpdateAvailable: vi.fn() },
}));
// Execute the component's effect lifecycles against real EventTargets and fake
// time, keeping transport promises under test control without a signed-in browser.
vi.mock('react', () => ({
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) m.cleanups.push(cleanup); },
}));
vi.mock('next/navigation', () => ({ usePathname: () => m.pathname }));
vi.mock('@/contexts/MicrosoftAuthContext', () => ({ useMicrosoftAuth: () => m.microsoft }));
vi.mock('@/contexts/CollaborationAuthContext', () => ({ useCollaborationAuth: () => m.collaboration }));
vi.mock('@/contexts/SyncStatusContext', () => ({ useSyncStatus: () => m.sync }));
vi.mock('@/lib/db', () => ({ getAllProjects: async () => [{ id: 'local', sharedProjectId: 'team' }],
  createProject: vi.fn(), saveDownloadedProjectIfUnchanged: vi.fn() }));
vi.mock('@/lib/captureJournal', () => ({ hasProjectCaptureDrafts: async () => false }));
vi.mock('@/lib/collaboration', () => ({ getSharedProjectSnapshot: vi.fn(), listMySharedProjects: async () => [] }));
vi.mock('@/lib/pendingSync', () => ({ loadPendingSyncState: () => ({ projectIds: ['local'], fullSyncNeeded: false }),
  restorePendingSyncStateFromDurableStorage: async () => {}, pausePendingSyncAutoRetry: vi.fn() }));
vi.mock('@/lib/oneDriveSync', () => ({ mergePersonalProjectsFromOneDrive: vi.fn(), restoreMissingProjectsFromOneDrive: m.restore }));
vi.mock('@/features/sync/runManualOneDriveSync', () => ({ runManualOneDriveSync: m.backup }));
vi.mock('@/features/sync/refreshSharedProject', () => ({ refreshSharedProject: m.refresh }));
vi.mock('@/lib/collaboration/sharedAreaSyncQueue', () => ({ flushPendingSharedAreaSyncs: async () => {} }));
vi.mock('@/lib/collaboration/sharedProjectMetadataSyncQueue', () => ({ flushPendingSharedProjectMetadataSyncs: async () => {} }));
vi.mock('@/lib/localMediaRecovery', () => ({ registerLocalMediaRecovery: () => () => {} }));
import AccountSync from '@/features/sync/AccountSync';
import { SHARED_UPDATE_AVAILABLE_EVENT } from '@/lib/collaboration/sharedUpdateEvents';

let documentTarget: EventTarget & { visibilityState: string; activeElement: null };
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible', activeElement: null });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('HTMLElement', class {});
  m.microsoft.isSignedIn = true; m.microsoft.accountEmail = 'member@example.com';
  m.collaboration.user = { id: 'member' }; m.collaboration.isSignedIn = true;
  m.microsoft.ensureAccessToken.mockResolvedValue('token');
  m.sync.status = 'pending'; m.sync.localSaveStatus = 'saved'; m.sync.sharedTransferStatus = null;
  m.refresh.mockResolvedValue('current');
  m.restore.mockResolvedValue({ restoredProjectIds: [] });
  m.backup.mockResolvedValue({ status: 'success' });
});
afterEach(() => {
  m.cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('account team refresh and independent backup lifecycles', () => {
  it('downloads realtime team changes while a OneDrive backup is still running', async () => {
    let finish!: (result: unknown) => void;
    m.backup.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    AccountSync();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.backup).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ['local'], scope: 'selected' }));
    expect(m.refresh).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event(SHARED_UPDATE_AVAILABLE_EVENT));
    await vi.advanceTimersByTimeAsync(250);
    expect(m.refresh).toHaveBeenCalledTimes(2);
    expect(m.backup).toHaveBeenCalledTimes(1);
    expect(m.sync.setStatus).not.toHaveBeenCalledWith('syncing');
    finish({ status: 'success' });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('keeps dirty-project notices without triggering another automatic download', async () => {
    m.refresh.mockResolvedValue('review');
    AccountSync(); await vi.advanceTimersByTimeAsync(3_000);
    expect(m.sync.markSharedUpdateAvailable).toHaveBeenCalledWith('local', { refresh: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(m.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not let a late backup replace the status of a new manual team sync', async () => {
    let finish!: (result: unknown) => void;
    m.backup.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    AccountSync(); await vi.advanceTimersByTimeAsync(3_000);
    m.sync.status = 'syncing';
    finish({ status: 'success' }); await vi.advanceTimersByTimeAsync(0);
    expect(m.sync.setStatus).not.toHaveBeenCalled();
  });

  it('does not acknowledge backup UI state after the account changes', async () => {
    let finish!: (result: unknown) => void;
    m.backup.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    AccountSync(); await vi.advanceTimersByTimeAsync(3_000);
    m.microsoft.accountEmail = 'other@example.com';
    finish({ status: 'success' }); await vi.advanceTimersByTimeAsync(0);
    expect(m.sync.setStatus).not.toHaveBeenCalled();
  });

  it('retains the editor and hidden-tab guards for realtime events', async () => {
    AccountSync();
    documentTarget.visibilityState = 'hidden';
    window.dispatchEvent(new Event(SHARED_UPDATE_AVAILABLE_EVENT));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(m.refresh).not.toHaveBeenCalled();
    documentTarget.visibilityState = 'visible'; m.pathname = '/project/local/area/one';
    // Effect cleanup and re-entry model a navigation, including the latest-ref update.
    m.cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
    AccountSync(); await vi.advanceTimersByTimeAsync(3_000);
    expect(m.refresh).not.toHaveBeenCalled();
    m.pathname = '/project/local';
  });
});
