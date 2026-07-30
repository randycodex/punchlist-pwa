'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { getProjectMetadata } from '@/lib/db';
import { hasPendingSyncState } from '@/lib/pendingSync';
import { getCachedProjectName } from '@/lib/projectNavigationCache';
import {
  getCollaborationProfileDisplayName,
  getCollaborationProfileInitials,
  getSharedProjectAccess,
  resumePendingSharedAreaSyncs,
  resumePendingSharedProjectMetadataSyncs,
} from '@/lib/collaboration';
import CollaborationAvatar from '@/components/CollaborationAvatar';
import UserProfileModal from '@/components/UserProfileModal';
import AppMessageDialog from '@/components/AppMessageDialog';
import ListSortMenu, { type ListSortOption } from '@/components/ListSortMenu';
import AreaListViewToggle from '@/components/AreaListViewToggle';
import type { AreaListViewMode } from '@/features/projects/areaListView';
import {
  Activity,
  ArchiveRestore,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CloudDownload,
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
  UnlockKeyhole,
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
  singleProjectName: string;
  selectionMode?: boolean;
  isSharedProject?: boolean;
  sharedProjectId?: string;
  isCreatingJoinCode?: boolean;
  isLoadingSharedMembers?: boolean;
  isDisconnectingSharedProject?: boolean;
  isReleasingMyAreaLocks?: boolean;
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
    isReady,
    isSignedIn,
    signIn: signInToMicrosoft,
    signOut: signOutOfMicrosoft,
  } = useMicrosoftAuth();
  const collaborationAuth = useCollaborationAuth();
  const {
    localSaveError,
    localSaveStatus,
    retryInSeconds,
    sharedSyncSummary,
    sharedTransferStatus,
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
  const [sharedProjectAccessSnapshot, setSharedProjectAccessSnapshot] = useState<{
    projectId: string;
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
    if (!collaborationAuth.isSignedIn || !sharedProjectId) {
      return { isReady: false, isActiveMember: false, isOwner: false, hasError: false };
    }
    if (sharedProjectAccessSnapshot?.projectId === sharedProjectId) {
      return {
        isReady: true,
        isActiveMember: sharedProjectAccessSnapshot.isActiveMember,
        isOwner: sharedProjectAccessSnapshot.isOwner,
        hasError: sharedProjectAccessSnapshot.hasError,
      };
    }
    const cached = sharedProjectAccessCache.get(sharedProjectId);
    if (cached) {
      return { isReady: true, ...cached };
    }
    return { isReady: false, isActiveMember: false, isOwner: false, hasError: false };
  }, [
    collaborationAuth.isSignedIn,
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

  const syncButtonClasses = {
    idle: 'text-gray-700 hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]',
    syncing: 'animate-pulse bg-sky-100 text-sky-700 hover:bg-sky-100 dark:bg-sky-400/15 dark:text-sky-200',
    pending: 'text-gray-700 hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]',
    'needs-auth': 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
    error: 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
  } as const;

  const syncButtonLabel = {
    idle: 'Save a personal backup of project data and photos to your OneDrive',
    syncing: 'Saving personal OneDrive backup now',
    pending: 'Save pending changes to your personal OneDrive backup',
    'needs-auth': 'Sign in to save a personal OneDrive backup',
    error: 'Personal OneDrive backup needs attention',
  } as const;
  const syncButtonShortLabel = {
    idle: 'Personal Backup',
    syncing: 'Backing up',
    pending: 'Personal Backup',
    'needs-auth': 'Sign in',
    error: 'Error',
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

    if (!showHomeMenu || !collaborationAuth.isSignedIn || !sharedProjectId) {
      return () => {
        cancelled = true;
      };
    }

    void getSharedProjectAccess(sharedProjectId, collaborationAuth.user?.id)
      .then((access) => {
        if (cancelled) return;
        const next = {
          projectId: sharedProjectId,
          isActiveMember: access.isActiveMember,
          isOwner: access.isOwner,
          hasError: false,
        };
        sharedProjectAccessCache.set(sharedProjectId, {
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
          isActiveMember: false,
          isOwner: false,
          hasError: true,
        };
        sharedProjectAccessCache.set(sharedProjectId, {
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

  function renderOneDriveBackupButton() {
    const label = localSaveStatus === 'error'
      ? 'Local save needs attention'
      : displayRetryInSeconds > 0
      ? `Backup available in ${displayRetryInSeconds} seconds`
      : syncButtonLabel[displayStatus];
    const shortLabel = localSaveStatus === 'error'
      ? 'Save error'
      : displayRetryInSeconds > 0
      ? `${displayRetryInSeconds}s`
      : syncButtonShortLabel[displayStatus];
    const SyncIcon = localSaveStatus === 'error'
      ? Activity
      : displayRetryInSeconds > 0
        ? CloudUpload
        : syncButtonIcons[displayStatus];
    const buttonClasses = localSaveStatus === 'error'
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
          dispatchHomeAction('sync-now');
        }}
        disabled={displayStatus === 'syncing' || displayRetryInSeconds > 0}
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
    if (sharedSyncSummary.pendingCount === 0) return null;

    const needsReview = sharedSyncSummary.conflictCount > 0;
    const count = needsReview
      ? sharedSyncSummary.conflictCount
      : sharedSyncSummary.pendingCount;
    const label = needsReview
      ? `${count} team update${count === 1 ? '' : 's'} need review.${sharedSyncSummary.lastConflictError ? ` ${sharedSyncSummary.lastConflictError}` : ''}`
      : `${count} team change${count === 1 ? '' : 's'} waiting to send`;
    const shortLabel = needsReview ? 'Needs review' : count === 1 ? 'Sending…' : `${count} to send`;
    const SharedSyncIcon = needsReview ? Activity : CloudUpload;
    const classes = needsReview
      ? 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15'
      : 'bg-violet-50 text-violet-700 hover:bg-violet-100 dark:bg-violet-400/10 dark:text-violet-200 dark:hover:bg-violet-400/15';

    return (
      <button
        type="button"
        onClick={() => {
          setHomeMenuOpen(false);
          setInfoDialog({
            title: needsReview ? 'Team updates need review' : 'Team changes queued',
            message: needsReview
              ? `Some of your work needs a quick review before it can reach the team.\n\n1. Open the project\n2. Tap Get Team Updates\n3. Review anything that stayed on this device\n4. Tap Send to Team when you are ready${sharedSyncSummary.lastConflictError ? `\n\n${sharedSyncSummary.lastConflictError}` : ''}`
              : 'Your team changes are saved on this device and will send automatically when you have a connection and team projects are enabled.',
          });
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
  const activeTransferMenuRowBaseClass = `${menuRowClass} cursor-wait font-semibold`;
  const activePushMenuRowClass = `${activeTransferMenuRowBaseClass} bg-violet-100 text-violet-700 dark:bg-violet-400/20 dark:text-violet-100`;
  const activePullMenuRowClass = `${activeTransferMenuRowBaseClass} bg-sky-100 text-sky-700 dark:bg-sky-400/20 dark:text-sky-100`;
  return (
    <div className="persistent-top-bar fixed top-0 left-0 right-0 z-30 pt-[env(safe-area-inset-top)] md:border-b">
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
                        {renderOneDriveBackupButton()}
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
                            {homeMenuState.selectionMode ? 'Cancel Selection' : 'Select Areas'}
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
                          <>
                          <button
                            onClick={() => dispatchHomeAction('publish-shared-project')}
                            disabled={sharedTransferStatus !== null}
                            className={sharedTransferStatus === 'publishing' ? activePushMenuRowClass : disabledMenuRowClass}
                            aria-busy={sharedTransferStatus === 'publishing'}
                          >
                            <CloudUpload className={`h-4 w-4 shrink-0 ${sharedTransferStatus === 'publishing' ? 'animate-pulse' : ''}`} />
                            {sharedTransferStatus === 'publishing' ? 'Sending…' : 'Send to Team'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('pull-shared-project')}
                            disabled={sharedTransferStatus !== null}
                            className={sharedTransferStatus === 'pulling' ? activePullMenuRowClass : disabledMenuRowClass}
                            aria-busy={sharedTransferStatus === 'pulling'}
                          >
                            <CloudDownload className={`h-4 w-4 shrink-0 ${sharedTransferStatus === 'pulling' ? 'animate-pulse' : ''}`} />
                            {sharedTransferStatus === 'pulling' ? 'Updating…' : 'Get Team Updates'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('invite-people')}
                            disabled={!!homeMenuState.isCreatingJoinCode}
                            className={disabledMenuRowClass}
                          >
                            <UserPlus className="h-4 w-4 shrink-0" />
                            {homeMenuState.isCreatingJoinCode ? 'Preparing…' : 'Invite'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('release-my-area-locks')}
                            disabled={!!homeMenuState.isReleasingMyAreaLocks || sharedTransferStatus !== null}
                            className={disabledMenuRowClass}
                          >
                            <UnlockKeyhole className="h-4 w-4 shrink-0" />
                            {homeMenuState.isReleasingMyAreaLocks ? 'Releasing…' : 'Release Areas'}
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
                          {sharedProjectAccess.isReady && sharedProjectAccess.isActiveMember && (
                            <button
                              onClick={() => dispatchHomeAction('disconnect-shared-project')}
                              disabled={!!homeMenuState.isDisconnectingSharedProject}
                              className={disabledMenuRowSecondaryClass}
                            >
                              <LogOut className="h-4 w-4 shrink-0" />
                              {homeMenuState.isDisconnectingSharedProject
                                ? sharedProjectAccess.isOwner ? 'Stopping…' : 'Leaving…'
                                : sharedProjectAccess.isOwner ? 'Stop Team Sharing' : 'Leave Team Project'}
                            </button>
                          )}
                          </>
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
                        {showAuth && isSignedIn && !homeMenuState.isSingleProject && homeMenuState.hasProjects && renderOneDriveBackupButton()}
                        {showAuth && isSignedIn && !homeMenuState.isSingleProject && (
                          <button
                            type="button"
                            onClick={() => dispatchHomeAction('restore-onedrive-backup')}
                            disabled={displayStatus === 'syncing'}
                            className={disabledMenuRowClass}
                            aria-label="Restore missing projects and photos from your personal OneDrive backup"
                          >
                            <ArchiveRestore className="h-4 w-4 shrink-0" />
                            Restore My Backup
                          </button>
                        )}
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
                        {showAuth && collaborationAuth.isSignedIn && (
                          <button onClick={() => dispatchHomeAction('join-shared-project')} className={menuRowClass}>
                            <UserPlus className="h-4 w-4 shrink-0" />
                            Join Team Project
                          </button>
                        )}
                        {collaborationAuth.isSignedIn && (
                          <button onClick={() => dispatchHomeAction('my-shared-projects')} className={menuRowClass}>
                            <Users className="h-4 w-4 shrink-0" />
                            My Team Projects
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
                      ) : (
                        <button onClick={() => void handleMicrosoftAuthAction()} className={menuRowClass}>
                          <LogOut className="h-4 w-4 shrink-0" />
                          Sign Out
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                </div>
              </div>
            ), document.body)}
          </div>
        )}
      </div>
      <UserProfileModal open={showProfile} onClose={() => setShowProfile(false)} />
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
