'use client';

import { memo, useState, useEffect, useMemo, useRef, useCallback, type TouchEvent } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Area, Project, checkpointHasIssue, getReviewMetrics } from '@/types';
import { getProject, saveProject, createArea } from '@/lib/db';
import {
  formatMicrosoftManualRetryMessage,
  formatMicrosoftRetryMessage,
  getMicrosoftErrorMessage,
  getMicrosoftRetryDelayMs,
  isMicrosoftTransientSyncError,
} from '@/lib/microsoftErrors';
import AreaEditorModal from '@/components/AreaEditorModal';
import ProjectEditModal from '@/components/ProjectEditModal';
import {
  buildAreaName,
  buildFacadeLevelOptions,
  compareAreaNames,
  getAreaCreationForms,
  getDefaultAreaFormValue,
  type AreaTypeKey,
} from '@/lib/areas';
import { applyTemplateToArea } from '@/lib/template';
import { pushProjectsToOneDrive, syncProjectsWithOneDrive } from '@/lib/oneDriveSync';
import {
  clearPendingProjectSync,
  clearPendingSyncBackoff,
  clearPendingSyncState,
  getPendingSyncWaitMs,
  loadPendingSyncState,
  queuePendingSync,
  recordPendingSyncRetry,
} from '@/lib/pendingSync';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import MetadataLine from '@/components/MetadataLine';
import Link from 'next/link';
import {
  ArrowLeft,
  Building2,
  ChevronRight,
  Trash2,
  RotateCcw,
  Plus,
} from 'lucide-react';

type SortOption = 'alphabetical' | 'issues' | 'progress';

const SORT_STORAGE_KEY = 'punchlist-areas-sort';
const RECENT_AREA_TYPES_STORAGE_KEY = 'punchlist-recent-area-types';
type AreaMetrics = {
  stats: { total: number; ok: number; issues: number };
  pending: number;
  progress: number;
  okPercent: number;
  issuePercent: number;
  photoCount: number;
  commentCount: number;
};

type AreaCardProps = {
  projectId: string;
  area: Project['areas'][number];
  metric?: AreaMetrics;
  deleteMode: boolean;
  isSelected: boolean;
  onToggleSelection: (areaId: string) => void;
};

