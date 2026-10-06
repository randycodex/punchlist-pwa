'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import {
  createProject, getAllProjects, saveDownloadedProjectIfUnchanged,
} from '@/lib/db';
import { hasProjectCaptureDrafts } from '@/lib/captureJournal';
import {
  getSharedProjectSnapshot, listMySharedProjects,
} from '@/lib/collaboration';
import { findPreferredLocalSharedProject } from '@/features/collaboration/sharedProjectDirectoryLocal';
import {
  loadPendingSyncState, restorePendingSyncStateFromDurableStorage,
  pausePendingSyncAutoRetry,
} from '@/lib/pendingSync';
import { mergePersonalProjectsFromOneDrive, restoreMissingProjectsFromOneDrive } from '@/lib/oneDriveSync';
import { runManualOneDriveSync } from './runManualOneDriveSync';
import { refreshSharedProject } from './refreshSharedProject';
import { flushPendingSharedAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';
import { flushPendingSharedProjectMetadataSyncs } from '@/lib/collaboration/sharedProjectMetadataSyncQueue';
import { registerLocalMediaRecovery } from '@/lib/localMediaRecovery';
import { recoverLocalTeamAttachments } from './recoverLocalTeamAttachments';

// Browser databases are independent. Use the existing account cloud stores as
// the bridge, without automatically resolving conflicting or unsent work.
export default function AccountSync() {
  const pathname = usePathname();
  const microsoft = useMicrosoftAuth();
  const collaboration = useCollaborationAuth();
  const sync = useSyncStatus();
  const latest = useRef({ pathname, microsoft, collaboration, sync });
  useEffect(() => { latest.current = { pathname, microsoft, collaboration, sync }; });

  useEffect(() => {
    const userId = collaboration.user?.id;
    const email = microsoft.accountEmail;
    if (!collaboration.isSignedIn || !userId) return;
    let active = true;
    const canApply = () => active && latest.current.collaboration.isSignedIn
      && latest.current.collaboration.user?.id === userId && latest.current.microsoft.accountEmail === email;
    const unregister = registerLocalMediaRecovery((projectId, areaId) =>
      recoverLocalTeamAttachments(projectId, canApply, areaId));
    return () => { active = false; unregister(); };
  }, [collaboration.isSignedIn, collaboration.user?.id, microsoft.accountEmail]);

  useEffect(() => {
    let active = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryAfter = 0;

    function notify(projectId: string) {
      window.dispatchEvent(new CustomEvent('punchlist-project-synced', { detail: { projectId } }));
    }

    async function run() {
      const state = latest.current;
      if (!active || running || !navigator.onLine || document.visibilityState === 'hidden'
        || state.sync.status === 'syncing' || state.sync.sharedTransferStatus
        || state.sync.localSaveStatus !== 'saved' || Date.now() < retryAfter) return;
      if (!state.microsoft.isSignedIn && !state.collaboration.isSignedIn) return;
      running = true;
      const accountEmail = state.microsoft.accountEmail;
      const userId = state.collaboration.user?.id;
      const sameAccount = () => active && latest.current.microsoft.accountEmail === accountEmail
        && latest.current.collaboration.user?.id === userId;
      // Pulls may refresh list pages; editors retain their in-memory working
      // copy. An area also checks for a clean download before its initial load.
      const canPull = () => sameAccount()
        && latest.current.pathname === state.pathname
        && (state.pathname === '/' || /^\/project\/[^/]+\/?$/.test(state.pathname))
        && latest.current.sync.status !== 'syncing'
        && !latest.current.sync.sharedTransferStatus
        && !(document.activeElement instanceof HTMLElement
          && (document.activeElement.matches('input, textarea, select') || document.activeElement.isContentEditable));
      try {
        await restorePendingSyncStateFromDurableStorage();
        if (state.collaboration.isSignedIn && sameAccount()) {
          try {
            await flushPendingSharedAreaSyncs();
            if (sameAccount()) await flushPendingSharedProjectMetadataSyncs();
          } catch (error) { console.info('Saved Team changes remain queued:', error); }
        }
        let projects = await getAllProjects();
        if (state.collaboration.isSignedIn && userId && canPull()) {
          try {
            if (state.pathname === '/') {
              for (const entry of await listMySharedProjects()) {
                if (!canPull()) break;
                // Reconnection, Trash, ID collisions, and local detached work
                // require the existing explicit review flow.
                if (findPreferredLocalSharedProject(projects, entry)
                  || projects.some((project) => project.id === entry.localProjectId)) continue;
                const seed = { ...createProject(entry.projectName), id: entry.localProjectId,
                  sharedProjectId: entry.projectId, sharedProjectLinkedAt: new Date() };
                try {
                  const downloaded = await getSharedProjectSnapshot(seed);
                  if (await saveDownloadedProjectIfUnchanged(downloaded.project, null, { canApply: canPull })) {
                    projects = [...projects, downloaded.project];
                    notify(downloaded.project.id);
                  }
                } catch (error) { console.info('Team project download deferred:', error); }
              }
            }
            for (const project of projects) {
              if (!canPull()) break;
              if (project.deletedAt || !project.sharedProjectId) continue;
              if (state.pathname !== '/' && state.pathname !== `/project/${project.id}`) continue;
              try {
                const result = await refreshSharedProject(project.id, canPull);
                if (result === 'review') state.sync.markSharedUpdateAvailable(project.id);
                if (result === 'current' || result === 'updated') state.sync.clearSharedUpdateAvailable(project.id);
                if (result === 'updated') notify(project.id);
              } catch (error) { console.info('Team project refresh deferred:', error); }
            }
          } catch (error) {
            console.info('Team refresh deferred; personal sync can continue:', error);
          }
        }
        if (!state.microsoft.isSignedIn || !sameAccount()) return;
        const token = await state.microsoft.ensureAccessToken({ interactive: false });
        if (!token || !sameAccount()) return;
        projects = await getAllProjects();
        const pending = loadPendingSyncState();
        const dirty = new Set(pending.projectIds);
        const personal = projects.filter((project) => !project.sharedProjectId && !project.deletedAt);
        if (canPull() && !pending.fullSyncNeeded) {
          const cleanIds: string[] = [];
          for (const project of personal) {
            if (!dirty.has(project.id) && !await hasProjectCaptureDrafts(project.id)) cleanIds.push(project.id);
          }
          if (cleanIds.length) {
            const merged = await mergePersonalProjectsFromOneDrive(token, cleanIds, { canApply: canPull });
            [...merged.updatedLocalProjectIds, ...merged.archivedLocalProjectIds].forEach(notify);
          }
        }
        if (canPull()) {
          const restored = await restoreMissingProjectsFromOneDrive(token, { downloadOnly: true, canApply: canPull });
          restored.restoredProjectIds.forEach(notify);
        }
        if (!sameAccount() || pending.autoRetryPaused
          || latest.current.sync.status === 'syncing' || latest.current.sync.sharedTransferStatus
          || (pending.retryNotBefore && new Date(pending.retryNotBefore).getTime() > Date.now())) return;
        const queuedIds = projects.filter((project) => !project.sharedProjectId
          && dirty.has(project.id)).map((project) => project.id);
        if (!queuedIds.length) return;
        state.sync.setStatus('syncing');
        const result = await runManualOneDriveSync({ ensureAccessToken: async () => token,
          scope: 'selected', projectIds: queuedIds });
        if (!sameAccount()) return;
        if (result.status === 'conflict') {
          state.sync.setSyncConflicts(result.conflicts);
          pausePendingSyncAutoRetry();
        }
        state.sync.setStatus(result.status === 'success'
          ? loadPendingSyncState().projectIds.length || loadPendingSyncState().fullSyncNeeded ? 'pending' : 'idle'
          : result.status === 'needs-auth' ? 'needs-auth' : 'pending');
        if (result.status !== 'success') retryAfter = Date.now() + 60_000;
      } catch (error) {
        retryAfter = Date.now() + 60_000;
        console.info('Account sync deferred; local work was kept:', error);
      } finally { running = false; }
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void run(); }, 3_000);
    }
    schedule();
    const interval = setInterval(() => { void run(); }, 30_000);
    window.addEventListener('online', schedule);
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('punchlist-local-save-status', schedule);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener('online', schedule);
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('punchlist-local-save-status', schedule);
    };
  }, [microsoft.isSignedIn, microsoft.accountEmail, collaboration.isSignedIn, collaboration.user?.id]);
  return null;
}
