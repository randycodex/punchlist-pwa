'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import ListSortPills from '@/components/ListSortPills';
import {
  Activity,
  ArchiveRestore,
  CheckCircle2,
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
  UserRound,
  UserPlus,
  Users,
} from 'lucide-react';

const projectTitleCache = new Map<string, string>();

type SortOption = 'alphabetical' | 'issues' | 'progress';
type HomeMenuState = {
  context?: 'home' | 'project';
  sortOption: SortOption;
  showTrash: boolean;
  canAddArea: boolean;
  isSingleProject: boolean;
  singleProjectName: string;
  selectionMode?: boolean;
  isSharedProject?: boolean;
  sharedProjectId?: string;
  isCreatingJoinCode?: boolean;
  isLoadingSharedMembers?: boolean;
  isDisconnectingSharedProject?: boolean;
};

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
  const [projectTitle, setProjectTitle] = useState('');
  const [showHomeMenu, setShowHomeMenu] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [sharedProjectAccess, setSharedProjectAccess] = useState({
    isReady: false,
    isActiveMember: false,
    isOwner: false,
    hasError: false,
  });
  const [homeMenuState, setHomeMenuState] = useState<HomeMenuState>({
    context: 'home',
    sortOption: 'alphabetical',
    showTrash: false,
    canAddArea: false,
    isSingleProject: false,
    singleProjectName: '',
    selectionMode: false,
  });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuScrollRef = useRef<HTMLDivElement | null>(null);
  const [menuCanScroll, setMenuCanScroll] = useState(false);
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
  const currentProjectTitle =
    homeMenuState.context === 'project' && homeMenuState.singleProjectName
      ? homeMenuState.singleProjectName
      : projectTitle;

  useEffect(() => {
    if (collaborationAuth.isSignedIn) {
      resumePendingSharedAreaSyncs();
      resumePendingSharedProjectMetadataSyncs();
    }
  }, [collaborationAuth.isSignedIn]);

  const syncButtonClasses = {
    idle: 'border-transparent bg-black/[0.07] text-gray-700 hover:bg-black/[0.10] dark:border-transparent dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.08]',
    syncing: 'animate-pulse border-sky-300 bg-sky-100 text-sky-700 hover:bg-sky-100 dark:border-sky-300/35 dark:bg-sky-400/15 dark:text-sky-200',
    pending: 'border-transparent bg-black/[0.07] text-gray-700 hover:bg-black/[0.10] dark:border-transparent dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.08]',
    'needs-auth': 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
    error: 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
  } as const;

  const syncButtonLabel = {
    idle: 'Sync with OneDrive',
    syncing: 'Syncing now',
    pending: 'Sync with OneDrive',
    'needs-auth': 'Sign in required to finish syncing',
    error: 'Sync needs attention',
  } as const;
  const syncButtonShortLabel = {
    idle: 'Sync',
    syncing: 'Syncing',
    pending: 'Sync',
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
        if (!cancelled) setProjectTitle('');
        return;
      }

      const cachedTitle = getCachedProjectName(projectId) ?? projectTitleCache.get(projectId);
      if (cachedTitle !== undefined) {
        if (!cancelled) {
          setProjectTitle(cachedTitle);
        }
      }

      try {
        const project = await getProjectMetadata(projectId);
        if (!cancelled) {
          const nextTitle = project?.projectName ?? '';
          projectTitleCache.set(projectId, nextTitle);
          setProjectTitle(nextTitle);
        }
      } catch {
        if (!cancelled) {
          setProjectTitle('');
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

  useEffect(() => {
    let cancelled = false;
    const sharedProjectId = homeMenuState.sharedProjectId;

    if (!showHomeMenu) {
      return () => {
        cancelled = true;
      };
    }

    if (!collaborationAuth.isSignedIn || !sharedProjectId) {
      void Promise.resolve().then(() => {
        if (!cancelled) {
          setSharedProjectAccess({ isReady: false, isActiveMember: false, isOwner: false, hasError: false });
        }
      });
      return () => {
        cancelled = true;
      };
    }

    void Promise.resolve().then(() => {
      if (!cancelled) {
        setSharedProjectAccess({ isReady: false, isActiveMember: false, isOwner: false, hasError: false });
      }
    });

    void getSharedProjectAccess(sharedProjectId, collaborationAuth.user?.id)
      .then((access) => {
        if (!cancelled) {
          setSharedProjectAccess({ isReady: true, ...access, hasError: false });
        }
      })
      .catch((error) => {
        console.error('Failed to verify shared project access:', error);
        if (!cancelled) {
          setSharedProjectAccess({ isReady: true, isActiveMember: false, isOwner: false, hasError: true });
        }
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
    const root = document.documentElement;
    if (showHomeMenu) {
      root.dataset.appMenuOpen = 'true';
    } else {
      delete root.dataset.appMenuOpen;
    }

    return () => {
      delete root.dataset.appMenuOpen;
    };
  }, [showHomeMenu]);

  useLayoutEffect(() => {
    if (!showHomeMenu) return;

    const scrollContainer = menuScrollRef.current;
    if (!scrollContainer) return;

    const updateScrollState = () => {
      const nextCanScroll = scrollContainer.scrollHeight > scrollContainer.clientHeight + 1;
      setMenuCanScroll((current) => current === nextCanScroll ? current : nextCanScroll);
      if (!nextCanScroll && scrollContainer.scrollTop !== 0) {
        scrollContainer.scrollTop = 0;
      }
    };

    updateScrollState();
    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(scrollContainer);
    const mutationObserver = new MutationObserver(updateScrollState);
    mutationObserver.observe(scrollContainer, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.visualViewport?.addEventListener('resize', updateScrollState);

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.visualViewport?.removeEventListener('resize', updateScrollState);
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

  function dispatchHomeAction(action: string, sort?: SortOption) {
    window.dispatchEvent(new CustomEvent('punchlist-home-menu-action', {
      detail: {
        action,
        sort,
        isSharedProjectOwner: action === 'disconnect-shared-project'
          ? sharedProjectAccess.isOwner
          : undefined,
      },
    }));
  }

  function renderSyncButton() {
    const label = localSaveStatus === 'error'
      ? 'Local save needs attention'
      : displayRetryInSeconds > 0
      ? `Sync available in ${displayRetryInSeconds} seconds`
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
            window.alert(
              `This device could not save the latest change. Keep the app open and try the action again.${localSaveError ? ` ${localSaveError}` : ''}`
            );
            return;
          }
          dispatchHomeAction('sync-now');
        }}
        disabled={displayStatus === 'syncing' || displayRetryInSeconds > 0}
        className={`${syncMenuPillBaseClass} ${buttonClasses}`}
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
      ? `${count} shared update${count === 1 ? '' : 's'} need review.${sharedSyncSummary.lastConflictError ? ` ${sharedSyncSummary.lastConflictError}` : ''}`
      : `${count} shared update${count === 1 ? '' : 's'} waiting to sync`;
    const shortLabel = needsReview ? 'Shared issue' : count === 1 ? 'Shared pending' : `Shared ${count}`;
    const SharedSyncIcon = needsReview ? Activity : CloudUpload;
    const classes = needsReview
      ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15'
      : 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-400/25 dark:bg-violet-400/10 dark:text-violet-200 dark:hover:bg-violet-400/15';

    return (
      <button
        type="button"
        onClick={() => {
          window.alert(needsReview
            ? `Shared work needs review. Open the affected project, pull the latest shared data, review the preserved local work, then save the next intended edit to resume syncing.${sharedSyncSummary.lastConflictError ? ` ${sharedSyncSummary.lastConflictError}` : ''}`
            : 'Shared work is safely queued on this device and will retry automatically when the connection and shared-project account are available.');
        }}
        className={`flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 rounded-[1rem] border px-2.5 transition ${classes}`}
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

  const menuCardClass = 'app-menu-card rounded-[1.25rem] p-2.5';
  const menuGroupLabelClass = 'px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400';
  const menuPillGridClass = 'grid grid-cols-2 gap-2 px-1 pb-1';
  const menuPillClass = 'flex min-h-10 min-w-0 items-center gap-2 rounded-full bg-black/[0.07] px-3 py-2 text-left text-[13px] font-medium leading-tight text-gray-700 transition hover:bg-black/[0.10] dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.08]';
  const syncMenuPillBaseClass = 'flex min-h-10 min-w-0 items-center gap-2 rounded-full border px-3 py-2 text-left text-[13px] font-medium leading-tight transition disabled:cursor-default';
  const disabledMenuPillClass = `${menuPillClass} disabled:cursor-default disabled:opacity-60`;
  const activeTransferMenuPillBaseClass = 'flex min-h-10 min-w-0 cursor-wait items-center gap-2 rounded-full border px-3 py-2 text-left text-[13px] font-semibold leading-tight transition';
  const activePushMenuPillClass = `${activeTransferMenuPillBaseClass} border-violet-300 bg-violet-100 text-violet-700 dark:border-violet-400/35 dark:bg-violet-400/20 dark:text-violet-100`;
  const activePullMenuPillClass = `${activeTransferMenuPillBaseClass} border-sky-300 bg-sky-100 text-sky-700 dark:border-sky-400/35 dark:bg-sky-400/20 dark:text-sky-100`;
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
              <button
                type="button"
                onClick={() => setShowHomeMenu((current) => !current)}
                className="flex h-10 w-10 items-center justify-center rounded-[1rem] bg-transparent text-gray-500 transition hover:bg-black/[0.04] hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                aria-label={showHomeMenu ? 'Close app menu' : 'Open app menu'}
                aria-pressed={showHomeMenu}
                title={showHomeMenu ? 'Close app menu' : 'Open app menu'}
              >
                {showHomeMenu ? <PanelRightClose className="h-5 w-5" /> : <PanelRightOpen className="h-5 w-5" />}
              </button>
            )}
            {!isAreaRoute && showHomeMenu && createPortal((
              <div
                className="app-menu-drawer menu-surface fixed right-0 z-[120] flex h-[100dvh] flex-col overflow-hidden border-y-0 border-r-0 p-0"
                role="dialog"
                aria-modal="false"
                aria-label="App menu"
              >
                <div className="shrink-0 px-3 pt-2 md:pt-[calc(env(safe-area-inset-top)+0.5rem)]">
                  <div className="px-1 py-1">
                    <div className={menuCardClass}>
                      <div className="px-1 py-1">
                        <ListSortPills
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
                <div
                  ref={menuScrollRef}
                  className={`scrollbar-hidden min-h-0 flex-1 overflow-x-hidden px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] ${menuCanScroll ? 'touch-pan-y overflow-y-auto overscroll-none' : 'touch-pan-x overflow-y-hidden overscroll-none'}`}
                >
                {homeMenuState.isSingleProject && (
                  <div className="px-1 py-1">
                    <div className={menuCardClass}>
                      <div className={menuGroupLabelClass}>Current Project</div>
                      <div className={menuPillGridClass}>
                        <button onClick={() => dispatchHomeAction('edit-project')} className={menuPillClass}>
                          <Pencil className="h-4 w-4 shrink-0" />
                          Edit
                        </button>
                        {renderSyncButton()}
                        {homeMenuState.canAddArea && (
                          <button
                            onClick={() => {
                              const enteringSelectionMode = !homeMenuState.selectionMode;
                              dispatchHomeAction('toggle-selection');
                              if (enteringSelectionMode && window.matchMedia('(max-width: 767px)').matches) {
                                setShowHomeMenu(false);
                              }
                            }}
                            className={menuPillClass}
                          >
                            <CheckCircle2 className="h-4 w-4 shrink-0" />
                            {homeMenuState.selectionMode ? 'Cancel Selection' : 'Select Areas'}
                          </button>
                        )}
                        <button onClick={() => dispatchHomeAction('export-project')} className={menuPillClass}>
                          <FileDown className="h-4 w-4 shrink-0" />
                          Export
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {homeMenuState.isSingleProject && collaborationAuth.isSignedIn && (
                  <div className="px-1 py-1">
                    <div className={menuCardClass}>
                      <div className={menuGroupLabelClass}>Collaboration</div>
                      <div className={menuPillGridClass}>
                        {!homeMenuState.isSharedProject && (
                          <button
                            onClick={() => dispatchHomeAction('share-project')}
                            className={menuPillClass}
                          >
                            <Share2 className="h-4 w-4 shrink-0" />
                            Start Sharing
                          </button>
                        )}
                        {homeMenuState.isSingleProject && homeMenuState.isSharedProject && !sharedProjectAccess.isReady && (
                          <div className="col-span-2 px-2 py-2 text-xs text-gray-500 dark:text-gray-400">
                            Checking shared access. Actions remain available while this finishes.
                          </div>
                        )}
                        {homeMenuState.isSingleProject && homeMenuState.isSharedProject && (!sharedProjectAccess.isReady || sharedProjectAccess.isActiveMember || sharedProjectAccess.hasError) && (
                          <>
                          <button
                            onClick={() => dispatchHomeAction('publish-shared-project')}
                            disabled={sharedTransferStatus !== null}
                            className={sharedTransferStatus === 'publishing' ? activePushMenuPillClass : disabledMenuPillClass}
                            aria-busy={sharedTransferStatus === 'publishing'}
                          >
                            <CloudUpload className={`h-4 w-4 shrink-0 ${sharedTransferStatus === 'publishing' ? 'animate-pulse' : ''}`} />
                            {sharedTransferStatus === 'publishing' ? 'Pushing...' : 'Push Changes'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('pull-shared-project')}
                            disabled={sharedTransferStatus !== null}
                            className={sharedTransferStatus === 'pulling' ? activePullMenuPillClass : disabledMenuPillClass}
                            aria-busy={sharedTransferStatus === 'pulling'}
                          >
                            <CloudDownload className={`h-4 w-4 shrink-0 ${sharedTransferStatus === 'pulling' ? 'animate-pulse' : ''}`} />
                            {sharedTransferStatus === 'pulling' ? 'Pulling...' : 'Pull Changes'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('invite-people')}
                            disabled={!!homeMenuState.isCreatingJoinCode}
                            className={disabledMenuPillClass}
                          >
                            <UserPlus className="h-4 w-4 shrink-0" />
                            {homeMenuState.isCreatingJoinCode ? 'Preparing...' : 'Invite'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('shared-members')}
                            disabled={!!homeMenuState.isLoadingSharedMembers}
                            className={disabledMenuPillClass}
                          >
                            <Users className="h-4 w-4 shrink-0" />
                            {homeMenuState.isLoadingSharedMembers ? 'Loading...' : 'Members'}
                          </button>
                          <button onClick={() => dispatchHomeAction('shared-backups')} className={menuPillClass}>
                            <ArchiveRestore className="h-4 w-4 shrink-0" />
                            Shared Backups
                          </button>
                          {sharedProjectAccess.isReady && sharedProjectAccess.isActiveMember && (
                            <button
                              onClick={() => dispatchHomeAction('disconnect-shared-project')}
                              disabled={!!homeMenuState.isDisconnectingSharedProject}
                              className={disabledMenuPillClass}
                            >
                              <LogOut className="h-4 w-4 shrink-0" />
                              {homeMenuState.isDisconnectingSharedProject
                                ? sharedProjectAccess.isOwner ? 'Stopping...' : 'Leaving...'
                                : sharedProjectAccess.isOwner ? 'Stop Sharing' : 'Leave Project'}
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
                                ? 'Shared access could not be verified. You can retry an action or keep the local copy only.'
                                : 'This device is linked to a shared copy that is not active for this account. Reconnect it to an active copy or keep the project local only.'}
                            </div>
                            <button
                              onClick={() => dispatchHomeAction('my-shared-projects')}
                              className={menuPillClass}
                            >
                              <Users className="h-4 w-4 shrink-0" />
                              Reconnect Project
                            </button>
                            <button
                              onClick={() => dispatchHomeAction('unlink-inactive-shared-project')}
                              className={menuPillClass}
                            >
                              <LogOut className="h-4 w-4 shrink-0" />
                              Keep Local Copy
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {(showAuth || projectId) && (
                  <div className="px-1 py-1">
                    <div className={menuCardClass}>
                      <div className={menuGroupLabelClass}>Projects</div>
                      <div className={menuPillGridClass}>
                        {showAuth && (
                          <button onClick={() => dispatchHomeAction('new-project')} className={menuPillClass}>
                            <PlusSquare className="h-4 w-4 shrink-0" />
                            New Project
                          </button>
                        )}
                        {showAuth && collaborationAuth.isSignedIn && (
                          <button onClick={() => dispatchHomeAction('join-shared-project')} className={menuPillClass}>
                            <UserPlus className="h-4 w-4 shrink-0" />
                            Join Project
                          </button>
                        )}
                        {showAuth && collaborationAuth.isSignedIn ? (
                          <button onClick={() => dispatchHomeAction('my-shared-projects')} className={menuPillClass}>
                            <Users className="h-4 w-4 shrink-0" />
                            Manage Projects
                          </button>
                        ) : projectId ? (
                          <Link href="/" className={menuPillClass}>
                            <Users className="h-4 w-4 shrink-0" />
                            Manage Projects
                          </Link>
                        ) : null}
                        {showAuth && (
                          <button onClick={() => dispatchHomeAction('toggle-trash')} className={menuPillClass}>
                            <Trash2 className="h-4 w-4 shrink-0" />
                            Trash
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                <div className="px-1 py-1">
                  <div className={menuCardClass}>
                    <div className={menuGroupLabelClass}>Account</div>
                    <div className={menuPillGridClass}>
                      {collaborationAuth.isSignedIn && (
                        <button
                          onClick={() => {
                            setShowProfile(true);
                          }}
                          className={menuPillClass}
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
                        <button onClick={() => void handleMicrosoftAuthAction()} className={menuPillClass}>
                          <LogIn className="h-4 w-4 shrink-0" />
                          Sign In
                        </button>
                      ) : (
                        <button onClick={() => void handleMicrosoftAuthAction()} className={menuPillClass}>
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
    </div>
  );
}
