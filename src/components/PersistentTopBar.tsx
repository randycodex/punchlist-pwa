'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import {
  getAllProjects,
  getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject,
  getProject,
  getProjectMetadata,
  saveProjectPreserveTimestamps,
  SHARED_SYNC_QUEUE_CHANGED_EVENT,
  summarizePendingSharedSyncs,
  type SharedSyncQueueSummary,
} from '@/lib/db';
import { hasPendingSyncState } from '@/lib/pendingSync';
import { mergePersonalProjectsFromOneDrive } from '@/lib/oneDriveSync';
import { runManualOneDriveSync } from '@/features/sync/runManualOneDriveSync';
import { syncSharedProject } from '@/features/sync/syncSharedProject';
import {
  formatPendingSharedPullMessage,
  formatPendingSharedPullSuccessMessage,
  type PendingSharedPullState,
} from '@/features/collaboration/manualSharedPull';
import { getCachedProjectName } from '@/lib/projectNavigationCache';
import {
  getCollaborationProfileDisplayName,
  getCollaborationProfileInitials,
  getActiveSharedProjectAreaClaimSummaries,
  getSharedProjectAccess,
  captureSharedProjectBackup,
  rebaseSharedProjectAreaSyncsAfterPull,
  releaseAbandonedSharedProjectArea,
  resumePendingSharedAreaSyncs,
  resumePendingSharedProjectMetadataSyncs,
  saveAndQueueSharedProjectMetadataSync,
} from '@/lib/collaboration';
import type { CollaborationAreaClaimSummary } from '@/lib/collaboration';
import CollaborationAvatar from '@/components/CollaborationAvatar';
import UserProfileModal from '@/components/UserProfileModal';
import AppMessageDialog from '@/components/AppMessageDialog';
import AppConfirmDialog from '@/components/AppConfirmDialog';
import ListSortMenu, { type ListSortOption } from '@/components/ListSortMenu';
import AreaListViewToggle from '@/components/AreaListViewToggle';
import type { AreaListViewMode } from '@/features/projects/areaListView';
import {
  Activity,
  ArchiveRestore,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CloudUpload,
  FileDown,
  KeyRound,
  LogIn,
  LogOut,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  PlusSquare,
  RefreshCw,
  Share2,
  Trash2,
  UserRound,
  UserPlus,
  Users,
} from 'lucide-react';

const projectTitleCache = new Map<string, string>();
const sharedProjectAccessCache = new Map<
  string,
  { isActiveMember: boolean; isOwner: boolean; hasError: boolean }
>();

type SortOption = ListSortOption;
type HomeMenuState = {
  context?: 'home' | 'project';
  sortOption: SortOption;
  areaViewMode: AreaListViewMode;
  showTrash: boolean;
  canAddArea: boolean;
  hasProjects: boolean;
  hasAreaGroups?: boolean;
  showOnlyAreaIssues?: boolean;
  isSingleProject: boolean;
  singleProjectId?: string;
  singleProjectName: string;
  selectionMode?: boolean;
  isSharedProject?: boolean;
  sharedProjectId?: string;
  hasTeamUpdates?: boolean;
  isCreatingJoinCode?: boolean;
  isLoadingSharedMembers?: boolean;
  isDisconnectingSharedProject?: boolean;
};

function setAppMenuOpenAttribute(open: boolean) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (open) {
    root.dataset.appMenuOpen = 'true';
  } else {
    delete root.dataset.appMenuOpen;
  }
}