const AreaCard = memo(function AreaCard({
  projectId,
  area,
  metric,
  deleteMode,
  isSelected,
  onToggleSelection,
}: AreaCardProps) {
  const areaStats = metric?.stats ?? { total: 0, ok: 0, issues: 0 };
  const progress = metric?.progress ?? 0;
  const commentCount = metric?.commentCount ?? 0;
  const photoCount = metric?.photoCount ?? 0;

  return (
    <div
      onContextMenu={(event) => {
        if (!deleteMode) {
          event.preventDefault();
        }
      }}
      onClick={() => {
        if (deleteMode) {
          onToggleSelection(area.id);
        }
      }}
      className={`card-surface block rounded-[1.65rem] p-4 transition-all ${
        isSelected
          ? 'bg-gray-100 border-gray-400 dark:bg-white/[0.08] dark:border-gray-500'
          : 'hover:-translate-y-px hover:border-black/10 dark:hover:bg-white/[0.07] dark:hover:border-white/[0.08]'
      } ${deleteMode ? 'cursor-pointer' : ''}`}
    >
      <div className="flex items-start gap-3">
        <Link
          href={deleteMode ? '#' : `/project/${projectId}/area/${area.id}`}
          onClick={(event) => {
            if (deleteMode) event.preventDefault();
          }}
          onContextMenu={(event) => {
            if (!deleteMode) {
              event.preventDefault();
            }
          }}
          className="flex-1 min-w-0"
        >
          <div className="min-w-0">
            <div className="min-w-0 flex items-center gap-2">
              <h3 className="truncate text-[1.05rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{area.name}</h3>
            </div>
            <MetadataLine className="mt-2" issues={areaStats.issues} notes={commentCount} photos={photoCount} />
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-white/[0.12]">
              <div
                className={`${areaStats.issues > 0 ? 'accent-bg' : 'bg-gray-900 dark:bg-white'} h-full rounded-full transition-all`}
                style={{ width: `${Math.max(progress, 4)}%` }}
              />
            </div>
          </div>
        </Link>
        <Link
          href={deleteMode ? '#' : `/project/${projectId}/area/${area.id}`}
          onClick={(event) => {
            if (deleteMode) event.preventDefault();
          }}
          onContextMenu={(event) => {
            if (!deleteMode) {
              event.preventDefault();
            }
          }}
          className="mt-1 flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-500 transition hover:bg-white hover:text-gray-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
          aria-label={`Open ${area.name}`}
        >
          <ChevronRight className="w-5 h-5 text-gray-400" />
        </Link>
      </div>
    </div>
  );
});

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddArea, setShowAddArea] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedAreaIds, setSelectedAreaIds] = useState<Set<string>>(new Set());
  const [newAreaForm, setNewAreaForm] = useState(getDefaultAreaFormValue());
  const [recentAreaTypeKeys, setRecentAreaTypeKeys] = useState<AreaTypeKey[]>([]);
  const [sortOption, setSortOption] = useState<SortOption>('issues');
  const [showTrash, setShowTrash] = useState(false);
  const [actionSheet, setActionSheet] = useState<'delete' | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundSyncInFlightRef = useRef(false);
  const backgroundSyncQueuedRef = useRef(false);
  const dirtyProjectIdsRef = useRef<Set<string>>(new Set());
  const fullSyncNeededRef = useRef(false);
  const forceSyncNowRef = useRef(false);
  const lastForegroundSyncRef = useRef(0);
  const pullStartYRef = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const pullArmedRef = useRef(false);
  const listRef = useRef<HTMLElement | null>(null);
  const { accessToken, ensureAccessToken } = useMicrosoftAuth();
  const { setStatus: setSyncStatus } = useSyncStatus();
  const { projectShowOnlyIssues, setProjectShowOnlyIssues, quickSort, markSyncedNow } = useAppSettings();

  useEffect(() => {
    // Load saved sort preference
    const savedSort = localStorage.getItem(SORT_STORAGE_KEY);
    if (savedSort === 'alphabetical' || savedSort === 'issues' || savedSort === 'progress') {
      setSortOption(savedSort);
    } else if (savedSort === 'name') {
      setSortOption('alphabetical');
    } else if (savedSort === 'recent') {
      setSortOption('issues');
    } else {
      setSortOption(quickSort);
    }
  }, [quickSort]);

  useEffect(() => {
    if (!id) {
      router.push('/');
      return;
    }
    const savedRecentAreaTypes = localStorage.getItem(RECENT_AREA_TYPES_STORAGE_KEY);
    if (savedRecentAreaTypes) {
      try {
        setRecentAreaTypeKeys(JSON.parse(savedRecentAreaTypes) as AreaTypeKey[]);
      } catch (error) {
        console.error('Failed to parse recent area types:', error);
      }
    }
    loadProject();
  }, [id]);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
      }
      backgroundSyncInFlightRef.current = false;
      backgroundSyncQueuedRef.current = false;
      fullSyncNeededRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    scheduleSync(undefined, { fullSync: true, delayMs: 0, force: true });
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;

    function handleForegroundSync() {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastForegroundSyncRef.current < 5_000) return;
      lastForegroundSyncRef.current = now;
      scheduleSync(undefined, { fullSync: true, delayMs: 0, force: true });
    }

    window.addEventListener('focus', handleForegroundSync);
    document.addEventListener('visibilitychange', handleForegroundSync);
    return () => {
      window.removeEventListener('focus', handleForegroundSync);
      document.removeEventListener('visibilitychange', handleForegroundSync);
    };
  }, [accessToken]);

  function handleSortChange(option: SortOption) {
    setSortOption(option);
    localStorage.setItem(SORT_STORAGE_KEY, option);
  }

  async function handleEditProject(updates: Partial<Project>) {
    if (!editingProject) return;
    Object.assign(editingProject, updates);
    await saveProject(editingProject);
    scheduleSync(editingProject.id);
    setProject({ ...editingProject, areas: [...editingProject.areas] });
    setEditingProject(null);
  }

  async function loadProject() {
    if (!id) return;
    try {
      const data = await getProject(id);
      if (data) {
        if (data.deletedAt) {
          router.push('/');
          return;
        }
        setProject(data);
      } else {
        router.push('/');
      }
    } catch (error) {
      console.error('Failed to load project:', error);
      router.push('/');
    } finally {
      setLoading(false);
    }
  }

  const activeAreas = useMemo(
    () => (project ? project.areas.filter((area) => !area.deletedAt) : []),
    [project]
  );

  const trashedAreas = useMemo(
    () =>
      project
        ? [...project.areas.filter((area) => area.deletedAt)].sort(
            (a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0)
          )
        : [],
    [project]
  );

  const areaMetrics = useMemo(() => {
    const metrics = new Map<string, AreaMetrics>();
    if (!project) return metrics;

    for (const area of activeAreas) {
      let total = 0;
      let ok = 0;
      let issues = 0;
      let photoCount = 0;
      let commentCount = 0;
      for (const location of area.locations) {
        for (const item of location.items) {
          for (const checkpoint of item.checkpoints) {
            total += 1;
            if (checkpoint.status === 'ok') ok += 1;
            else if (checkpointHasIssue(checkpoint)) issues += 1;
            photoCount += checkpoint.photos.length;
            if (checkpoint.comments.trim()) commentCount += 1;
          }
        }
      }
      const stats = { total, ok, issues };
      const reviewMetrics = getReviewMetrics(stats.total, stats.ok, stats.issues);
      metrics.set(area.id, {
        stats,
        pending: reviewMetrics.pending,
        progress: reviewMetrics.reviewedPercent,
        okPercent: reviewMetrics.okPercent,
        issuePercent: reviewMetrics.issuePercent,
        photoCount,
        commentCount,
      });
    }

    return metrics;
  }, [project, activeAreas]);

  const sortedAreas = useMemo(() => {
    const visibleAreas = projectShowOnlyIssues
      ? activeAreas.filter((area) => (areaMetrics.get(area.id)?.stats.issues ?? 0) > 0)
      : activeAreas;

    return [...visibleAreas].sort((a, b) => {
      if (sortOption === 'alphabetical') {
        return compareAreaNames(a, b);
      }
      if (sortOption === 'issues') {
        const issuesA = areaMetrics.get(a.id)?.stats.issues ?? 0;
        const issuesB = areaMetrics.get(b.id)?.stats.issues ?? 0;
        if (issuesB !== issuesA) return issuesB - issuesA;
        return compareAreaNames(a, b);
      }
      const progressA = areaMetrics.get(a.id)?.progress ?? 0;
      const progressB = areaMetrics.get(b.id)?.progress ?? 0;
      return progressB - progressA;
    });
  }, [activeAreas, sortOption, areaMetrics, projectShowOnlyIssues]);

  async function handleAddArea() {
    if (!project) return;

    const areaForms = getAreaCreationForms(newAreaForm, buildFacadeLevelOptions(project));
    if (areaForms.length === 0) return;

    const createdAreas = areaForms.map(
      (areaForm, index) => {
        const areaName = buildAreaName(areaForm);
        if (!areaName) return null;

        const area = createArea(project.id, areaName, project.areas.length + index, {
          areaTypeKey: areaForm.areaTypeKey,
          unitType: areaForm.unitType,
          customAreaName: areaForm.customAreaName,
          areaNumber: areaForm.areaNumber,
          facadeLevel: areaForm.facadeLevel,
        });
        area.areaTypeKey = areaForm.areaTypeKey;
        area.unitType = areaForm.unitType || undefined;
        area.customAreaName = areaForm.customAreaName.trim() || undefined;
        area.areaNumber = areaForm.areaNumber.trim() || undefined;
        area.facadeLevel = areaForm.facadeLevel.trim() || undefined;
        applyTemplateToArea(area);
        return area;
      }
    ).filter((area): area is Area => area !== null);
    if (createdAreas.length === 0) return;

    project.areas.push(...createdAreas);
    await saveProject(project);
    scheduleSync(project.id);
    const nextRecentAreaTypeKeys = [
      newAreaForm.areaTypeKey,
      ...recentAreaTypeKeys.filter((key) => key !== newAreaForm.areaTypeKey),
    ].slice(0, 8);
    setRecentAreaTypeKeys(nextRecentAreaTypeKeys);
    localStorage.setItem(RECENT_AREA_TYPES_STORAGE_KEY, JSON.stringify(nextRecentAreaTypeKeys));
    setNewAreaForm(getDefaultAreaFormValue());
    setShowAddArea(false);
    setProject({ ...project, areas: [...project.areas] });
  }

  const toggleAreaSelection = useCallback((areaId: string) => {
    setSelectedAreaIds((prev) => {
      const next = new Set(prev);
      if (next.has(areaId)) next.delete(areaId);
      else next.add(areaId);
      return next;
    });
  }, []);

  async function handleDeleteSelectedAreas() {
    if (!project) return;
    if (selectedAreaIds.size === 0) {
      setDeleteMode(false);
      return;
    }
    const now = new Date();
    project.areas.forEach((area) => {
      if (selectedAreaIds.has(area.id)) {
        area.deletedAt = now;
      }
    });
    await saveProject(project);
    scheduleSync(project.id);
    setSelectedAreaIds(new Set());
    setDeleteMode(false);
    setActionSheet(null);
    setProject({ ...project, areas: [...project.areas] });
  }

  async function handleRestoreArea(areaId: string) {
    if (!project) return;
    const area = project.areas.find((entry) => entry.id === areaId);
    if (!area) return;
    delete area.deletedAt;
    await saveProject(project);
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
  }

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSyncStatus('syncing');
    try {
      const token = await ensureAccessToken({ interactive: true });
      if (!token) {
        setSyncError('Please sign in to sync.');
        setSyncStatus('needs-auth');
        return;
      }
      const result = await syncProjectsWithOneDrive(token);
      if (result.conflicts.length > 0) {
        setSyncError('Saved locally. OneDrive changed on another device; sync will retry.');
        scheduleSync(undefined, { fullSync: true, delayMs: 10_000 });
        setSyncStatus('pending');
        return;
      }
      clearPendingSyncState();
      setSyncError(null);
      setSyncStatus('idle');
      markSyncedNow();
      await loadProject();
    } catch (error) {
      console.error('Sync failed:', error);
      const retryDelayMs = getMicrosoftRetryDelayMs(error);
      if (retryDelayMs) {
        const backoffDelayMs = recordPendingSyncRetry(retryDelayMs);
        setSyncError(formatMicrosoftRetryMessage(backoffDelayMs));
        scheduleSync(undefined, { fullSync: true, delayMs: backoffDelayMs });
        setSyncStatus('pending');
        return;
      }
      const message = getMicrosoftErrorMessage(error, 'Sync failed.');
      if (message.startsWith('Saved locally.')) {
        const backoffDelayMs = recordPendingSyncRetry(60_000);
        setSyncError(formatMicrosoftRetryMessage(backoffDelayMs));
        scheduleSync(undefined, { fullSync: true, delayMs: backoffDelayMs });
        setSyncStatus('pending');
        return;
      }
      setSyncError(message);
      setSyncStatus('error');
    } finally {
      setSyncing(false);
    }
  }

  async function runBackgroundSync() {
    const pendingSyncState = loadPendingSyncState();
    pendingSyncState.projectIds.forEach((projectId) => dirtyProjectIdsRef.current.add(projectId));
    if (pendingSyncState.fullSyncNeeded) {
      fullSyncNeededRef.current = true;
    }
    const forceSyncNow = forceSyncNowRef.current;
    forceSyncNowRef.current = false;
    const waitMs = getPendingSyncWaitMs();
    if (waitMs > 0 && !forceSyncNow) {
      scheduleSync(undefined, { fullSync: pendingSyncState.fullSyncNeeded, delayMs: waitMs });
      return;
    }

    if (backgroundSyncInFlightRef.current) {
      backgroundSyncQueuedRef.current = true;
      return;
    }
    if (dirtyProjectIdsRef.current.size === 0 && !fullSyncNeededRef.current) return;

    backgroundSyncInFlightRef.current = true;
    setSyncStatus('syncing');
    const dirtyProjectIds = [...dirtyProjectIdsRef.current];
    const shouldRunFullSync = fullSyncNeededRef.current;
    dirtyProjectIdsRef.current.clear();
    fullSyncNeededRef.current = false;
    try {
      const token = await ensureAccessToken();
      if (!token) {
        dirtyProjectIds.forEach((projectId) => dirtyProjectIdsRef.current.add(projectId));
        if (shouldRunFullSync) {
          fullSyncNeededRef.current = true;
        }
        setSyncStatus('needs-auth');
        return;
      }
      if (shouldRunFullSync) {
        const result = await syncProjectsWithOneDrive(token);
        if (result.conflicts.length > 0) {
          setSyncError('Saved locally. OneDrive changed on another device; sync will retry.');
          scheduleSync(undefined, { fullSync: true, delayMs: 10_000 });
          backgroundSyncQueuedRef.current = false;
          setSyncStatus('pending');
          return;
        }
        clearPendingSyncState();
        await loadProject();
        setSyncError(null);
        clearPendingSyncBackoff();
        setSyncStatus('idle');
        markSyncedNow();
        return;
      }
      const pushResult = await pushProjectsToOneDrive(token, dirtyProjectIds);
      if (pushResult.conflicts.length > 0) {
        const result = await syncProjectsWithOneDrive(token);
        if (result.conflicts.length > 0) {
          setSyncError('Saved locally. OneDrive changed on another device; sync will retry.');
          scheduleSync(undefined, { fullSync: true, delayMs: 10_000 });
          backgroundSyncQueuedRef.current = false;
          setSyncStatus('pending');
          return;
        }
        clearPendingSyncState();
        await loadProject();
        setSyncError(null);
        clearPendingSyncBackoff();
      } else {
        clearPendingProjectSync(dirtyProjectIds);
        setSyncError(null);
        clearPendingSyncBackoff();
      }
      setSyncStatus('idle');
      markSyncedNow();
    } catch (error) {
      dirtyProjectIds.forEach((projectId) => dirtyProjectIdsRef.current.add(projectId));
      if (shouldRunFullSync) {
        fullSyncNeededRef.current = true;
      }
      const retryDelayMs = getMicrosoftRetryDelayMs(error);
      if (retryDelayMs) {
        recordPendingSyncRetry(retryDelayMs);
        setSyncError(formatMicrosoftManualRetryMessage());
        backgroundSyncQueuedRef.current = false;
        setSyncStatus('pending');
        return;
      }
      const message = getMicrosoftErrorMessage(error, 'Background sync failed.');
      if (message.startsWith('Saved locally.') || isMicrosoftTransientSyncError(error)) {
        recordPendingSyncRetry(60_000);
        setSyncError(formatMicrosoftManualRetryMessage());
        backgroundSyncQueuedRef.current = false;
        setSyncStatus('pending');
        return;
      }
      setSyncError(message);
      setSyncStatus('error');
      console.error('Background sync failed:', error);
    } finally {
      backgroundSyncInFlightRef.current = false;
      if (backgroundSyncQueuedRef.current) {
        backgroundSyncQueuedRef.current = false;
        scheduleSync();
      }
    }
  }

  function scheduleSync(projectId?: string, options?: { fullSync?: boolean; delayMs?: number; force?: boolean }) {
    if (projectId) {
      dirtyProjectIdsRef.current.add(projectId);
    }
    if (options?.fullSync) {
      fullSyncNeededRef.current = true;
    }
    if (options?.force) {
      forceSyncNowRef.current = true;
    }
    queuePendingSync(projectId, options);
    setSyncStatus('pending');
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = setTimeout(() => {
      void runBackgroundSync();
    }, options?.delayMs ?? 800);
  }

  function cancelSelectionMode() {
    setDeleteMode(false);
    setActionSheet(null);
    setSelectedAreaIds(new Set());
  }

  useEffect(() => {
    function handleTopMenuAction(event: Event) {
      const customEvent = event as CustomEvent<{ action: string; sort?: SortOption }>;
      const detail = customEvent.detail;
      if (!detail || !project) return;

      if (detail.action === 'sort' && detail.sort) {
        handleSortChange(detail.sort);
        return;
      }

      if (detail.action === 'sync-now') {
        void handleSync();
        return;
      }

      if (detail.action === 'new-area') {
        setShowAddArea(true);
        return;
      }

      if (detail.action === 'edit-project') {
        setEditingProject(project);
        return;
      }

      if (detail.action === 'toggle-issues-only') {
        setProjectShowOnlyIssues(!projectShowOnlyIssues);
        return;
      }

      if (detail.action === 'toggle-selection') {
        if (deleteMode) {
          cancelSelectionMode();
        } else {
          setDeleteMode(true);
          setSelectedAreaIds(new Set());
        }
        return;
      }

      if (detail.action === 'toggle-trash') {
        setShowTrash((current) => !current);
        setDeleteMode(false);
        setSelectedAreaIds(new Set());
        setActionSheet(null);
        return;
      }

      if (detail.action === 'clear-trash') {
        setShowTrash(false);
        setDeleteMode(false);
        setSelectedAreaIds(new Set());
        setActionSheet(null);
      }
    }

    window.addEventListener('punchlist-home-menu-action', handleTopMenuAction as EventListener);
    return () => {
      window.removeEventListener('punchlist-home-menu-action', handleTopMenuAction as EventListener);
    };
  }, [project, deleteMode, projectShowOnlyIssues, setProjectShowOnlyIssues]);

  useEffect(() => {
    if (!project) return;
    window.dispatchEvent(
      new CustomEvent('punchlist-home-menu-state', {
        detail: {
          context: 'project',
          sortOption,
          showTrash,
          canAddArea: true,
          isSingleProject: true,
          singleProjectName: project.projectName,
          showOnlyIssues: projectShowOnlyIssues,
          selectionMode: deleteMode,
        },
      })
    );
  }, [project, sortOption, showTrash, deleteMode, projectShowOnlyIssues]);

  function isListAtTop() {
    return (listRef.current?.scrollTop ?? 0) <= 8;
  }

  function handlePullStart(e: TouchEvent<HTMLElement>) {
    const atTop = isListAtTop();
    if (!atTop || syncing) {
      pullStartYRef.current = null;
      pullDistanceRef.current = 0;
      return;
    }
    pullStartYRef.current = e.touches[0]?.clientY ?? null;
    pullDistanceRef.current = 0;
  }

  function handlePullMove(e: TouchEvent<HTMLElement>) {
    const atTop = isListAtTop();
    if (pullStartYRef.current === null || !atTop || syncing) return;
    const currentY = e.touches[0]?.clientY ?? pullStartYRef.current;
    const delta = currentY - pullStartYRef.current;
    pullDistanceRef.current = delta;
    const armed = delta >= 45;
    if (armed !== pullArmedRef.current) {
      pullArmedRef.current = armed;
    }
  }

  function handlePullEnd() {
    pullStartYRef.current = null;
    if (pullDistanceRef.current >= 45 && !syncing) {
      void handleSync();
    }
    pullDistanceRef.current = 0;
    pullArmedRef.current = false;
  }

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--background)]">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-black/10 border-t-[var(--accent)] dark:border-white/10 dark:border-t-[var(--accent)]" />
      </div>
    );
  }

  if (!project) {
    return null;
  }

  return (
    <div className="app-page h-[calc(100dvh-env(safe-area-inset-top)-3.5rem)] flex flex-col overflow-hidden">
      <header className="header-stable shrink-0 border-b z-20">
        <div className="mx-auto flex min-h-[4.9rem] w-full max-w-6xl items-center px-4 py-3 sm:px-5">
          <div className="flex w-full items-center gap-3">
            <Link href="/" className="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-600 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="section-eyebrow">Project</div>
              <h1 className="mt-1 truncate text-[1.2rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
                {project.projectName}
              </h1>
              <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
                {project.address || 'Project dashboard'}
              </p>
            </div>
          </div>
        </div>
        {deleteMode && (
          <div className="header-row mx-auto w-full max-w-6xl sm:px-5">
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 min-w-0">
              <button
                onClick={cancelSelectionMode}
                className="flex h-10 items-center justify-center rounded-full px-4 text-sm font-medium text-gray-600 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.06]"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (selectedAreaIds.size === 0) return;
                  setActionSheet('delete');
                }}
                disabled={selectedAreaIds.size === 0}
                className="accent-text accent-tint hover:accent-tint-strong flex h-10 w-10 items-center justify-center rounded-full transition disabled:opacity-40"
                aria-label="Delete selected areas"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </header>

      {syncError && (
        <div className="shrink-0 border-b border-gray-200/80 bg-white/70 px-4 py-2 text-sm text-gray-700 dark:border-zinc-700 dark:bg-white/[0.03] dark:text-gray-200">
          {syncError}
        </div>
      )}
      {/* Areas List */}
      <main
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-scroll overscroll-y-contain touch-pan-y px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+6.5rem)] sm:px-5"
        onTouchStartCapture={handlePullStart}
        onTouchMoveCapture={handlePullMove}
        onTouchEndCapture={handlePullEnd}
        onTouchCancelCapture={handlePullEnd}
      >
        {!showTrash && activeAreas.length === 0 ? (
          <div className="mx-auto flex min-h-[calc(100%+1px)] w-full max-w-6xl flex-col">
            <div className="flex flex-1 items-center justify-center py-12">
              <div className="empty-state-card w-full max-w-sm rounded-[1.9rem] p-8 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100 text-gray-500 dark:bg-zinc-900 dark:text-gray-300">
                  <Building2 className="h-7 w-7" />
                </div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">No areas yet</h2>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  Add the first area to start walking the punch list.
                </p>
              </div>
            </div>
            <div className="mt-auto pt-2" />
          </div>
        ) : showTrash ? (
          trashedAreas.length === 0 ? (
            <div className="empty-state-card mx-auto max-w-md rounded-[2rem] p-10 text-center">
              <Trash2 className="mx-auto mb-4 h-14 w-14 text-gray-300 dark:text-gray-600" />
              <h2 className="mb-2 text-lg font-medium text-gray-900 dark:text-white">Trash Is Empty</h2>
              <p className="text-gray-500 dark:text-gray-400">Deleted areas will show up here.</p>
            </div>
          ) : (
            <div className="list-stack mx-auto w-full max-w-6xl">
              {trashedAreas.map((area) => {
                const deletedAt = area.deletedAt ?? new Date();
                return (
                  <div
                    key={area.id}
                    className="card-surface-subtle rounded-[1.5rem] p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-900 dark:text-white truncate">{area.name}</div>
                        <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                          Deleted {deletedAt.toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        onClick={() => void handleRestoreArea(area.id)}
                        className="segmented-chip shrink-0 px-3 py-2 text-sm"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Restore
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div className="list-stack mx-auto min-h-[calc(100%+1px)] w-full max-w-6xl">
            {sortedAreas.map((area) => {
              const metric = areaMetrics.get(area.id);
              const isSelected = selectedAreaIds.has(area.id);
              return (
                  <AreaCard
                    key={area.id}
                    projectId={project.id}
                    area={area}
                    metric={metric}
                    deleteMode={deleteMode}
                    isSelected={isSelected}
                    onToggleSelection={toggleAreaSelection}
                  />
                );
              })}
            <div className="mt-auto pt-2" />
          </div>
        )}
      </main>

      {!showTrash && !deleteMode && (
        <div className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+1.25rem)] left-1/2 z-20 -translate-x-1/2">
          <button
            onClick={() => setShowAddArea(true)}
            className="floating-action pointer-events-auto inline-flex h-14 w-[10.75rem] items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition hover:translate-y-[-1px]"
          >
            <Plus className="h-4 w-4" />
            Add Area
          </button>
        </div>
      )}

      <AreaEditorModal
        open={showAddArea}
        title="Add Area"
        value={newAreaForm}
        recentAreaTypeKeys={recentAreaTypeKeys}
        facadeLevelOptions={buildFacadeLevelOptions(project)}
        enableFacadeLevelBatch
        onChange={setNewAreaForm}
        onClose={() => {
          setShowAddArea(false);
          setNewAreaForm(getDefaultAreaFormValue());
        }}
        onSubmit={() => void handleAddArea()}
        submitLabel="Add"
      />

      {editingProject && (
        <ProjectEditModal
          project={editingProject}
          onSave={(updates) => void handleEditProject(updates)}
          onClose={() => setEditingProject(null)}
        />
      )}

      {actionSheet && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <div className="modal-panel overflow-hidden rounded-[1.8rem] p-2">
              <button
                onClick={() => void handleDeleteSelectedAreas()}
                className="accent-text w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
              >
                Delete
              </button>
              <button
                onClick={() => setActionSheet(null)}
                className="mt-1 w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
