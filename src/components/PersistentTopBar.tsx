'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { getProjectMetadata } from '@/lib/db';
import { hasPendingSyncState } from '@/lib/pendingSync';
import { getCachedProjectName } from '@/lib/projectNavigationCache';
import {
  getCollaborationProfileInitials,
  getSharedProjectAccess,
  resumePendingSharedAreaSyncs,
} from '@/lib/collaboration';
import UserProfileModal from '@/components/UserProfileModal';
import {
  Activity,
  ArchiveRestore,
  ArrowDownAZ,
  BarChart3,
  CheckCircle2,
  Clock3,
  CloudDownload,
  CloudUpload,
  FileDown,
  FolderPlus,
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
type QuickSortOption = 'issues' | 'alphabetical' | 'progress';
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
  isTransferringSharedProject?: boolean;
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
    sharedAreaSyncSummary,
    sharedTransferStatus,
    status,
  } = useSyncStatus();
  const { quickSort } = useAppSettings();
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
    }
  }, [collaborationAuth.isSignedIn]);

  const syncButtonClasses = {
    idle: 'border-black/5 bg-white/70 text-gray-600 hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]',
    syncing: 'animate-pulse border-sky-300 bg-sky-100 text-sky-700 hover:bg-sky-100 dark:border-sky-300/35 dark:bg-sky-400/15 dark:text-sky-200',
    pending: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200 dark:hover:bg-amber-400/15',
    'needs-auth': 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
    error: 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
  } as const;

  const syncButtonLabel = {
    idle: 'Sync with OneDrive',
    syncing: 'Syncing now',
    pending: 'Sync pending',
    'needs-auth': 'Sign in required to finish syncing',
    error: 'Sync needs attention',
  } as const;
  const syncButtonShortLabel = {
    idle: 'Sync',
    syncing: 'Syncing',
    pending: 'Pending',
    'needs-auth': 'Sign in',
    error: 'Error',
  } as const;
  const syncButtonIcons = {
    idle: RefreshCw,
    syncing: RefreshCw,
    pending: CloudUpload,
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
    if (!showHomeMenu) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowHomeMenu(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showHomeMenu]);

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
    setShowHomeMenu(false);
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

  const sortOptions: Array<{ value: SortOption; label: string; icon: typeof ArrowDownAZ }> = [
    { value: 'alphabetical', label: 'Sort: Alphabetical', icon: ArrowDownAZ },
    { value: 'issues', label: 'Sort: Issues first', icon: Clock3 },
    { value: 'progress', label: 'Sort: Progress', icon: BarChart3 },
  ];

  const quickSortOptions: Array<{ value: QuickSortOption; label: string }> = [
    { value: 'issues', label: 'Issues first' },
    { value: 'alphabetical', label: 'Alphabetical' },
    { value: 'progress', label: 'Progress' },
  ];

  function dispatchHomeAction(action: string, sort?: SortOption, options?: { keepMenuOpen?: boolean }) {
    window.dispatchEvent(new CustomEvent('punchlist-home-menu-action', {
      detail: {
        action,
        sort,
        isSharedProjectOwner: action === 'disconnect-shared-project'
          ? sharedProjectAccess.isOwner
          : undefined,
      },
    }));
    if (!options?.keepMenuOpen) {
      setShowHomeMenu(false);
    }
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
          setShowHomeMenu(false);
          if (localSaveStatus === 'error') {
            window.alert(
              `This device could not save the latest change. Keep the app open and try the action again.${localSaveError ? ` ${localSaveError}` : ''}`
            );
            return;
          }
          dispatchHomeAction('sync-now');
        }}
        disabled={displayStatus === 'syncing' || displayRetryInSeconds > 0}
        className={`flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 rounded-[1rem] border px-2.5 transition ${buttonClasses}`}
        aria-label={label}
        title={label}
      >
        <SyncIcon className={`h-4 w-4 ${displayStatus === 'syncing' && displayRetryInSeconds === 0 ? 'animate-spin' : ''}`} />
        <span className="text-xs font-bold leading-none tracking-normal">{shortLabel}</span>
      </button>
    );
  }

  function renderSharedTransferIndicator() {
    if (!sharedTransferStatus) return null;

    const isPublishing = sharedTransferStatus === 'publishing';
    const label = isPublishing ? 'Pushing shared data' : 'Pulling shared data';
    const shortLabel = isPublishing ? 'Pushing' : 'Pulling';
    const TransferIcon = isPublishing ? CloudUpload : CloudDownload;

    return (
      <div
        className="flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 rounded-[1rem] border border-violet-200 bg-violet-50 px-2.5 text-violet-700 dark:border-violet-400/25 dark:bg-violet-400/10 dark:text-violet-200"
        role="status"
        aria-live="polite"
        aria-label={label}
        title={label}
      >
        <TransferIcon className="h-4 w-4 animate-pulse" />
        <span className="text-xs font-bold leading-none tracking-normal">{shortLabel}</span>
      </div>
    );
  }

  function renderSharedAreaSyncIndicator() {
    if (sharedAreaSyncSummary.pendingCount === 0) return null;

    const needsReview = sharedAreaSyncSummary.conflictCount > 0;
    const count = needsReview
      ? sharedAreaSyncSummary.conflictCount
      : sharedAreaSyncSummary.pendingCount;
    const label = needsReview
      ? `${count} shared area update${count === 1 ? '' : 's'} need review.${sharedAreaSyncSummary.lastConflictError ? ` ${sharedAreaSyncSummary.lastConflictError}` : ''}`
      : `${count} shared area update${count === 1 ? '' : 's'} waiting to sync`;
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
            ? `Shared area work needs review. Open the affected project, pull the latest shared data, review the preserved local area, then save the next intended edit to resume syncing.${sharedAreaSyncSummary.lastConflictError ? ` ${sharedAreaSyncSummary.lastConflictError}` : ''}`
            : 'Shared area work is safely queued on this device and will retry automatically when the connection and shared-project account are available.');
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

  const menuCardClass = 'app-menu-card space-y-1 rounded-[1.25rem] p-2.5';
  const menuGroupLabelClass = 'px-3 pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400';
  const menuItemClass = 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.04]';
  const disabledMenuItemClass = `${menuItemClass} disabled:cursor-default disabled:opacity-60`;

  return (
    <div className="persistent-top-bar fixed top-0 left-0 right-0 z-30 pt-[env(safe-area-inset-top)] md:border-b">
      <div className="top-bar-surface mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-5">
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
            {renderSharedTransferIndicator()}
            {renderSharedAreaSyncIndicator()}
            {renderSyncButton()}
            {!isAreaRoute && (
              <button
                type="button"
                onClick={() => setShowHomeMenu((current) => !current)}
                className="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-500 transition hover:bg-white hover:text-gray-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
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
                <div className="scrollbar-hidden min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-2 md:pt-[calc(env(safe-area-inset-top)+0.5rem)]">
                {showAuth && (
                  <div className="px-1 py-1">
                    <div className="app-menu-card space-y-2 rounded-[1.25rem] p-2.5">
                      <div className="px-3 pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
                        Sort
                      </div>
                      <div className="flex flex-wrap gap-2 px-3 pb-1">
                        {quickSortOptions.map((option) => (
                          <button
                            key={option.value}
                            onClick={() => dispatchHomeAction(`quick-sort:${option.value}`, undefined, { keepMenuOpen: true })}
                            className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                              quickSort === option.value
                                ? 'bg-[var(--accent)] text-white'
                                : 'bg-black/[0.04] text-gray-600 hover:bg-black/[0.07] dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.08]'
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {!showAuth && (
                  <>
                  <div className="px-1 py-1">
                    <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-500 dark:text-gray-400">
                      Sort
                    </div>
                    <div className="app-menu-card space-y-2 rounded-[1.25rem] p-2.5">
                      {sortOptions.map(({ value, label, icon: Icon }) => (
                        <button
                          key={value}
                          onClick={() => dispatchHomeAction('sort', value, { keepMenuOpen: true })}
                          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                            homeMenuState.sortOption === value
                              ? 'bg-[var(--accent)] font-medium text-white'
                              : 'text-gray-700 hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.04]'
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                          {label.replace('Sort: ', '')}
                        </button>
                      ))}
                    </div>
                  </div>
                  </>
                )}
                {(homeMenuState.context === 'project' || homeMenuState.isSingleProject) && (
                  <div className="px-1 py-1">
                    <div className={menuCardClass}>
                      <div className={menuGroupLabelClass}>Project</div>
                      {(homeMenuState.context === 'project' || homeMenuState.isSingleProject) && (
                        <button onClick={() => dispatchHomeAction('edit-project')} className={menuItemClass}>
                          <Pencil className="h-4 w-4" />
                          Edit project
                        </button>
                      )}
                      {homeMenuState.isSingleProject && (
                        <button onClick={() => dispatchHomeAction('export-project')} className={menuItemClass}>
                          <FileDown className="h-4 w-4" />
                          Export project
                        </button>
                      )}
                      {homeMenuState.isSingleProject && homeMenuState.canAddArea && (
                        <button onClick={() => dispatchHomeAction('toggle-selection')} className={menuItemClass}>
                          <CheckCircle2 className="h-4 w-4" />
                          {homeMenuState.selectionMode ? 'Cancel selection' : 'Select areas'}
                        </button>
                      )}
                      {homeMenuState.isSingleProject && collaborationAuth.isSignedIn && (
                        <button
                          onClick={() => dispatchHomeAction('share-project')}
                          disabled={!!homeMenuState.isSharedProject}
                          className={disabledMenuItemClass}
                        >
                          {homeMenuState.isSharedProject ? (
                            <CheckCircle2 className="h-4 w-4" />
                          ) : (
                            <Share2 className="h-4 w-4" />
                          )}
                          {homeMenuState.isSharedProject ? 'Project shared' : 'Share project'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {(showAuth || (homeMenuState.isSingleProject && homeMenuState.isSharedProject)) && collaborationAuth.isSignedIn && (
                  <div className="px-1 py-1">
                    <div className={menuCardClass}>
                      <div className={menuGroupLabelClass}>Shared project</div>
                      {homeMenuState.isSingleProject && homeMenuState.isSharedProject && !sharedProjectAccess.isReady && (
                        <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                          Checking shared access. Actions remain available while this finishes.
                        </div>
                      )}
                      {homeMenuState.isSingleProject && homeMenuState.isSharedProject && (!sharedProjectAccess.isReady || sharedProjectAccess.isActiveMember || sharedProjectAccess.hasError) && (
                        <>
                          <button
                            onClick={() => dispatchHomeAction('invite-code')}
                            disabled={!!homeMenuState.isCreatingJoinCode}
                            className={disabledMenuItemClass}
                          >
                            <KeyRound className="h-4 w-4" />
                            {homeMenuState.isCreatingJoinCode ? 'Creating code...' : 'Invite by code'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('shared-members')}
                            disabled={!!homeMenuState.isLoadingSharedMembers}
                            className={disabledMenuItemClass}
                          >
                            <Users className="h-4 w-4" />
                            {homeMenuState.isLoadingSharedMembers ? 'Loading members...' : 'Shared members'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('publish-shared-project')}
                            disabled={sharedTransferStatus !== null}
                            className={disabledMenuItemClass}
                          >
                            <CloudUpload className="h-4 w-4" />
                            {sharedTransferStatus === 'publishing' ? 'Publishing...' : 'Publish shared data'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('pull-shared-project')}
                            disabled={sharedTransferStatus !== null}
                            className={disabledMenuItemClass}
                          >
                            <CloudDownload className="h-4 w-4" />
                            {sharedTransferStatus === 'pulling' ? 'Pulling...' : 'Pull shared data'}
                          </button>
                          <button onClick={() => dispatchHomeAction('shared-backups')} className={menuItemClass}>
                            <ArchiveRestore className="h-4 w-4" />
                            Shared backups
                          </button>
                          {sharedProjectAccess.isReady && sharedProjectAccess.isActiveMember && (
                            <button
                              onClick={() => dispatchHomeAction('disconnect-shared-project')}
                              disabled={!!homeMenuState.isDisconnectingSharedProject}
                              className={disabledMenuItemClass}
                            >
                              <LogOut className="h-4 w-4" />
                              {homeMenuState.isDisconnectingSharedProject
                                ? sharedProjectAccess.isOwner ? 'Stopping...' : 'Leaving...'
                                : sharedProjectAccess.isOwner ? 'Stop sharing' : 'Leave shared project'}
                            </button>
                          )}
                          {sharedProjectAccess.isOwner && (
                            <button
                              onClick={() => dispatchHomeAction('transfer-shared-project')}
                              disabled={!!homeMenuState.isTransferringSharedProject}
                              className={disabledMenuItemClass}
                            >
                              <Users className="h-4 w-4" />
                              {homeMenuState.isTransferringSharedProject ? 'Transferring...' : 'Transfer ownership'}
                            </button>
                          )}
                        </>
                      )}
                      {homeMenuState.isSingleProject &&
                        homeMenuState.isSharedProject &&
                        sharedProjectAccess.isReady &&
                        !sharedProjectAccess.isActiveMember && (
                          <>
                            <div className="px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                              {sharedProjectAccess.hasError ? 'Shared access could not be verified. You can retry an action or keep the local copy only.' : 'This account is not an active member of this shared project.'}
                            </div>
                            <button
                              onClick={() => dispatchHomeAction('unlink-inactive-shared-project')}
                              className={menuItemClass}
                            >
                              <LogOut className="h-4 w-4" />
                              Keep local copy only
                            </button>
                          </>
                        )}
                      {showAuth && (
                        <>
                          <button onClick={() => dispatchHomeAction('my-shared-projects')} className={menuItemClass}>
                            <Users className="h-4 w-4" />
                            My shared projects
                          </button>
                          <button onClick={() => dispatchHomeAction('join-shared-project')} className={menuItemClass}>
                            <UserPlus className="h-4 w-4" />
                            Join shared project
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
                {(homeMenuState.context !== 'project' || (homeMenuState.canAddArea && !homeMenuState.isSingleProject)) && (
                  <div className="px-1 py-1">
                    <div className={menuCardClass}>
                      <div className={menuGroupLabelClass}>Create</div>
                      {homeMenuState.context !== 'project' && (
                        <button onClick={() => dispatchHomeAction('new-project')} className={menuItemClass}>
                          <PlusSquare className="h-4 w-4" />
                          Add project
                        </button>
                      )}
                      {homeMenuState.canAddArea && !homeMenuState.isSingleProject && (
                        <button onClick={() => dispatchHomeAction('new-area')} className={menuItemClass}>
                          <FolderPlus className="h-4 w-4" />
                          Add area
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <div className="px-1 py-1">
                  <div className={menuCardClass}>
                    <div className={menuGroupLabelClass}>Account</div>
                    <button onClick={() => dispatchHomeAction('toggle-trash')} className={menuItemClass}>
                      <Trash2 className="h-4 w-4" />
                      {homeMenuState.showTrash ? 'Hide trash' : 'Trash'}
                    </button>
                    {collaborationAuth.isSignedIn && (
                      <button
                        onClick={() => {
                          setShowHomeMenu(false);
                          setShowProfile(true);
                        }}
                        className={menuItemClass}
                      >
                        {collaborationAuth.profile ? (
                          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[var(--accent)] text-[9px] font-bold text-white">
                            {getCollaborationProfileInitials(collaborationAuth.profile)}
                          </span>
                        ) : (
                          <UserRound className="h-4 w-4" />
                        )}
                        {collaborationAuth.profile ? 'Edit profile' : 'Create profile'}
                      </button>
                    )}
                    {isSignedIn && (
                      <button
                        onClick={() => {
                          if (collaborationAuth.isSignedIn) {
                            void collaborationAuth.signOut();
                          } else {
                            void collaborationAuth.signIn();
                          }
                          setShowHomeMenu(false);
                        }}
                        className={menuItemClass}
                      >
                        <Users className="h-4 w-4" />
                        {collaborationAuth.isSignedIn ? 'Leave shared projects' : 'Enable shared projects'}
                      </button>
                    )}
                    {isSignedIn && (
                      <button onClick={() => dispatchHomeAction('collaboration-health')} className={menuItemClass}>
                        <Activity className="h-4 w-4" />
                        Collaboration health
                      </button>
                    )}
                    {!isSignedIn ? (
                      <button onClick={() => void handleMicrosoftAuthAction()} className={menuItemClass}>
                        <LogIn className="h-4 w-4" />
                        Sign in
                      </button>
                    ) : (
                      <button onClick={() => void handleMicrosoftAuthAction()} className={menuItemClass}>
                        <LogOut className="h-4 w-4" />
                        Sign out
                      </button>
                    )}
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