export default function PersistentTopBar() {
  const pathname = usePathname();
  const {
    ensureAccessToken,
    isReady,
    isSignedIn,
    signIn: signInToMicrosoft,
    signOut: signOutOfMicrosoft,
  } = useMicrosoftAuth();
  const collaborationAuth = useCollaborationAuth();
  const {
    clearSharedUpdateAvailable,
    localSaveError,
    localSaveStatus,
    retryInSeconds,
    sharedSyncSummary,
    sharedTransferStatus,
    setStatus: setSyncStatus,
    setSyncConflicts,
    status,
  } = useSyncStatus();
  const hasQueuedSync = status === 'pending' && hasPendingSyncState();
  const displayStatus = status === 'pending' && !hasQueuedSync ? 'idle' : status;
  const displayRetryInSeconds = hasQueuedSync ? retryInSeconds : 0;
  const showAuth = pathname === '/';
  const [loadedProjectTitle, setLoadedProjectTitle] = useState({ projectId: '', title: '' });
  const [showHomeMenu, setShowHomeMenu] = useState(false);
  const [areAreaGroupsCollapsed, setAreAreaGroupsCollapsed] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [infoDialog, setInfoDialog] = useState<{ title: string; message: string } | null>(null);
  const [pendingProjectPull, setPendingProjectPull] = useState<PendingSharedPullState | null>(null);
  const [projectSyncing, setProjectSyncing] = useState(false);
  const projectSyncingRef = useRef(false);
  const projectSyncHandlerRef = useRef<() => Promise<void>>(async () => {});
  const [projectSyncSummary, setProjectSyncSummary] = useState<SharedSyncQueueSummary>({
    pendingCount: 0,
    conflictCount: 0,
    lastConflictError: null,
  });
  const [showRecoverLocks, setShowRecoverLocks] = useState(false);
  const [recoverClaims, setRecoverClaims] = useState<CollaborationAreaClaimSummary[]>([]);
  const [recoverAreaNames, setRecoverAreaNames] = useState<Map<string, string>>(new Map());
  const [recoverLoading, setRecoverLoading] = useState(false);
  const [recoverError, setRecoverError] = useState('');
  const [recoverConfirm, setRecoverConfirm] = useState<CollaborationAreaClaimSummary | null>(null);
  const [recoverBusy, setRecoverBusy] = useState(false);
  const [sharedProjectAccessSnapshot, setSharedProjectAccessSnapshot] = useState<{
    projectId: string;
    userId: string;
    isActiveMember: boolean;
    isOwner: boolean;
    hasError: boolean;
  } | null>(null);
  const [homeMenuState, setHomeMenuState] = useState<HomeMenuState>({
    context: 'home',
    sortOption: 'alphabetical',
    areaViewMode: 'grouped',
    showTrash: false,
    canAddArea: false,
    hasProjects: false,
    isSingleProject: false,
    singleProjectName: '',
    selectionMode: false,
  });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const sharedProjectAccess = useMemo(() => {
    const sharedProjectId = homeMenuState.sharedProjectId;
    const userId = collaborationAuth.user?.id;
    if (!collaborationAuth.isSignedIn || !sharedProjectId || !userId) {
      return { isReady: false, isActiveMember: false, isOwner: false, hasError: false };
    }
    if (sharedProjectAccessSnapshot?.projectId === sharedProjectId && sharedProjectAccessSnapshot.userId === userId) {
      return {
        isReady: true,
        isActiveMember: sharedProjectAccessSnapshot.isActiveMember,
        isOwner: sharedProjectAccessSnapshot.isOwner,
        hasError: sharedProjectAccessSnapshot.hasError,
      };
    }
    const cached = sharedProjectAccessCache.get(`${userId}:${sharedProjectId}`);
    if (cached) {
      return { isReady: true, ...cached };
    }
    return { isReady: false, isActiveMember: false, isOwner: false, hasError: false };
  }, [
    collaborationAuth.isSignedIn,
    collaborationAuth.user?.id,
    homeMenuState.sharedProjectId,
    sharedProjectAccessSnapshot,
  ]);
  const projectId = useMemo(() => {
    if (!pathname.startsWith('/project/')) {
      return '';
    }
    const segments = pathname.split('/').filter(Boolean);
    return segments[1] ?? '';
  }, [pathname]);
  const syncProjectId = projectId || (
    showAuth && homeMenuState.isSingleProject && !homeMenuState.showTrash
      ? homeMenuState.singleProjectId ?? ''
      : ''
  );
  const isAreaRoute = useMemo(() => {
    const segments = pathname.split('/').filter(Boolean);
    return segments[0] === 'project' && segments[2] === 'area';
  }, [pathname]);
  const showAppMenuControl = showAuth || Boolean(projectId) || showHomeMenu;
  const cachedProjectTitle = projectId
    ? getCachedProjectName(projectId) ?? projectTitleCache.get(projectId)
    : undefined;
  const resolvedProjectTitle = cachedProjectTitle
    ?? (loadedProjectTitle.projectId === projectId ? loadedProjectTitle.title : '');
  const currentProjectTitle =
    homeMenuState.context === 'project' && homeMenuState.singleProjectName
      ? homeMenuState.singleProjectName
      : resolvedProjectTitle;

  useEffect(() => {
    if (collaborationAuth.isSignedIn) {
      resumePendingSharedAreaSyncs();
      resumePendingSharedProjectMetadataSyncs();
    }
  }, [collaborationAuth.isSignedIn]);

  useEffect(() => {
    if (!syncProjectId) return;
    let active = true;
    setProjectSyncSummary({ pendingCount: 0, conflictCount: 0, lastConflictError: null });

    async function refreshProjectSyncSummary() {
      try {
        const [areas, metadata] = await Promise.all([
          getPendingSharedAreaSyncsForProject(syncProjectId),
          getPendingSharedProjectMetadataSyncForProject(syncProjectId),
        ]);
        if (active) setProjectSyncSummary(summarizePendingSharedSyncs([...areas, ...(metadata ? [metadata] : [])]));
      } catch (error) {
        console.info('Project sync status is temporarily unavailable:', error);
      }
    }

    void refreshProjectSyncSummary();
    window.addEventListener(SHARED_SYNC_QUEUE_CHANGED_EVENT, refreshProjectSyncSummary);
    return () => {
      active = false;
      window.removeEventListener(SHARED_SYNC_QUEUE_CHANGED_EVENT, refreshProjectSyncSummary);
    };
  }, [syncProjectId]);

  async function handleProjectSync() {
    if (!syncProjectId || projectSyncingRef.current) return;
    projectSyncingRef.current = true;
    setProjectSyncing(true);
    setHomeMenuOpen(false);
    setInfoDialog(null);
    setSyncStatus('syncing');
    try {
      const project = await getProject(syncProjectId);
      if (!project || project.deletedAt) throw new Error('This project is no longer available on this device.');

      if (project.sharedProjectId) {
        if (!collaborationAuth.isSignedIn || !collaborationAuth.user) {
          throw new Error('Enable Team Projects before syncing this shared project.');
        }
        const result = await syncSharedProject(syncProjectId, collaborationAuth.user.id);
        if (result.status === 'review') {
          setPendingProjectPull(result.pull);
          setSyncStatus('error');
          return;
        }
        if (result.status === 'pending') {
          setSyncStatus('pending');
          window.dispatchEvent(new CustomEvent('punchlist-project-synced', { detail: { projectId: syncProjectId } }));
          setInfoDialog({ title: 'Sync This Project', message: `${project.projectName}: ${result.message}` });
          return;
        }
        clearSharedUpdateAvailable(syncProjectId);
        setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
        window.dispatchEvent(new CustomEvent('punchlist-project-synced', { detail: { projectId: syncProjectId } }));
        setInfoDialog({
          title: 'Sync This Project',
          message: `${project.projectName}: team changes synced${result.releasedAreaCount ? `; ${result.releasedAreaCount} area${result.releasedAreaCount === 1 ? '' : 's'} released` : ''}.`,
        });
        return;
      }

      const token = await ensureAccessToken({ interactive: true });
      if (!token) {
        setSyncStatus('needs-auth');
        setInfoDialog({ title: 'Sync This Project', message: 'Sign in to Microsoft to sync this personal project.' });
        return;
      }
      const merged = await mergePersonalProjectsFromOneDrive(token, [syncProjectId]);
      const result = await runManualOneDriveSync({
        ensureAccessToken: async () => token,
        projectIds: [syncProjectId],
        forceProjectIds: merged.forceBackupProjectIds,
        scope: 'selected',
      });
      window.dispatchEvent(new CustomEvent('punchlist-project-synced', { detail: { projectId: syncProjectId } }));
      if (result.status === 'success') {
        setSyncConflicts([]);
        setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
        setInfoDialog({
          title: 'Sync This Project',
          message: merged.archivedLocalProjectIds.includes(syncProjectId)
            ? `${project.projectName}: the newer OneDrive copy shows this project was archived. This device moved it to Trash.`
            : `${project.projectName}: personal backup saved${merged.updatedLocalProjectIds.includes(syncProjectId) ? '; newer changes from OneDrive added' : ''}.`,
        });
      } else {
        if (result.status === 'conflict') setSyncConflicts(result.conflicts);
        setSyncStatus(result.status === 'needs-auth' ? 'needs-auth' : result.status === 'error' || result.status === 'conflict' ? 'error' : 'pending');
        setInfoDialog({
          title: 'Sync This Project',
          message: 'message' in result ? result.message : 'Sign in to Microsoft to sync this personal project.',
        });
      }
    } catch (error) {
      setSyncStatus('error');
      setInfoDialog({
        title: 'Sync This Project',
        message: error instanceof Error ? error.message : 'Could not sync this project. Please try again.',
      });
    } finally {
      projectSyncingRef.current = false;
      setProjectSyncing(false);
    }
  }

  projectSyncHandlerRef.current = handleProjectSync;
  useEffect(() => {
    if (!syncProjectId) return;
    function handleProjectSyncRequest(event: Event) {
      const requestedProjectId = (event as CustomEvent<{ projectId?: string }>).detail?.projectId;
      if (requestedProjectId === syncProjectId) void projectSyncHandlerRef.current();
    }
    window.addEventListener('punchlist-sync-current-project', handleProjectSyncRequest);
    return () => window.removeEventListener('punchlist-sync-current-project', handleProjectSyncRequest);
  }, [syncProjectId]);

  async function confirmProjectPull() {
    if (!pendingProjectPull || projectSyncingRef.current) return;
    const pull = pendingProjectPull;
    setPendingProjectPull(null);
    projectSyncingRef.current = true;
    setProjectSyncing(true);
    setSyncStatus('syncing');
    try {
      await captureSharedProjectBackup(pull.localProject, 'before_pull', 'Local data before pulling shared data.');
      await saveProjectPreserveTimestamps(pull.resolutionProject);
      await rebaseSharedProjectAreaSyncsAfterPull(pull.resolutionProject, pull.preservedLocalAreaIds);
      if (pull.preservedLocalProjectMetadata) {
        await saveAndQueueSharedProjectMetadataSync(pull.resolutionProject);
      }
      clearSharedUpdateAvailable(pull.localProject.id);
      window.dispatchEvent(new CustomEvent('punchlist-project-synced', { detail: { projectId: pull.localProject.id } }));
      setSyncStatus('pending');
      setInfoDialog({ title: 'Sync This Project', message: formatPendingSharedPullSuccessMessage(pull) });
    } catch (error) {
      setSyncStatus('error');
      setInfoDialog({
        title: 'Sync This Project',
        message: error instanceof Error ? error.message : 'Could not merge team data. Your project remains on this device.',
      });
    } finally {
      projectSyncingRef.current = false;
      setProjectSyncing(false);
    }
  }

  const syncButtonClasses = {
    idle: 'text-gray-700 hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]',
    syncing: 'animate-pulse bg-sky-100 text-sky-700 hover:bg-sky-100 dark:bg-sky-400/15 dark:text-sky-200',
    pending: 'text-gray-700 hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]',
    'needs-auth': 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
    error: 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
  } as const;

  const syncButtonLabel = {
    idle: 'Sync personal and team projects, then release your team areas',
    syncing: 'Syncing projects now',
    pending: 'Sync personal and team projects, then release your team areas',
    'needs-auth': 'Sign in to sync projects',
    error: 'Project sync needs attention',
  } as const;
  const syncButtonIcons = {
    idle: RefreshCw,
    syncing: RefreshCw,
    pending: RefreshCw,
    'needs-auth': KeyRound,
    error: Activity,
  } as const;

  useEffect(() => {
    let cancelled = false;

    async function loadProjectTitle() {
      if (!projectId) {
        if (!cancelled) setLoadedProjectTitle({ projectId: '', title: '' });
        return;
      }

      const cachedTitle = getCachedProjectName(projectId) ?? projectTitleCache.get(projectId);
      if (cachedTitle !== undefined) {
        if (!cancelled) {
          setLoadedProjectTitle({ projectId, title: cachedTitle });
        }
      }

      try {
        const project = await getProjectMetadata(projectId);
        if (!cancelled) {
          const nextTitle = project?.projectName ?? '';
          projectTitleCache.set(projectId, nextTitle);
          setLoadedProjectTitle({ projectId, title: nextTitle });
        }
      } catch {
        if (!cancelled) {
          setLoadedProjectTitle({ projectId, title: '' });
        }
      }
    }

    void loadProjectTitle();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (projectId && homeMenuState.context === 'project' && homeMenuState.singleProjectName) {
      projectTitleCache.set(projectId, homeMenuState.singleProjectName);
    }
  }, [homeMenuState.context, homeMenuState.singleProjectName, projectId]);

  function setHomeMenuOpen(open: boolean) {
    // Apply the open attribute in the same turn as the click so mobile CSS
    // (top bar / drawer chrome) does not paint one frame without it.
    setAppMenuOpenAttribute(open);
    setShowHomeMenu(open);
  }

  useEffect(() => {
    let cancelled = false;
    const sharedProjectId = homeMenuState.sharedProjectId;
    const userId = collaborationAuth.user?.id;

    if (!showHomeMenu || !collaborationAuth.isSignedIn || !sharedProjectId || !userId) {
      return () => {
        cancelled = true;
      };
    }

    void getSharedProjectAccess(sharedProjectId, userId)
      .then((access) => {
        if (cancelled) return;
        const next = {
          projectId: sharedProjectId,
          userId,
          isActiveMember: access.isActiveMember,
          isOwner: access.isOwner,
          hasError: false,
        };
        sharedProjectAccessCache.set(`${userId}:${sharedProjectId}`, {
          isActiveMember: next.isActiveMember,
          isOwner: next.isOwner,
          hasError: next.hasError,
        });
        setSharedProjectAccessSnapshot(next);
      })
      .catch((error) => {
        console.error('Failed to verify shared project access:', error);
        if (cancelled) return;
        const next = {
          projectId: sharedProjectId,
          userId,
          isActiveMember: false,
          isOwner: false,
          hasError: true,
        };
        sharedProjectAccessCache.set(`${userId}:${sharedProjectId}`, {
          isActiveMember: next.isActiveMember,
          isOwner: next.isOwner,
          hasError: next.hasError,
        });
        setSharedProjectAccessSnapshot(next);
      });

    return () => {
      cancelled = true;
    };
  }, [
    collaborationAuth.isSignedIn,
    collaborationAuth.user?.id,
    homeMenuState.sharedProjectId,
    showHomeMenu,
  ]);

  async function handleMicrosoftAuthAction() {
    if (!isSignedIn) {
      await signInToMicrosoft();
      return;
    }

    await collaborationAuth.signOut();
    await signOutOfMicrosoft();
  }

  useEffect(() => {
    setAppMenuOpenAttribute(showHomeMenu);
    return () => {
      setAppMenuOpenAttribute(false);
    };
  }, [showHomeMenu]);

  useEffect(() => {
    function handleHomeMenuState(event: Event) {
      const customEvent = event as CustomEvent<HomeMenuState>;
      if (customEvent.detail) {
        setHomeMenuState(customEvent.detail);
      }
    }

    window.addEventListener('punchlist-home-menu-state', handleHomeMenuState as EventListener);
    return () => {
      window.removeEventListener('punchlist-home-menu-state', handleHomeMenuState as EventListener);
    };
  }, []);

  useEffect(() => {
    function handleAreaGroupsState(event: Event) {
      const customEvent = event as CustomEvent<{ allCollapsed?: boolean }>;
      setAreAreaGroupsCollapsed(customEvent.detail?.allCollapsed === true);
    }

    window.addEventListener('punchlist-area-groups-state', handleAreaGroupsState as EventListener);
    return () => {
      window.removeEventListener('punchlist-area-groups-state', handleAreaGroupsState as EventListener);
    };
  }, []);

  useEffect(() => {
    function handleCloseHomeMenuOnMobile() {
      if (window.matchMedia('(max-width: 767px)').matches) {
        setHomeMenuOpen(false);
      }
    }

    window.addEventListener('punchlist-close-home-menu-on-mobile', handleCloseHomeMenuOnMobile);
    return () => {
      window.removeEventListener('punchlist-close-home-menu-on-mobile', handleCloseHomeMenuOnMobile);
    };
  }, []);

  function dispatchHomeAction(action: string, sort?: SortOption, areaViewMode?: AreaListViewMode) {
    window.dispatchEvent(new CustomEvent('punchlist-home-menu-action', {
      detail: {
        action,
        sort,
        areaViewMode,
        isSharedProjectOwner: action === 'disconnect-shared-project'
          ? sharedProjectAccess.isOwner
          : undefined,
      },
    }));
  }

  async function openRecoverLocks() {
    const sharedProjectId = homeMenuState.sharedProjectId;
    if (!sharedProjectId || !sharedProjectAccess.isOwner) return;
    setShowHomeMenu(false);
    setShowRecoverLocks(true);
    setRecoverLoading(true);
    setRecoverError('');
    try {
      const [claims, projects] = await Promise.all([
        getActiveSharedProjectAreaClaimSummaries(sharedProjectId), getAllProjects(),
      ]);
      const local = projects.find((entry) => !entry.deletedAt && entry.sharedProjectId === sharedProjectId);
      setRecoverAreaNames(new Map(local?.areas.map((area) => [area.id, area.name]) ?? []));
      setRecoverClaims(claims.filter((claim) => claim.claimedByUserId !== collaborationAuth.user?.id));
    } catch (error) {
      setRecoverError(error instanceof Error ? error.message : 'Could not load area locks.');
    } finally {
      setRecoverLoading(false);
    }
  }

  async function confirmRecoverLock() {
    const claim = recoverConfirm;
    const sharedProjectId = homeMenuState.sharedProjectId;
    if (!claim || !sharedProjectId || recoverBusy) return;
    setRecoverBusy(true);
    setRecoverError('');
    try {
      const released = await releaseAbandonedSharedProjectArea(sharedProjectId, claim.areaId, claim.id);
      setRecoverConfirm(null);
      setRecoverClaims((current) => current.filter((entry) => entry.id !== claim.id));
      if (!released) setRecoverError('That lock changed before it could be released. Reopen recovery to see the current holder.');
    } catch (error) {
      setRecoverConfirm(null);
      setRecoverError(error instanceof Error ? error.message : 'Could not release this area lock.');
    } finally {
      setRecoverBusy(false);
    }
  }

  function renderSyncButton() {
    const label = localSaveStatus === 'error'
      ? 'Local save needs attention'
      : displayRetryInSeconds > 0 && !syncProjectId
      ? `Sync team projects now. OneDrive available in ${displayRetryInSeconds} seconds`
      : syncProjectId && displayStatus !== 'syncing'
        ? 'Sync only this project and release its team areas when sent'
        : syncButtonLabel[displayStatus];
    const shortLabel = localSaveStatus === 'error'
      ? 'Save error'
      : projectSyncing || displayStatus === 'syncing'
        ? 'Syncing…'
        : syncProjectId
          ? 'Sync This Project'
          : 'Sync All Projects';
    const SyncIcon = localSaveStatus === 'error'
      ? Activity
      : displayRetryInSeconds > 0 && !syncProjectId
        ? CloudUpload
        : syncButtonIcons[displayStatus];
    const buttonClasses = homeMenuState.hasTeamUpdates && displayStatus !== 'syncing'
      ? 'bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-400/20 dark:text-sky-100 dark:hover:bg-sky-400/30'
      : localSaveStatus === 'error'
      ? syncButtonClasses.error
      : syncButtonClasses[displayStatus];

    return (
      <button
        type="button"
        onClick={() => {
          if (localSaveStatus === 'error') {
            setInfoDialog({
              title: 'Local save needs attention',
              message: `This device could not save the latest change. Keep the app open and try the action again.${localSaveError ? `\n\n${localSaveError}` : ''}`,
            });
            return;
          }
          if (syncProjectId && !isAreaRoute) void handleProjectSync();
          else dispatchHomeAction('sync-now');
        }}
        disabled={projectSyncing || displayStatus === 'syncing' || sharedTransferStatus !== null}
        className={`${syncMenuRowBaseClass} ${buttonClasses}`}
        aria-label={label}
        title={label}
      >
        <SyncIcon className={`h-4 w-4 shrink-0 ${displayStatus === 'syncing' && displayRetryInSeconds === 0 ? 'animate-spin' : ''}`} />
        <span>{shortLabel}</span>
      </button>
    );
  }

  function renderSharedSyncIndicator() {
    const summary = syncProjectId ? projectSyncSummary : sharedSyncSummary;
    if (summary.pendingCount === 0) return null;

    const needsReview = summary.conflictCount > 0;
    const count = needsReview
      ? summary.conflictCount
      : summary.pendingCount;
    const label = needsReview
      ? `${count} team update${count === 1 ? '' : 's'} need review.${summary.lastConflictError ? ` ${summary.lastConflictError}` : ''}`
      : `${count} team change${count === 1 ? '' : 's'} waiting to send`;
    const shortLabel = needsReview ? 'Review changes' : `${count} waiting`;
    const SharedSyncIcon = needsReview ? Activity : CloudUpload;
    const classes = needsReview
      ? 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15'
      : 'bg-violet-50 text-violet-700 hover:bg-violet-100 dark:bg-violet-400/10 dark:text-violet-200 dark:hover:bg-violet-400/15';

    return (
      <button
        type="button"
        onClick={() => {
          setHomeMenuOpen(false);
          if (syncProjectId && !isAreaRoute) void handleProjectSync();
          else dispatchHomeAction('sync-now');
        }}
        className={`flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 rounded-[1rem] px-2.5 transition ${classes}`}
        aria-live="polite"
        aria-label={label}
        title={label}
      >
        <SharedSyncIcon className={`h-4 w-4 ${needsReview ? '' : 'animate-pulse'}`} />
        <span className="text-xs font-bold leading-none sm:hidden">{needsReview ? '!' : count}</span>
        <span className="hidden text-xs font-bold leading-none tracking-normal sm:inline">{shortLabel}</span>
      </button>
    );
  }

  const menuCardClass = 'app-menu-card overflow-hidden rounded-[1.1rem] px-2 py-1 md:px-2.5 md:py-1.5';
  const menuGroupShellClass = 'app-menu-group px-1 py-0.5 md:py-1';
  const menuGroupLabelClass = 'px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400';
  const menuListGridClass = 'app-menu-list grid grid-cols-2 gap-2 px-1 pb-1';
  const menuRowClass = 'flex min-h-10 min-w-0 items-center gap-2 rounded-full bg-black/[0.08] px-3 py-2 text-left text-[13px] font-medium leading-tight text-gray-800 transition-colors hover:bg-black/[0.12] dark:bg-white/[0.08] dark:text-gray-200 dark:hover:bg-white/[0.12]';
  const menuRowSecondaryClass = 'flex min-h-10 min-w-0 items-center gap-2 rounded-full bg-black/[0.04] px-3 py-2 text-left text-[13px] font-medium leading-tight text-gray-600 transition-colors hover:bg-black/[0.08] dark:bg-white/[0.04] dark:text-gray-400 dark:hover:bg-white/[0.08]';
  const syncMenuRowBaseClass = `${menuRowClass} disabled:cursor-default`;
  const disabledMenuRowClass = `${menuRowClass} disabled:cursor-default disabled:opacity-60`;
  const disabledMenuRowSecondaryClass = `${menuRowSecondaryClass} disabled:cursor-default disabled:opacity-60`;
  return (
    <div className="persistent-top-bar relative z-30 md:border-b">
      <div className="top-bar-surface mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            aria-label="Go to projects"
            className="flex shrink-0 items-center transition"
            onClick={() => {
              if (showAuth || homeMenuState.context === 'project') {
                window.dispatchEvent(new CustomEvent('punchlist-home-menu-action', { detail: { action: 'clear-trash' } }));
              }
            }}
          >
            <Image
              src="/uai-logo.png"
              unoptimized
              alt="UAI Logo"
              width={337}
              height={184}
              className="h-8 w-auto object-contain"
              priority
            />
          </Link>
          {!showAuth && currentProjectTitle && (
            <div className="min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-white">
              {currentProjectTitle}
            </div>
          )}
        </div>
        {showAppMenuControl && isReady && (!homeMenuState.showTrash || isAreaRoute) && (
          <div ref={menuRef} className="app-menu-top-actions relative flex items-center gap-2">
            {renderSharedSyncIndicator()}
            {!isAreaRoute && (
              <div className="relative h-10 w-10">
                <button
                  type="button"
                  onClick={() => setHomeMenuOpen(!showHomeMenu)}
                  className="flex h-10 w-10 items-center justify-center rounded-[1rem] bg-transparent text-gray-500 transition hover:bg-black/[0.04] hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                  aria-label={showHomeMenu ? 'Close app menu' : 'Open app menu'}
                  aria-pressed={showHomeMenu}
                  title={showHomeMenu ? 'Close app menu' : 'Open app menu'}
                >
                  {showHomeMenu ? <PanelRightClose className="h-5 w-5" /> : <PanelRightOpen className="h-5 w-5" />}
                </button>
                {homeMenuState.isSingleProject &&
                  !homeMenuState.showTrash &&
                  !homeMenuState.selectionMode && (
                  <button
                    type="button"
                    onClick={() => dispatchHomeAction('toggle-area-issues')}
                    className={`absolute top-[4.5rem] flex h-10 items-center rounded-full px-3 text-sm font-medium transition ${
                      homeMenuState.areaViewMode === 'grouped' && homeMenuState.hasAreaGroups
                        ? 'right-12'
                        : 'right-0'
                    } ${
                      homeMenuState.showOnlyAreaIssues
                        ? 'accent-tint accent-text'
                        : 'soft-control text-gray-500 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
                    }`}
                    aria-label={homeMenuState.showOnlyAreaIssues ? 'Show all areas' : 'Show only areas with issues'}
                    aria-pressed={homeMenuState.showOnlyAreaIssues === true}
                  >
                    <span className="text-[0.92rem] font-medium">Issues</span>
                  </button>
                )}
                {homeMenuState.areaViewMode === 'grouped' &&
                  homeMenuState.hasAreaGroups &&
                  !homeMenuState.showTrash &&
                  !homeMenuState.selectionMode && (
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event('punchlist-toggle-area-groups'))}
                    className="soft-control absolute right-0 top-[4.5rem] flex h-10 w-10 items-center justify-center rounded-[1rem] text-gray-500 transition hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
                    aria-label={areAreaGroupsCollapsed ? 'Expand all area groups' : 'Collapse all area groups'}
                    title={areAreaGroupsCollapsed ? 'Expand all area groups' : 'Collapse all area groups'}
                  >
                    {areAreaGroupsCollapsed
                      ? <ChevronDown className="h-5 w-5" />
                      : <ChevronUp className="h-5 w-5" />}
                  </button>
                )}
              </div>
            )}
            {!isAreaRoute && showHomeMenu && createPortal((
              <div
                className="app-menu-drawer menu-surface fixed right-0 z-[120] flex flex-col overflow-hidden border-y-0 border-r-0 p-0 md:top-0 md:h-[100dvh]"
                role="dialog"
                aria-modal="false"
                aria-label="App menu"
              >
                <div className="app-menu-scroll min-h-0 flex-1 overflow-y-auto overscroll-y-contain touch-pan-y px-3 pt-1 md:pb-[calc(env(safe-area-inset-bottom)+1rem)] md:pt-[calc(env(safe-area-inset-top)+0.5rem)]">
                  {homeMenuState.hasProjects && (
                    <div className={menuGroupShellClass}>
                      <div className={menuCardClass}>
                        <div className="app-menu-sort-content px-1 pb-1">
                          <div className="grid grid-cols-4 gap-2">
                            {homeMenuState.isSingleProject && (
                              <AreaListViewToggle
                                value={homeMenuState.areaViewMode}
                                onChange={(mode) => dispatchHomeAction('area-view', undefined, mode)}
                              />
                            )}
                            <div className={homeMenuState.isSingleProject ? 'col-span-3' : 'col-span-4'}>
                              <ListSortMenu
                                value={homeMenuState.sortOption}
                                onChange={(option) => {
                                  if (showAuth) {
                                    dispatchHomeAction(`quick-sort:${option}`);
                                  } else {
                                    dispatchHomeAction('sort', option);
                                  }
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                {homeMenuState.isSingleProject && (
                  <div className={menuGroupShellClass}>
                    <div className={menuCardClass}>
                      <div className={menuGroupLabelClass}>Current Project</div>
                      <div className={menuListGridClass}>
                        <button onClick={() => dispatchHomeAction('edit-project')} className={menuRowClass}>
                          <Pencil className="h-4 w-4 shrink-0" />
                          Edit
                        </button>
                        {!showAuth && isSignedIn && renderSyncButton()}
                        {homeMenuState.canAddArea && (
                          <button
                            onClick={() => {
                              const enteringSelectionMode = !homeMenuState.selectionMode;
                              dispatchHomeAction('toggle-selection');
                              if (enteringSelectionMode && window.matchMedia('(max-width: 767px)').matches) {
                                setHomeMenuOpen(false);
                              }
                            }}
                            className={menuRowClass}
                          >
                            <CheckCircle2 className="h-4 w-4 shrink-0" />
                            {homeMenuState.selectionMode ? 'Cancel Selection' : 'Manage Areas'}
                          </button>
                        )}
                        <button onClick={() => dispatchHomeAction('export-project')} className={menuRowClass}>
                          <FileDown className="h-4 w-4 shrink-0" />
                          Export
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {homeMenuState.isSingleProject && collaborationAuth.isSignedIn && (
                  <div className={menuGroupShellClass}>
                    <div className={menuCardClass}>
                      <div className={menuGroupLabelClass}>Team</div>
                      <div className={menuListGridClass}>
                        {!homeMenuState.isSharedProject && (
                          <button
                            onClick={() => dispatchHomeAction('share-project')}
                            className={menuRowClass}
                          >
                            <Share2 className="h-4 w-4 shrink-0" />
                            Share with Team
                          </button>
                        )}
                        {homeMenuState.isSingleProject && homeMenuState.isSharedProject && (!sharedProjectAccess.isReady || sharedProjectAccess.isActiveMember || sharedProjectAccess.hasError) && (
                          <details className="group/team col-span-2">
                            <summary className={`${menuRowClass} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
                              <Users className="h-4 w-4 shrink-0" />
                              Team settings
                              <ChevronDown className="ml-auto h-4 w-4 group-open/team:rotate-180" />
                            </summary>
                            <div className={`${menuListGridClass} mt-2`}>
                          <button
                            onClick={() => dispatchHomeAction('invite-people')}
                            disabled={!!homeMenuState.isCreatingJoinCode}
                            className={disabledMenuRowClass}
                          >
                            <UserPlus className="h-4 w-4 shrink-0" />
                            {homeMenuState.isCreatingJoinCode ? 'Preparing…' : 'Invite'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('shared-members')}
                            disabled={!!homeMenuState.isLoadingSharedMembers}
                            className={disabledMenuRowSecondaryClass}
                          >
                            <Users className="h-4 w-4 shrink-0" />
                            {homeMenuState.isLoadingSharedMembers ? 'Loading…' : 'Members'}
                          </button>
                          <button onClick={() => dispatchHomeAction('shared-backups')} className={menuRowSecondaryClass}>
                            <ArchiveRestore className="h-4 w-4 shrink-0" />
                            Team Backups
                          </button>
                          {sharedProjectAccess.isOwner && (
                            <button onClick={() => void openRecoverLocks()} className={menuRowSecondaryClass}>
                              <KeyRound className="h-4 w-4 shrink-0" />
                              Recover area locks
                            </button>
                          )}
                          {sharedProjectAccess.isReady && sharedProjectAccess.isActiveMember && (
                            <button
                              onClick={() => dispatchHomeAction('disconnect-shared-project')}
                              disabled={!!homeMenuState.isDisconnectingSharedProject}
                              className={disabledMenuRowSecondaryClass}
                            >
                              <LogOut className="h-4 w-4 shrink-0" />
                              {homeMenuState.isDisconnectingSharedProject
                                ? sharedProjectAccess.isOwner ? 'Stopping…' : 'Leaving…'
                                : sharedProjectAccess.isOwner ? 'Stop sharing for everyone' : 'Leave Team Project'}
                            </button>
                          )}
                            </div>
                          </details>
                        )}
                        {homeMenuState.isSingleProject &&
                          homeMenuState.isSharedProject &&
                          sharedProjectAccess.isReady &&
                          !sharedProjectAccess.isActiveMember && (
                          <>
                            <div className="col-span-2 px-2 py-2 text-xs text-amber-700 dark:text-amber-300">
                              {sharedProjectAccess.hasError
                                ? 'Could not verify team access. Retry an action, or keep working from this device only.'
                                : 'This device has a team copy that is not active for your account. Reconnect the team project or keep it as a local-only copy.'}
                            </div>
                            <button
                              onClick={() => dispatchHomeAction('my-shared-projects')}
                              className={menuRowClass}
                            >
                              <Users className="h-4 w-4 shrink-0" />
                              Reconnect Team Project
                            </button>
                            <button
                              onClick={() => dispatchHomeAction('unlink-inactive-shared-project')}
                              className={menuRowClass}
                            >
                              <LogOut className="h-4 w-4 shrink-0" />
                              Keep Local Only
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {showAuth && (
                  <div className={menuGroupShellClass}>
                    <div className={menuCardClass}>
                      <div className={menuGroupLabelClass}>Projects</div>
                      <div className={menuListGridClass}>
                        {showAuth && (
                          <button onClick={() => dispatchHomeAction('new-project')} className={menuRowClass}>
                            <PlusSquare className="h-4 w-4 shrink-0" />
                            New Project
                          </button>
                        )}
                        {showAuth && isSignedIn && renderSyncButton()}
                        {showAuth &&
                          isSignedIn &&
                          collaborationAuth.canUseCollaboration &&
                          !collaborationAuth.isSignedIn && (
                            <button
                              type="button"
                              onClick={() => void collaborationAuth.signIn()}
                              disabled={!collaborationAuth.isReady || collaborationAuth.isSigningIn}
                              className={disabledMenuRowClass}
                            >
                              <Users className="h-4 w-4 shrink-0" />
                              {collaborationAuth.isSigningIn ? 'Enabling…' : 'Enable Team Projects'}
                            </button>
                          )}
                        {collaborationAuth.isSignedIn && (
                          <button onClick={() => dispatchHomeAction('my-shared-projects')} className={menuRowClass}>
                            <Users className="h-4 w-4 shrink-0" />
                            Team Projects
                          </button>
                        )}
                        {showAuth && (
                          <button onClick={() => dispatchHomeAction('toggle-trash')} className={menuRowClass}>
                            <Trash2 className="h-4 w-4 shrink-0" />
                            Trash
                          </button>
                        )}
                        {showAuth &&
                          isSignedIn &&
                          !collaborationAuth.isSignedIn &&
                          collaborationAuth.errorMessage && (
                            <div className="col-span-2 px-2 py-1 text-xs text-red-600 dark:text-red-300">
                              {collaborationAuth.errorMessage}
                            </div>
                          )}
                      </div>
                    </div>
                  </div>
                )}
                <div className={menuGroupShellClass}>
                  <div className={menuCardClass}>
                    <div className={menuGroupLabelClass}>Account</div>
                    <div className={menuListGridClass}>
                      {collaborationAuth.isSignedIn && (
                        <button
                          onClick={() => {
                            setShowProfile(true);
                          }}
                          className={menuRowClass}
                        >
                          {collaborationAuth.profile ? (
                            <CollaborationAvatar
                              name={getCollaborationProfileDisplayName(collaborationAuth.profile) || 'Your account'}
                              src={collaborationAuth.profile.avatarUrl}
                              initials={getCollaborationProfileInitials(collaborationAuth.profile)}
                              size="xs"
                            />
                          ) : (
                            <UserRound className="h-4 w-4 shrink-0" />
                          )}
                          Profile
                        </button>
                      )}
                      {!isSignedIn ? (
                        <button onClick={() => void handleMicrosoftAuthAction()} className={menuRowClass}>
                          <LogIn className="h-4 w-4 shrink-0" />
                          Sign In
                        </button>
                      ) : !collaborationAuth.isSignedIn ? (
                        <button onClick={() => void handleMicrosoftAuthAction()} className={menuRowClass}>
                          <LogOut className="h-4 w-4 shrink-0" />
                          Sign Out
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                </div>
              </div>
            ), document.body)}
          </div>
        )}
      </div>
      {showRecoverLocks && typeof document !== 'undefined' && createPortal(
        <div className="modal-overlay fixed inset-0 z-[150] flex items-center justify-center p-4">
          <div className="modal-panel max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6" role="dialog" aria-modal="true" aria-labelledby="recover-locks-title">
            <h2 id="recover-locks-title" className="text-xl font-semibold">Recover area locks</h2>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">For a teammate who has left an area locked. Ask them to sync and release it first when possible.</p>
            {recoverLoading ? <p className="mt-5 text-sm">Loading locks…</p> : recoverClaims.length === 0 ? (
              <p className="mt-5 text-sm">No areas are locked by other teammates.</p>
            ) : (
              <div className="mt-5 space-y-2">
                {recoverClaims.map((claim) => (
                  <div key={claim.id} className="soft-control flex items-center justify-between gap-3 rounded-xl p-3">
                    <div className="min-w-0 text-sm">
                      <p className="truncate font-semibold">{recoverAreaNames.get(claim.areaId) ?? `Area ${claim.areaId.slice(0, 8)}`}</p>
                      <p className="truncate text-gray-500 dark:text-gray-400">{claim.claimedByDisplayName || claim.claimedByEmail || 'Team member'}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Claimed {claim.claimedAt.toLocaleString()}</p>
                    </div>
                    <button type="button" onClick={() => setRecoverConfirm(claim)} className="shrink-0 rounded-xl bg-amber-500/15 px-3 py-2 text-xs font-semibold text-amber-800 dark:text-amber-200">Release</button>
                  </div>
                ))}
              </div>
            )}
            {recoverError && <p className="mt-4 text-sm text-red-600 dark:text-red-300" role="alert">{recoverError}</p>}
            <button type="button" onClick={() => setShowRecoverLocks(false)} className="soft-control mt-5 w-full rounded-xl px-4 py-3 text-sm font-semibold">Done</button>
          </div>
        </div>, document.body
      )}
      {recoverConfirm && (
        <AppConfirmDialog
          title="Release teammate's lock?"
          message={`Release the lock on ${recoverAreaNames.get(recoverConfirm.areaId) ?? 'this area'} held by ${recoverConfirm.claimedByDisplayName || recoverConfirm.claimedByEmail || 'a teammate'}?\n\nTheir unsent changes stay on their device and may need review when they sync. Confirm with them first if possible.`}
          confirmLabel={recoverBusy ? 'Releasing…' : 'Release lock'}
          danger
          onCancel={() => { if (!recoverBusy) setRecoverConfirm(null); }}
          onConfirm={() => void confirmRecoverLock()}
        />
      )}
      {pendingProjectPull && (
        <AppConfirmDialog
          title={pendingProjectPull.reason === 'manual-pull' ? 'Pull Shared Data' : 'Review Shared Changes'}
          message={formatPendingSharedPullMessage(pendingProjectPull)}
          confirmLabel="Back Up + Merge"
          danger={pendingProjectPull.hasNewerLocalChanges || pendingProjectPull.reason !== 'manual-pull'}
          onCancel={() => setPendingProjectPull(null)}
          onConfirm={() => void confirmProjectPull()}
        />
      )}
      <UserProfileModal open={showProfile} onClose={() => setShowProfile(false)} onSignOut={() => {
        setShowProfile(false);
        void handleMicrosoftAuthAction();
      }} />
      {infoDialog && (
        <AppMessageDialog
          title={infoDialog.title}
          message={infoDialog.message}
          onClose={() => setInfoDialog(null)}
        />
      )}
    </div>
  );
}
