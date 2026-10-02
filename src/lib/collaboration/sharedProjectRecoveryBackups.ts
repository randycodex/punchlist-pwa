import {
  acknowledgeSharedProjectRecoveryBackup,
  getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject,
  getPendingSharedProjectRecoveryIds,
  getSharedProjectRecoveryMetadata,
  getSharedProjectRecoveryProject,
  recordSharedProjectRecoveryBackupFailure,
  SHARED_SYNC_QUEUE_CHANGED_EVENT,
} from '@/lib/db';
import { withBrowserLock } from '@/lib/browserLocks';
import { localAccountKey } from '@/lib/localAccount';
import { captureSharedProjectBackup } from './sharedProjectSnapshots';
import { getCollaborationErrorMessage } from './sharedProjects';

const dependencies = {
  getPendingSharedProjectRecoveryIds,
  getSharedProjectRecoveryMetadata,
  getSharedProjectRecoveryProject,
  getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject,
  captureSharedProjectBackup,
  acknowledgeSharedProjectRecoveryBackup,
  recordSharedProjectRecoveryBackupFailure,
  now: () => new Date(),
};

/** Upload saved copies separately from sending edits or applying team updates. */
export async function flushSharedProjectRecoveryBackups(
  deps = dependencies,
  isActive = () => true
) {
  return withBrowserLock(localAccountKey('shared-project-recovery-uploads'), async () => {
    const ids = await deps.getPendingSharedProjectRecoveryIds(deps.now());
    let uploaded = 0;
    for (const id of ids) {
      if (!isActive()) break;
      const record = await deps.getSharedProjectRecoveryMetadata(id);
      if (!record || record.uploadStatus !== 'pending') continue;
      // Give inspection changes priority over a large historical upload.
      const [areas, metadata] = await Promise.all([
        deps.getPendingSharedAreaSyncsForProject(record.localProjectId),
        deps.getPendingSharedProjectMetadataSyncForProject(record.localProjectId),
      ]);
      if (areas.length || metadata) continue;
      try {
        const project = await deps.getSharedProjectRecoveryProject(id);
        if (!project || project.sharedProjectId !== record.sharedProjectId) {
          throw new Error('The saved device copy is unavailable.');
        }
        if (!isActive()) break;
        const backupId = await deps.captureSharedProjectBackup(
          project, record.reason, `Device copy saved at ${record.capturedAt.toISOString()}.`, record.id
        );
        if (typeof backupId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(backupId)) {
          throw new Error('The team service did not confirm the backup.');
        }
        await deps.acknowledgeSharedProjectRecoveryBackup(id, backupId);
        uploaded += 1;
      } catch (error) {
        const delay = Math.min(300_000, 30_000 * 2 ** Math.min(record.attemptCount, 4));
        await deps.recordSharedProjectRecoveryBackupFailure(
          id, getCollaborationErrorMessage(error), new Date(deps.now().getTime() + delay)
        );
        // A service interruption should not trigger a burst of large requests.
        break;
      }
    }
    return { uploaded };
  });
}

/** The durable queue survives reloads. A signed-in workspace owns this lifecycle. */
export function startSharedProjectRecoveryBackupSync() {
  if (typeof window === 'undefined') return () => {};
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const canRun = () => active && navigator.onLine !== false && document.visibilityState !== 'hidden';
  const schedule = (delayMs = 5_000) => {
    if (!active || timer || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
  };
  async function run() {
    if (!canRun()) return;
    running = true;
    try {
      await flushSharedProjectRecoveryBackups(dependencies, canRun);
    } catch {
      // IndexedDB or sign-in may be temporarily unavailable. Keep the saved copies.
    } finally {
      running = false;
      schedule(30_000);
    }
  }
  const wake = () => { if (canRun()) schedule(); };
  window.addEventListener('online', wake);
  window.addEventListener(SHARED_SYNC_QUEUE_CHANGED_EVENT, wake);
  document.addEventListener('visibilitychange', wake);
  schedule();
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
    window.removeEventListener('online', wake);
    window.removeEventListener(SHARED_SYNC_QUEUE_CHANGED_EVENT, wake);
    document.removeEventListener('visibilitychange', wake);
  };
}
