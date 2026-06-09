'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import { getProject } from '@/lib/db';
import { MoreVertical, LogOut, LogIn, ArrowDownAZ, Clock3, BarChart3, PlusSquare, FolderPlus, Trash2, Pencil, FileDown, RefreshCw } from 'lucide-react';

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
  showOnlyIssues?: boolean;
  selectionMode?: boolean;
};

export default function PersistentTopBar() {
  const pathname = usePathname();
  const { isReady, isSignedIn } = useMicrosoftAuth();
  const { retryInSeconds, status } = useSyncStatus();
  const { homeShowOnlyIssues, projectShowOnlyIssues, quickSort } = useAppSettings();
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
    showOnlyIssues: false,
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

  const indicatorClasses = {
    idle: 'opacity-0 bg-green-500 dark:bg-green-400',
    syncing: 'opacity-100 bg-green-500 dark:bg-green-400 animate-pulse',
    pending: 'opacity-100 bg-gray-500 dark:bg-gray-400',
    'needs-auth': 'opacity-100 bg-gray-500 dark:bg-gray-400',
    error: 'opacity-100 bg-gray-500 dark:bg-gray-400',
  } as const;

  const indicatorLabel = {
    idle: 'No sync activity',
    syncing: 'Syncing now',
    pending: 'Sync pending',
    'needs-auth': 'Sign in required to finish syncing',
    error: 'Sync needs attention',
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
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !menuRef.current?.contains(target)) {
        setShowHomeMenu(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
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

  function dispatchHomeAction(action: string, sort?: SortOption) {
    window.dispatchEvent(new CustomEvent('punchlist-home-menu-action', { detail: { action, sort } }));
    setShowHomeMenu(false);
  }

  const currentShowOnlyIssues =
    homeMenuState.context === 'project' ? (homeMenuState.showOnlyIssues ?? projectShowOnlyIssues) : (homeMenuState.showOnlyIssues ?? homeShowOnlyIssues);

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
        {showTopMenu && isReady && !homeMenuState.showTrash && (
          <div ref={menuRef} className="relative flex items-center gap-2">
            <span
              aria-label={indicatorLabel[status]}
              className={`sync-indicator h-2.5 w-2.5 rounded-full ${indicatorClasses[status]}`}
            />
            <button
              onClick={() => setShowHomeMenu((current) => !current)}
              className="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-500 transition hover:bg-white hover:text-gray-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
              aria-label="Open app menu"
            >
              <MoreVertical className="h-5 w-5" />
            </button>
            {showHomeMenu && (
              <div className="menu-surface absolute right-0 top-[calc(100%+0.65rem)] z-40 min-w-[15rem] overflow-hidden rounded-[1.6rem] p-2">
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
                            onClick={() => dispatchHomeAction(`quick-sort:${option.value}`)}
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
                    <div className="space-y-2 rounded-[1.25rem] bg-black/[0.03] p-2.5 dark:bg-white/[0.03]">
                      <button
                        onClick={() => dispatchHomeAction('toggle-issues-only')}
                        className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm text-gray-700 hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.04]"
                      >
                        <span>Show only issues</span>
                        <span
                          className={`relative inline-flex h-6 w-10 items-center rounded-full transition ${
                            currentShowOnlyIssues ? 'bg-[var(--accent)]' : 'bg-gray-300 dark:bg-zinc-700'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 rounded-full bg-white transition ${
                              currentShowOnlyIssues ? 'translate-x-5' : 'translate-x-1'
                            }`}
                          />
                        </span>
                      </button>
                    </div>
                  </div>
                  <div className="mx-1 my-1 border-t border-gray-200/80 dark:border-zinc-700" />
                  <div className="px-1 py-1">
                    <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-500 dark:text-gray-400">
                      Sort
                    </div>
                    <div className="space-y-2 rounded-[1.25rem] bg-black/[0.03] p-2.5 dark:bg-white/[0.03]">
                      {sortOptions.map(({ value, label, icon: Icon }) => (
                        <button
                          key={value}
                          onClick={() => dispatchHomeAction('sort', value)}
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
                <button
                  onClick={() => dispatchHomeAction('sync-now')}
                  className="flex w-full items-center gap-3 rounded-[1.1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                >
                  <RefreshCw className={`h-4 w-4 ${status === 'syncing' ? 'animate-spin text-[var(--accent)]' : ''}`} />
                  {retryInSeconds > 0 ? `Sync in ${retryInSeconds}s` : 'Sync now'}
                </button>
                {(homeMenuState.context === 'project' || homeMenuState.isSingleProject) && (
                  <button
                    onClick={() => dispatchHomeAction('edit-project')}
                    className="flex w-full items-center gap-3 rounded-[1.1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                  >
                    <Pencil className="h-4 w-4" />
                    Edit project
                  </button>
                )}
                {(homeMenuState.context === 'project' || homeMenuState.isSingleProject) && (
                  <button
                    onClick={() => dispatchHomeAction('toggle-selection')}
                    className="flex w-full items-center gap-3 rounded-[1.1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                  >
                    <MoreVertical className="h-4 w-4" />
                    {homeMenuState.selectionMode ? 'Cancel selection' : 'Select'}
                  </button>
                )}
                {homeMenuState.isSingleProject && (
                  <button
                    onClick={() => dispatchHomeAction('export-project')}
                    className="flex w-full items-center gap-3 rounded-[1.1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                  >
                    <FileDown className="h-4 w-4" />
                    Export project
                  </button>
                )}
                {homeMenuState.context !== 'project' && (
                  <button
                    onClick={() => dispatchHomeAction('new-project')}
                    className="flex w-full items-center gap-3 rounded-[1.1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                  >
                    <PlusSquare className="h-4 w-4" />
                    Add project
                  </button>
                )}
                {homeMenuState.canAddArea && !homeMenuState.isSingleProject && (
                  <button
                    onClick={() => dispatchHomeAction('new-area')}
                    className="flex w-full items-center gap-3 rounded-[1.1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                  >
                    <FolderPlus className="h-4 w-4" />
                    Add area
                  </button>
                )}
                <button
                  onClick={() => dispatchHomeAction('toggle-trash')}
                  className="flex w-full items-center gap-3 rounded-[1.1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                >
                  <Trash2 className="h-4 w-4" />
                  {homeMenuState.showTrash ? 'Hide trash' : 'Trash'}
                </button>
                {!isSignedIn ? (
                  <button
                    onClick={() => {
                      dispatchHomeAction('auth');
                    }}
                    className="flex w-full items-center gap-3 rounded-[1.1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                  >
                    <LogIn className="h-4 w-4" />
                    Sign in
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      dispatchHomeAction('auth');
                    }}
                    className="flex w-full items-center gap-3 rounded-[1.1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {!showAuth && !isProjectOverview && projectTitle && (
          <div className="max-w-[65vw] flex items-center justify-end gap-2">
            <span
              aria-label={indicatorLabel[status]}
              className={`sync-indicator h-2.5 w-2.5 rounded-full shrink-0 ${indicatorClasses[status]}`}
            />
            <div className="truncate rounded-full border border-black/5 bg-white/60 px-3 py-1.5 text-right text-sm font-semibold tracking-[-0.01em] text-gray-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-200">
              {projectTitle}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
