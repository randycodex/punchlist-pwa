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
import { getProject } from '@/lib/db';
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
  MoreVertical,
  Pencil,
  PlusSquare,
  RefreshCw,
  Share2,
  Trash2,
  UserPlus,
  Users,
  X,
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
  isCreatingJoinCode?: boolean;
  isLoadingSharedMembers?: boolean;
  isPublishingSharedProject?: boolean;
  isPullingSharedProject?: boolean;
  isDisconnectingSharedProject?: boolean;
  isTransferringSharedProject?: boolean;
};

export default function PersistentTopBar() {
  const pathname = usePathname();
  const { isReady, isSignedIn } = useMicrosoftAuth();
  const collaborationAuth = useCollaborationAuth();
  const { retryInSeconds, status } = useSyncStatus();
  const { quickSort } = useAppSettings();
  const showAuth = pathname === '/';
  const isProjectOverview = /^\/project\/[^/]+$/.test(pathname);
  const showTopMenu = showAuth || isProjectOverview;
  const [projectTitle, setProjectTitle] = useState('');
  const [showHomeMenu, setShowHomeMenu] = useState(false);
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

  const syncButtonClasses = {
    idle: 'border-green-200 bg-green-50 text-green-600 hover:bg-green-100 dark:border-green-400/25 dark:bg-green-400/10 dark:text-green-300 dark:hover:bg-green-400/15',
    syncing: 'animate-pulse border-green-300 bg-green-100 text-green-700 hover:bg-green-100 dark:border-green-300/35 dark:bg-green-400/15 dark:text-green-200',
    pending: 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
    'needs-auth': 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
    error: 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-400/25 dark:bg-red-400/10 dark:text-red-300 dark:hover:bg-red-400/15',
  } as const;

  const syncButtonLabel = {
    idle: 'Synced',
    syncing: 'Syncing now',
    pending: 'Sync pending',
    'needs-auth': 'Sign in required to finish syncing',
    error: 'Sync needs attention',
  } as const;
  const syncButtonShortLabel = {
    idle: 'Synced',
    syncing: 'Syncing',
    pending: 'Pending',
    'needs-auth': 'Sign in',
    error: 'Error',
  } as const;
  const syncButtonIcons = {
    idle: CheckCircle2,
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

      const cachedTitle = projectTitleCache.get(projectId);
      if (cachedTitle !== undefined) {
        if (!cancelled) {
          setProjectTitle(cachedTitle);
        }
        return;
      }

      try {
        const project = await getProject(projectId);
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
    window.dispatchEvent(new CustomEvent('punchlist-home-menu-action', { detail: { action, sort } }));
    if (!options?.keepMenuOpen) {
      setShowHomeMenu(false);
    }
  }

  function renderSyncButton() {
    const label = retryInSeconds > 0 ? `Sync available in ${retryInSeconds} seconds` : syncButtonLabel[status];
    const shortLabel = retryInSeconds > 0 ? `${retryInSeconds}s` : syncButtonShortLabel[status];
    const SyncIcon = retryInSeconds > 0 ? CloudUpload : syncButtonIcons[status];

    return (
      <button
        type="button"
        onClick={() => dispatchHomeAction('sync-now')}
        className={`flex h-10 min-w-10 shrink-0 items-center justify-center gap-2 rounded-[1rem] border px-2.5 transition ${syncButtonClasses[status]}`}
        aria-label={label}
        title={label}
      >
        <SyncIcon className={`h-4 w-4 ${status === 'syncing' && retryInSeconds === 0 ? 'animate-spin' : ''}`} />
        <span className="text-xs font-bold leading-none tracking-normal">{shortLabel}</span>
      </button>
    );
  }

  const menuCardClass = 'space-y-1 rounded-[1.25rem] bg-black/[0.03] p-2.5 dark:bg-white/[0.03]';
  const menuGroupLabelClass = 'px-3 pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400';
  const menuItemClass = 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.04]';
  const disabledMenuItemClass = `${menuItemClass} disabled:cursor-default disabled:opacity-60`;

  return (
    <div className="persistent-top-bar fixed top-0 left-0 right-0 z-30 border-b pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-5">
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
              width={40}
              height={40}
              className="object-contain"
              priority
            />
          </Link>
        </div>
        {(showTopMenu || showHomeMenu) && isReady && !homeMenuState.showTrash && (
          <div ref={menuRef} className="relative flex items-center gap-2">
            {renderSyncButton()}
            <button
              onClick={() => setShowHomeMenu((current) => !current)}
              className="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-500 transition hover:bg-white hover:text-gray-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
              aria-label="Open app menu"
            >
              <MoreVertical className="h-5 w-5" />
            </button>
            {showHomeMenu && createPortal((
              <div
                className="app-menu-drawer menu-surface fixed right-0 top-0 z-[120] flex h-[100dvh] flex-col overflow-hidden border-y-0 border-r-0 p-0"
                role="dialog"
                aria-modal="false"
                aria-label="App menu"
              >
                <div className="flex h-[calc(env(safe-area-inset-top)+3.5rem)] shrink-0 items-center justify-end border-b border-black/[0.05] px-4 pt-[env(safe-area-inset-top)] dark:border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => setShowHomeMenu(false)}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-500 transition hover:bg-white hover:text-gray-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
                    aria-label="Close app menu"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="scrollbar-hidden min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-2">
                {showAuth && (
                  <div className="px-1 py-1">
                    <div className="space-y-2 rounded-[1.25rem] bg-black/[0.03] p-2.5 dark:bg-white/[0.03]">
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
                    <div className="space-y-2 rounded-[1.25rem] bg-black/[0.03] p-2.5 dark:bg-white/[0.03]">
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
                      {homeMenuState.isSingleProject && homeMenuState.isSharedProject && (
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
                            disabled={!!homeMenuState.isPublishingSharedProject}
                            className={disabledMenuItemClass}
                          >
                            <CloudUpload className="h-4 w-4" />
                            {homeMenuState.isPublishingSharedProject ? 'Publishing...' : 'Publish shared data'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('pull-shared-project')}
                            disabled={!!homeMenuState.isPullingSharedProject}
                            className={disabledMenuItemClass}
                          >
                            <CloudDownload className="h-4 w-4" />
                            {homeMenuState.isPullingSharedProject ? 'Pulling...' : 'Pull shared data'}
                          </button>
                          <button onClick={() => dispatchHomeAction('shared-backups')} className={menuItemClass}>
                            <ArchiveRestore className="h-4 w-4" />
                            Shared backups
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('disconnect-shared-project')}
                            disabled={!!homeMenuState.isDisconnectingSharedProject}
                            className={disabledMenuItemClass}
                          >
                            <LogOut className="h-4 w-4" />
                            {homeMenuState.isDisconnectingSharedProject ? 'Stopping...' : 'Stop sharing'}
                          </button>
                          <button
                            onClick={() => dispatchHomeAction('transfer-shared-project')}
                            disabled={!!homeMenuState.isTransferringSharedProject}
                            className={disabledMenuItemClass}
                          >
                            <Users className="h-4 w-4" />
                            {homeMenuState.isTransferringSharedProject ? 'Transferring...' : 'Transfer ownership'}
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
                    {isSignedIn && collaborationAuth.canUseCollaboration && (
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
                    {isSignedIn && collaborationAuth.canUseCollaboration && (
                      <button onClick={() => dispatchHomeAction('collaboration-health')} className={menuItemClass}>
                        <Activity className="h-4 w-4" />
                        Collaboration health
                      </button>
                    )}
                    {!isSignedIn ? (
                      <button onClick={() => dispatchHomeAction('auth')} className={menuItemClass}>
                        <LogIn className="h-4 w-4" />
                        Sign in
                      </button>
                    ) : (
                      <button onClick={() => dispatchHomeAction('auth')} className={menuItemClass}>
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
        {!showAuth && !isProjectOverview && projectTitle && !showHomeMenu && (
          <div className="max-w-[65vw] flex items-center justify-end gap-2">
            {renderSyncButton()}
            <div className="truncate rounded-full border border-black/5 bg-white/60 px-3 py-1.5 text-right text-sm font-semibold tracking-[-0.01em] text-gray-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-200">
              {projectTitle}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
