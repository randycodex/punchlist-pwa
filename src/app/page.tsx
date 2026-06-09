'use client';

import { memo, useState, useEffect, useMemo, useRef, useCallback, type TouchEvent } from 'react';
import { Area, Project, checkpointHasIssue, getReviewMetrics } from '@/types';
import { getAllProjects, getProject, saveProject, deleteProject, createProject, createArea } from '@/lib/db';
import {
  syncProjectsWithOneDrive,
  SyncConflict,
  markProjectDeleted,
  unmarkProjectDeleted,
  hydrateProjectMediaFromOneDrive,
} from '@/lib/oneDriveSync';
import {
  clearPendingSyncState,
  queuePendingSync,
  recordPendingSyncRetry,
} from '@/lib/pendingSync';
import { generateMultiProjectPDF, downloadPDF, type PdfExportMode } from '@/lib/pdfExport';
import { uploadPdfToOneDrive, getNextOneDriveExportFilename } from '@/lib/oneDrive';
import {
  formatMicrosoftManualRetryMessage,
  getMicrosoftErrorMessage,
  getMicrosoftRetryDelayMs,
} from '@/lib/microsoftErrors';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import ProjectEditModal from '@/components/ProjectEditModal';
import AreaEditorModal from '@/components/AreaEditorModal';
import MetadataLine from '@/components/MetadataLine';
import { applyTemplateToArea } from '@/lib/template';
import {
  buildAreaName,
  buildFacadeLevelOptions,
  compareAreaNames,
  getAreaCreationForms,
  getDefaultAreaFormValue,
  type AreaTypeKey,
} from '@/lib/areas';
import Link from 'next/link';
import {
  ChevronRight,
  Trash2,
  FileDown,
  Loader2,
  MoreVertical,
  Pencil,
  RotateCcw,
  Plus,
} from 'lucide-react';

type SortOption = 'alphabetical' | 'issues' | 'progress';

const SORT_STORAGE_KEY = 'punchlist-projects-sort';
const RECENT_AREA_TYPES_STORAGE_KEY = 'punchlist-recent-area-types';
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LONG_PRESS_MS = 500;

function sanitizeOneDriveProjectFolderPart(value: string | undefined, fallback: string) {
  const cleaned = (value ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

function getOneDriveProjectFolderName(project: Pick<Project, 'projectName' | 'oneDriveFolderName'>) {
  return sanitizeOneDriveProjectFolderPart(
    project.oneDriveFolderName,
    sanitizeOneDriveProjectFolderPart(project.projectName, 'project')
  );
}

type ProjectMetrics = {
  stats: { total: number; ok: number; issues: number; areas: number };
  pending: number;
  progress: number;
  okPercent: number;
  issuePercent: number;
  photoCount: number;
  commentCount: number;
};

type AreaMetrics = {
  stats: { total: number; ok: number; issues: number; areas?: number };
  pending: number;
  progress: number;
  photoCount: number;
  commentCount: number;
};

type ProjectCardProps = {
  project: Project;
  metric?: ProjectMetrics;
  selectionMode: boolean;
  isSelected: boolean;
  menuOpen: boolean;
  onToggleSelection: (id: string) => void;
  onToggleMenu: (id: string) => void;
  onCloseMenu: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onLongPressSelect: (projectId: string) => void;
};

const ProjectCard = memo(function ProjectCard({
  project,
  metric,
  selectionMode,
  isSelected,
  menuOpen,
  onToggleSelection,
  onToggleMenu,
  onCloseMenu,
  onEditProject,
  onDeleteProject,
  onLongPressSelect,
}: ProjectCardProps) {
  const stats = metric?.stats ?? { total: 0, ok: 0, issues: 0, areas: project.areas.length };
  const progress = metric?.progress ?? 0;
  const commentCount = metric?.commentCount ?? 0;
  const photoCount = metric?.photoCount ?? 0;
  const hasContent = stats.total > 0 || stats.areas > 0;

  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearLongPress() {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }

  return (
    <div
      onContextMenu={(event) => {
        if (!selectionMode) {
          event.preventDefault();
        }
      }}
      onClick={() => {
        if (selectionMode) {
          onToggleSelection(project.id);
        }
      }}
      onPointerDown={() => {
        if (!selectionMode) {
          longPressRef.current = setTimeout(() => {
            onLongPressSelect(project.id);
            longPressRef.current = null;
          }, LONG_PRESS_MS);
        }
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      className={`card-surface select-none rounded-[1.7rem] p-4 transition-all [-webkit-touch-callout:none] ${
        isSelected
          ? '!border-gray-400 !bg-gray-100 dark:!border-gray-500 dark:!bg-white/[0.08]'
          : 'hover:-translate-y-px hover:border-black/10 dark:hover:border-white/[0.08] dark:hover:bg-white/[0.07]'
      } ${selectionMode ? 'cursor-pointer' : ''}`}
    >
      <div className="flex items-start gap-3">
        <Link
          href={selectionMode ? '#' : `/project/${project.id}`}
          onClick={(event) => {
            if (selectionMode) event.preventDefault();
          }}
          onContextMenu={(event) => {
            if (!selectionMode) {
              event.preventDefault();
            }
          }}
          className="flex-1 min-w-0 [-webkit-touch-callout:none]"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="truncate text-[1.05rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{project.projectName}</h3>
            </div>
            <p className={`mt-1 truncate text-sm ${project.address ? 'text-gray-500 dark:text-gray-300' : 'text-gray-400 dark:text-gray-400'}`}>
              {project.address || 'No address added'}
            </p>
            <MetadataLine className="mt-3" issues={stats.issues} notes={commentCount} photos={photoCount} />
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-white/[0.12]">
              <div
                className={`h-full rounded-full transition-all ${
                  stats.issues > 0 ? 'accent-bg' : 'bg-gray-900 dark:bg-white'
                } ${!hasContent ? 'opacity-40' : ''}`}
                style={{ width: `${hasContent ? Math.max(progress, 4) : 4}%` }}
              />
            </div>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={(event) => {
                event.stopPropagation();
                onToggleMenu(project.id);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className="rounded-[1rem] border border-black/5 bg-white/60 p-2 text-gray-400 transition hover:bg-white hover:text-gray-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
              aria-label={`Project actions for ${project.projectName}`}
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={onCloseMenu} />
                <div className="menu-surface absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-[1.3rem] p-1.5">
                  <button
                    onClick={() => {
                      onCloseMenu();
                      onEditProject(project);
                    }}
                    className="flex w-full items-center gap-2 rounded-[1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                  >
                    <Pencil className="w-4 h-4" />
                    Edit Project
                  </button>
                  <button
                    onClick={() => {
                      onCloseMenu();
                      onDeleteProject(project);
                    }}
                    className="accent-text flex w-full items-center gap-2 rounded-[1rem] px-4 py-3 text-left text-sm transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
          <Link
            href={selectionMode ? '#' : `/project/${project.id}`}
            onClick={(event) => {
              event.stopPropagation();
              if (selectionMode) event.preventDefault();
            }}
            onContextMenu={(event) => {
              if (!selectionMode) {
                event.preventDefault();
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className="mt-0.5 rounded-[1rem] border border-transparent p-1.5 text-gray-400 transition hover:border-black/5 hover:bg-white hover:text-gray-700 dark:text-gray-300 dark:hover:border-white/10 dark:hover:bg-white/[0.08] dark:hover:text-white [-webkit-touch-callout:none]"
            aria-label={`Open ${project.projectName}`}
          >
            <ChevronRight className="w-5 h-5" />
          </Link>
        </div>
      </div>
    </div>
  );
});

type HomeAreaCardProps = {
  projectId: string;
  area: Project['areas'][number];
  metric?: AreaMetrics;
  deleteMode: boolean;
  isSelected: boolean;
  onToggleSelection: (areaId: string) => void;
};

const HomeAreaCard = memo(function HomeAreaCard({
  projectId,
  area,
  metric,
  deleteMode,
  isSelected,
  onToggleSelection,
}: HomeAreaCardProps) {
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
      className={`card-surface-subtle select-none touch-manipulation [-webkit-touch-callout:none] rounded-[1.6rem] p-4 transition-all ${
        isSelected
          ? '!border-gray-400 !bg-gray-100 dark:!border-gray-500 dark:!bg-white/[0.08]'
          : 'hover:-translate-y-px hover:border-black/10 dark:hover:border-white/[0.08]'
      } ${deleteMode ? 'cursor-pointer' : ''}`}
      style={{ WebkitTapHighlightColor: 'transparent' }}
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
          className="flex-1 min-w-0 [-webkit-touch-callout:none]"
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="truncate text-[1.03rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{area.name}</h3>
              <span className="segmented-chip shrink-0 px-2.5 py-1 text-[11px]">{areaStats.total} items</span>
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
          onPointerDown={(event) => event.stopPropagation()}
          className="mt-0.5 rounded-[1rem] border border-transparent p-1.5 text-gray-400 transition hover:border-black/5 hover:bg-white hover:text-gray-700 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-gray-200 [-webkit-touch-callout:none]"
          style={{ WebkitTapHighlightColor: 'transparent' }}
          aria-label={`Open ${area.name}`}
        >
          <ChevronRight className="w-5 h-5" />
        </Link>
      </div>
    </div>
  );
});

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectAddress, setNewProjectAddress] = useState('');
  const [newProjectInspector, setNewProjectInspector] = useState('');
  const [newProjectGcName, setNewProjectGcName] = useState('');
  const [newProjectLevelStart, setNewProjectLevelStart] = useState('');
  const [newProjectLevelEnd, setNewProjectLevelEnd] = useState('');
  const [sortOption, setSortOption] = useState<SortOption>('issues');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);
  const [deleteMode, setDeleteMode] = useState(false);
  const [exportMode, setExportMode] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [exportingSelected, setExportingSelected] = useState(false);
  const [exportingSelectedToDrive, setExportingSelectedToDrive] = useState(false);
  const [actionSheet, setActionSheet] = useState<'delete' | 'export' | null>(null);
  const [exportType] = useState<PdfExportMode>('issues');
  const [showProjectMenuId, setShowProjectMenuId] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showAddArea, setShowAddArea] = useState(false);
  const [showAreaProjectPicker, setShowAreaProjectPicker] = useState(false);
  const [areaTargetProjectId, setAreaTargetProjectId] = useState<string | null>(null);
  const [selectedAreaIds, setSelectedAreaIds] = useState<Set<string>>(new Set());
  const [newAreaForm, setNewAreaForm] = useState(getDefaultAreaFormValue());
  const [recentAreaTypeKeys, setRecentAreaTypeKeys] = useState<AreaTypeKey[]>([]);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pullStartYRef = useRef<number | null>(null);
  const pullArmedRef = useRef(false);
  const listRef = useRef<HTMLElement | null>(null);
  const { signIn, signOut, isSignedIn, ensureAccessToken } = useMicrosoftAuth();
  const { setStatus: setSyncStatus } = useSyncStatus();
  const { quickSort, setQuickSort, markSyncedNow } = useAppSettings();
  const selectionMode = deleteMode || exportMode;

  useEffect(() => {
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
    const savedRecentAreaTypes = localStorage.getItem(RECENT_AREA_TYPES_STORAGE_KEY);
    if (savedRecentAreaTypes) {
      try {
        setRecentAreaTypeKeys(JSON.parse(savedRecentAreaTypes) as AreaTypeKey[]);
      } catch (error) {
        console.error('Failed to parse recent area types:', error);
      }
    }
    loadProjects();
  }, []);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
      }
    };
  }, []);

  function handleSortChange(option: SortOption) {
    setSortOption(option);
    localStorage.setItem(SORT_STORAGE_KEY, option);
  }

  async function loadProjects() {
    try {
      const data = await getAllProjects();
      const now = Date.now();
      const expiredProjects = data.filter(
        (project) =>
          project.deletedAt &&
          now - project.deletedAt.getTime() >= TRASH_RETENTION_MS
      );

      if (expiredProjects.length > 0) {
        for (const project of expiredProjects) {
          markProjectDeleted(project.id);
          await deleteProject(project.id);
        }
        scheduleSync(undefined, { fullSync: true });
      }

      const expiredIds = new Set(expiredProjects.map((project) => project.id));
      setProjects(data.filter((project) => !expiredIds.has(project.id)));
    } catch (error) {
      console.error('Failed to load projects:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSyncStatus('syncing');
    try {
      const token = await ensureAccessToken();
      if (!token) {
        setSyncError('Please sign in to sync.');
        setSyncStatus('needs-auth');
        return;
      }
      const result = await syncProjectsWithOneDrive(token);
      setSyncConflicts(result.conflicts);
      if (result.conflicts.length > 0) {
        queuePendingSync(undefined, { fullSync: true });
        setSyncError('Saved locally. OneDrive changed on another device. Tap Sync again to use the latest version.');
        setSyncStatus('pending');
        return;
      }
      clearPendingSyncState();
      setSyncError(null);
      setSyncStatus('idle');
      markSyncedNow();
      await loadProjects();
    } catch (error) {
      console.error('Sync failed:', error);
      const retryDelayMs = getMicrosoftRetryDelayMs(error);
      if (retryDelayMs) {
        recordPendingSyncRetry(retryDelayMs);
        queuePendingSync(undefined, { fullSync: true });
        setSyncError(formatMicrosoftManualRetryMessage());
        setSyncStatus('pending');
        return;
      }
      const message = getMicrosoftErrorMessage(error, 'Sync failed.');
      if (message.startsWith('Saved locally.')) {
        recordPendingSyncRetry(60_000);
        queuePendingSync(undefined, { fullSync: true });
        setSyncError(formatMicrosoftManualRetryMessage());
        setSyncStatus('pending');
        return;
      }
      setSyncError(message);
      setSyncStatus('error');
    } finally {
      setSyncing(false);
    }
  }

  function scheduleSync(projectId?: string, options?: { fullSync?: boolean }) {
    queuePendingSync(projectId, options);
    setSyncStatus('pending');
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = null;
  }

  const projectMetrics = useMemo(() => {
    const metrics = new Map<string, ProjectMetrics>();
    for (const project of projects) {
      let total = 0;
      let ok = 0;
      let issues = 0;
      let activeAreaCount = 0;
      let photoCount = 0;
      let commentCount = 0;

      for (const area of project.areas) {
        if (area.deletedAt) continue;
        activeAreaCount += 1;
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
      }

      const stats = { total, ok, issues, areas: activeAreaCount };
      const reviewMetrics = getReviewMetrics(stats.total, stats.ok, stats.issues);
      metrics.set(project.id, {
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
  }, [projects]);

  const activeProjects = useMemo(
    () => projects.filter((project) => !project.deletedAt),
    [projects]
  );

  const trashedProjects = useMemo(
    () =>
      projects
        .filter((project) => project.deletedAt)
        .sort(
          (a, b) =>
            (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0)
        ),
    [projects]
  );

  const sortedProjects = useMemo(() => {
    return [...activeProjects].sort((a, b) => {
      if (sortOption === 'alphabetical') {
        return a.projectName.localeCompare(b.projectName);
      }
      if (sortOption === 'issues') {
        const issuesA = projectMetrics.get(a.id)?.stats.issues ?? 0;
        const issuesB = projectMetrics.get(b.id)?.stats.issues ?? 0;
        if (issuesB !== issuesA) return issuesB - issuesA;
        return a.projectName.localeCompare(b.projectName);
      }
      const progressA = projectMetrics.get(a.id)?.progress ?? 0;
      const progressB = projectMetrics.get(b.id)?.progress ?? 0;
      return progressB - progressA;
    });
  }, [activeProjects, projectMetrics, sortOption]);

  const singleProject = useMemo(
    () => (activeProjects.length === 1 ? activeProjects[0] : null),
    [activeProjects]
  );
  const singleProjectMainView = !!singleProject && !showTrash;
  const areaTargetProject =
    projects.find((project) => project.id === areaTargetProjectId && !project.deletedAt) ??
    singleProject;
  const facadeLevelOptions = buildFacadeLevelOptions(areaTargetProject);
  const activeAreas = useMemo(
    () => (singleProject ? singleProject.areas.filter((area) => !area.deletedAt) : []),
    [singleProject]
  );

  const areaMetrics = useMemo(() => {
    const metrics = new Map<string, AreaMetrics>();
    if (!singleProject) return metrics;

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
        photoCount,
        commentCount,
      });
    }

    return metrics;
  }, [singleProject, activeAreas]);

  const sortedAreas = useMemo(() => {
    return [...activeAreas].sort((a, b) => {
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
  }, [activeAreas, areaMetrics, sortOption]);

  async function handleCreateProject() {
    if (!newProjectName.trim()) return;

    const project = createProject(newProjectName.trim(), newProjectAddress.trim(), newProjectInspector.trim());
    project.gcName = newProjectGcName.trim();
    const facadeLevelStart = Number.parseInt(newProjectLevelStart, 10);
    const facadeLevelEnd = Number.parseInt(newProjectLevelEnd, 10);
    project.facadeLevelStart = Number.isNaN(facadeLevelStart) ? undefined : facadeLevelStart;
    project.facadeLevelEnd = Number.isNaN(facadeLevelEnd) ? undefined : facadeLevelEnd;
    await saveProject(project);
    scheduleSync(project.id);
    setProjects((prev) => [...prev, project]);
    setNewProjectName('');
    setNewProjectAddress('');
    setNewProjectInspector('');
    setNewProjectGcName('');
    setNewProjectLevelStart('');
    setNewProjectLevelEnd('');
    setShowNewProject(false);
  }

  async function handleAddArea() {
    const targetProject =
      projects.find((project) => project.id === areaTargetProjectId && !project.deletedAt) ??
      singleProject;
    if (!targetProject) return;

    const areaForms = getAreaCreationForms(newAreaForm, buildFacadeLevelOptions(targetProject));
    if (areaForms.length === 0) return;

    const createdAreas = areaForms.map(
      (areaForm, index) => {
        const areaName = buildAreaName(areaForm);
        if (!areaName) return null;

        const area = createArea(targetProject.id, areaName, targetProject.areas.length + index, {
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

    targetProject.areas.push(...createdAreas);
    await saveProject(targetProject);
    scheduleSync(targetProject.id);
    const nextRecentAreaTypeKeys = [
      newAreaForm.areaTypeKey,
      ...recentAreaTypeKeys.filter((key) => key !== newAreaForm.areaTypeKey),
    ].slice(0, 8);
    setRecentAreaTypeKeys(nextRecentAreaTypeKeys);
    localStorage.setItem(RECENT_AREA_TYPES_STORAGE_KEY, JSON.stringify(nextRecentAreaTypeKeys));
    setNewAreaForm(getDefaultAreaFormValue());
    setAreaTargetProjectId(null);
    setShowAddArea(false);
    setProjects((prev) =>
      prev.map((project) =>
        project.id === targetProject.id ? { ...targetProject, areas: [...targetProject.areas] } : project
      )
    );
  }

  const toggleProjectSelection = useCallback((id: string) => {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleToggleProjectMenu = useCallback((id: string) => {
    setShowProjectMenuId((prev) => (prev === id ? null : id));
  }, []);

  const handleCloseProjectMenu = useCallback(() => {
    setShowProjectMenuId(null);
  }, []);

  const handleOpenProjectEditor = useCallback((project: Project) => {
    setEditingProject(project);
  }, []);

  const handleProjectCardLongPress = useCallback((projectId: string) => {
    setShowTrash(false);
    setDeleteMode(false);
    setExportMode(true);
    setSelectedAreaIds(new Set());
    setSelectedProjectIds(new Set([projectId]));
  }, []);

  const handleTrashedProjectLongPress = useCallback((projectId: string) => {
    setShowTrash(true);
    setDeleteMode(true);
    setExportMode(false);
    setSelectedAreaIds(new Set());
    setSelectedProjectIds(new Set([projectId]));
  }, []);

  const toggleAreaSelection = useCallback((id: string) => {
    setSelectedAreaIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  async function handleDeleteSelectedProjects() {
    if (selectedProjectIds.size === 0) return;
    if (showTrash) {
      const projectsToDelete = trashedProjects.filter((project) => selectedProjectIds.has(project.id));
      if (projectsToDelete.length === 0) return;

      for (const project of projectsToDelete) {
        markProjectDeleted(project.id);
        await deleteProject(project.id);
      }
      scheduleSync(undefined, { fullSync: true });
      setProjects((prev) => prev.filter((project) => !selectedProjectIds.has(project.id)));
    } else {
      const projectsToTrash = activeProjects.filter((project) => selectedProjectIds.has(project.id));
      if (projectsToTrash.length === 0) return;

      for (const project of projectsToTrash) {
        project.deletedAt = new Date();
        await saveProject(project);
        queuePendingSync(project.id);
      }
      scheduleSync();
      setProjects((prev) =>
        prev.map((project) =>
          selectedProjectIds.has(project.id) ? { ...project, deletedAt: project.deletedAt } : project
        )
      );
    }

    setSelectedProjectIds(new Set());
    setDeleteMode(false);
    setExportMode(false);
    setActionSheet(null);
  }

  const handleTrashProject = useCallback(async (project: Project) => {
    project.deletedAt = new Date();
    await saveProject(project);
    scheduleSync(project.id);
    setShowProjectMenuId(null);
    setProjects((prev) =>
      prev.map((entry) => (entry.id === project.id ? { ...project, areas: [...project.areas] } : entry))
    );
  }, []);

  async function handleDeleteSelectedAreas() {
    if (!singleProject) return;
    if (selectedAreaIds.size === 0) {
      setDeleteMode(false);
      return;
    }
    const now = new Date();
    singleProject.areas.forEach((area) => {
      if (selectedAreaIds.has(area.id)) {
        area.deletedAt = now;
      }
    });
    await saveProject(singleProject);
    scheduleSync(singleProject.id);
    setSelectedAreaIds(new Set());
    setDeleteMode(false);
    setActionSheet(null);
    await loadProjects();
  }

  async function handleRestoreProject(projectId: string) {
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) return;
    delete project.deletedAt;
    unmarkProjectDeleted(project.id);
    await saveProject(project);
    scheduleSync(project.id, { fullSync: true });
    setProjects((prev) =>
      prev.map((entry) => (entry.id === project.id ? { ...project, areas: [...project.areas] } : entry))
    );
  }

  function handleExportSelectedConfirm() {
    if (exportingSelected || exportingSelectedToDrive || selectedProjectIds.size === 0) return;
    setActionSheet('export');
  }

  async function loadProjectsForExport(token?: string | null) {
    const selectedProjects = [...sortedProjects]
      .filter((project) => selectedProjectIds.has(project.id))
      .sort((a, b) => a.projectName.localeCompare(b.projectName));

    const hydratedProjects = await Promise.all(
      selectedProjects.map(async (project) => {
        const fullProject = token
          ? await hydrateProjectMediaFromOneDrive(token, project.id)
          : await getProject(project.id);
        return fullProject ?? project;
      })
    );

    return hydratedProjects.map((project) => ({
      ...project,
      areas: [...project.areas].sort(compareAreaNames),
    }));
  }

  async function handleExportSelectedLocal() {
    if (exportingSelected || selectedProjectIds.size === 0) return;
    setActionSheet(null);
    setExportingSelected(true);
    try {
      const token = isSignedIn ? await ensureAccessToken().catch(() => null) : null;
      const projectsForExport = await loadProjectsForExport(token);
      const blob = await generateMultiProjectPDF(projectsForExport, exportType);
      const filename = exportType === 'issues' ? 'UAI_PUNCHLIST_APP_Issues_Report.pdf' : 'UAI_PUNCHLIST_APP_Full_Report.pdf';
      downloadPDF(blob, filename);
    } catch (error) {
      console.error('Failed to export selected projects:', error);
      alert('Failed to export selected projects. Please try again.');
    } finally {
      setExportingSelected(false);
      setExportMode(false);
      setSelectedProjectIds(new Set());
    }
  }

  async function handleExportSelectedToDrive() {
    if (exportingSelectedToDrive || selectedProjectIds.size === 0) return;
    setActionSheet(null);
    setExportingSelectedToDrive(true);
    try {
      const token = await ensureAccessToken();
      if (!token) {
        signIn();
        return;
      }
      const projectsToExport = [...sortedProjects]
        .filter((project) => selectedProjectIds.has(project.id))
        .sort((a, b) => a.projectName.localeCompare(b.projectName));
      const projectsForExport = await loadProjectsForExport(token);
      const blob = await generateMultiProjectPDF(projectsForExport, exportType);
      const exportProject =
        projectsToExport.length === 1 ? projectsToExport[0] : null;
      const exportProjectFolderName = exportProject
        ? getOneDriveProjectFolderName(exportProject)
        : undefined;
      const filename = await getNextOneDriveExportFilename(
        token,
        projectsToExport.map((project) => `${project.projectName}_${exportType === 'issues' ? 'Issues' : 'Full'}`),
        new Date(),
        exportProjectFolderName
      );
      await uploadPdfToOneDrive(token, filename, blob, exportProjectFolderName);
    } catch (error) {
      console.error('Failed to export selected projects to OneDrive:', error);
      alert('Failed to export selected projects to OneDrive. Please try again.');
    } finally {
      setExportingSelectedToDrive(false);
      setExportMode(false);
      setSelectedProjectIds(new Set());
    }
  }

  async function handleEditProject(updates: Partial<Project>) {
    if (!editingProject) return;
    Object.assign(editingProject, updates);
    await saveProject(editingProject);
    scheduleSync(editingProject.id);
    setProjects((prev) =>
      prev.map((project) =>
        project.id === editingProject.id ? { ...editingProject, areas: [...editingProject.areas] } : project
      )
    );
    setEditingProject(null);
  }

  async function handleDeleteEditingProject() {
    if (!editingProject) return;
    const projectToDelete = editingProject;
    if (!window.confirm(`Delete "${projectToDelete.projectName}"? You can restore it later from Trash.`)) {
      return;
    }
    setEditingProject(null);
    await handleTrashProject(projectToDelete);
  }

  function cancelSelectionMode() {
    setDeleteMode(false);
    setExportMode(false);
    setActionSheet(null);
    setSelectedProjectIds(new Set());
    setSelectedAreaIds(new Set());
  }

  useEffect(() => {
    function handleHomeMenuAction(event: Event) {
      const customEvent = event as CustomEvent<{ action: string; sort?: SortOption }>;
      const detail = customEvent.detail;
      if (!detail) return;

      if (detail.action === 'sort' && detail.sort) {
        handleSortChange(detail.sort);
        return;
      }

      if (detail.action === 'sync-now') {
        void handleSync();
        return;
      }

      if (detail.action.startsWith('quick-sort:')) {
        const nextQuickSort = detail.action.replace('quick-sort:', '');
        if (nextQuickSort === 'issues' || nextQuickSort === 'alphabetical' || nextQuickSort === 'progress') {
          setQuickSort(nextQuickSort);
          handleSortChange(nextQuickSort);
        }
        return;
      }

      if (detail.action === 'new-project') {
        setShowNewProject(true);
        return;
      }

      if (detail.action === 'new-area') {
        if (singleProject) {
          setAreaTargetProjectId(singleProject.id);
          setShowAddArea(true);
        }
        return;
      }

      if (detail.action === 'toggle-trash') {
        toggleTrashView();
        return;
      }

      if (detail.action === 'clear-trash') {
        setShowTrash(false);
        setDeleteMode(false);
        setExportMode(false);
        setSelectedProjectIds(new Set());
        setSelectedAreaIds(new Set());
        return;
      }

      if (detail.action === 'edit-project' && singleProject) {
        handleOpenProjectEditor(singleProject);
        return;
      }

      if (detail.action === 'toggle-selection' && singleProject) {
        setShowTrash(false);
        setExportMode(false);
        setSelectedProjectIds(new Set());
        setActionSheet(null);
        if (deleteMode) {
          setDeleteMode(false);
          setSelectedAreaIds(new Set());
        } else {
          setDeleteMode(true);
          setSelectedAreaIds(new Set());
        }
        return;
      }

      if (detail.action === 'export-project' && singleProject) {
        setShowTrash(false);
        setDeleteMode(false);
        setExportMode(true);
        setSelectedAreaIds(new Set());
        setSelectedProjectIds(new Set([singleProject.id]));
        setActionSheet('export');
        return;
      }

      if (detail.action === 'auth') {
        if (isSignedIn) signOut();
        else signIn();
      }
    }

    window.addEventListener('punchlist-home-menu-action', handleHomeMenuAction as EventListener);
    return () => {
      window.removeEventListener('punchlist-home-menu-action', handleHomeMenuAction as EventListener);
    };
  }, [deleteMode, isSignedIn, signIn, signOut, singleProject, sortOption, showTrash, setQuickSort]);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('punchlist-home-menu-state', {
        detail: {
          context: 'home',
          sortOption,
          showTrash,
          canAddArea: !!singleProject,
          isSingleProject: !!singleProject,
          singleProjectName: singleProject?.projectName ?? '',
          selectionMode: deleteMode,
        },
      })
    );
  }, [deleteMode, sortOption, showTrash, singleProject]);

  function toggleTrashView() {
    setShowTrash((current) => {
      const next = !current;
      if (next || current) {
        cancelSelectionMode();
      }
      return next;
    });
  }

  function handlePullStart(e: TouchEvent<HTMLElement>) {
    const atTop = (listRef.current?.scrollTop ?? 0) <= 0;
    if (!atTop || syncing) {
      pullStartYRef.current = null;
      return;
    }
    pullStartYRef.current = e.touches[0]?.clientY ?? null;
  }

  function handlePullMove(e: TouchEvent<HTMLElement>) {
    const atTop = (listRef.current?.scrollTop ?? 0) <= 0;
    if (pullStartYRef.current === null || !atTop || syncing) return;
    const currentY = e.touches[0]?.clientY ?? pullStartYRef.current;
    const delta = currentY - pullStartYRef.current;
    const armed = delta >= 90;
    if (armed !== pullArmedRef.current) {
      pullArmedRef.current = armed;
    }
  }

  function handlePullEnd() {
    pullStartYRef.current = null;
    if (pullArmedRef.current && !syncing) {
      void handleSync();
    }
    pullArmedRef.current = false;
  }

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--background)]">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-black/10 border-t-[var(--accent)] dark:border-white/10 dark:border-t-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="app-page h-[calc(100dvh-env(safe-area-inset-top)-3.5rem)] flex flex-col overflow-hidden">
      {(singleProjectMainView || showTrash || selectionMode) && (
        <header className="header-stable shrink-0 border-b z-20">
          {(singleProjectMainView || showTrash) && (
            <div className="mx-auto flex min-h-[4.9rem] w-full max-w-6xl items-center px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                {singleProjectMainView ? (
                  <>
                    <h1 className="truncate text-[1.2rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
                      {singleProject.projectName}
                    </h1>
                    <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
                      {singleProject.address || 'Project dashboard'}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="section-eyebrow">Archive</div>
                    <h1 className="mt-1 text-[1.2rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
                      Trash
                    </h1>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      Recently removed projects stay here for 30 days.
                    </p>
                  </>
                )}
              </div>
              {singleProjectMainView && selectionMode && (
                <div className="ml-3 flex items-center gap-3">
                  <button
                    onClick={cancelSelectionMode}
                    className="rounded-full px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-black/[0.04] hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (selectedAreaIds.size === 0) return;
                      void handleDeleteSelectedAreas();
                    }}
                    className="accent-text accent-tint hover:accent-tint-strong flex h-10 w-10 items-center justify-center rounded-full transition disabled:opacity-40"
                    aria-label="Delete selected areas"
                    disabled={selectedAreaIds.size === 0}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          )}
          {selectionMode && !singleProjectMainView && (
          <div className="mx-auto flex w-full max-w-6xl items-center gap-3 border-t border-gray-200/80 px-4 py-3 dark:border-gray-800 sm:px-5">
            <button
              onClick={cancelSelectionMode}
              className="rounded-full px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-black/[0.04] hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
            >
              Cancel
            </button>
            {!singleProjectMainView && !showTrash && (
              <button
                onClick={() => void handleExportSelectedConfirm()}
                disabled={exportingSelected || exportingSelectedToDrive || selectedProjectIds.size === 0}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-black/5 bg-white/70 text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08] disabled:opacity-40"
                aria-label="Export selected projects"
              >
                {exportingSelected || exportingSelectedToDrive ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FileDown className="w-4 h-4" />
                )}
              </button>
            )}
            <button
              onClick={() => {
                if (singleProjectMainView) {
                  if (selectedAreaIds.size === 0) return;
                  void handleDeleteSelectedAreas();
                  return;
                } else if (selectedProjectIds.size === 0) {
                  return;
                }
                if (showTrash) {
                  setActionSheet('delete');
                  return;
                }
                void handleDeleteSelectedProjects();
              }}
              className="accent-text accent-tint hover:accent-tint-strong flex h-10 w-10 items-center justify-center rounded-full transition disabled:opacity-40"
              aria-label={singleProjectMainView ? 'Delete selected areas' : 'Delete selected projects'}
              disabled={singleProjectMainView ? selectedAreaIds.size === 0 : selectedProjectIds.size === 0}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          )}
        </header>
      )}
      {syncError && (
        <div className="shrink-0 border-b border-gray-200/80 bg-white/70 px-4 py-2 text-sm text-gray-700 dark:border-zinc-700 dark:bg-white/[0.03] dark:text-gray-200">
          {syncError}
        </div>
      )}
      {syncConflicts.length > 0 && (
        <div className="shrink-0 border-b border-gray-200/80 bg-white/70 px-4 py-3 text-sm dark:border-zinc-700 dark:bg-white/[0.03]">
          <div className="text-gray-700 dark:text-gray-200">Conflicts detected:</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {syncConflicts.map((conflict) => (
              <span
                key={conflict.id}
                className="segmented-chip px-3 py-1 text-xs"
              >
                {conflict.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <main
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+6.5rem)] sm:px-5"
        onTouchStart={handlePullStart}
        onTouchMove={handlePullMove}
        onTouchEnd={handlePullEnd}
        onTouchCancel={handlePullEnd}
      >
        {showTrash ? (
          trashedProjects.length === 0 ? (
          <div className="empty-state-card mx-auto max-w-md rounded-[2rem] p-10 text-center">
            <Trash2 className="mx-auto mb-4 h-14 w-14 text-gray-300 dark:text-gray-600" />
            <h2 className="mb-2 text-lg font-medium text-gray-900 dark:text-white">Trash Is Empty</h2>
            <p className="text-gray-500 dark:text-gray-400">Deleted projects stay here for 30 days before permanent removal.</p>
          </div>
          ) : (
            <div className="list-stack mx-auto w-full max-w-6xl">
              {trashedProjects.map((project) => {
                const deletedAt = project.deletedAt ?? new Date();
                const expiresAt = new Date(deletedAt.getTime() + TRASH_RETENTION_MS);
                const isSelected = selectedProjectIds.has(project.id);
                const longPressRef = { current: null as ReturnType<typeof setTimeout> | null };

                function clearLongPress() {
                  if (longPressRef.current) {
                    clearTimeout(longPressRef.current);
                    longPressRef.current = null;
                  }
                }

                return (
                  <div
                    key={project.id}
                    onContextMenu={(event) => {
                      if (!deleteMode) {
                        event.preventDefault();
                      }
                    }}
                    onClick={() => {
                      if (deleteMode) {
                        toggleProjectSelection(project.id);
                      }
                    }}
                    onPointerDown={() => {
                      if (!deleteMode) {
                        longPressRef.current = setTimeout(() => {
                          handleTrashedProjectLongPress(project.id);
                          longPressRef.current = null;
                        }, LONG_PRESS_MS);
                      }
                    }}
                    onPointerUp={clearLongPress}
                    onPointerCancel={clearLongPress}
                    onPointerLeave={clearLongPress}
                    className={`card-surface-subtle rounded-[1.5rem] p-4 transition-all ${
                      isSelected
                        ? '!border-gray-400 !bg-gray-100 dark:!border-gray-500 dark:!bg-white/[0.08]'
                        : 'hover:-translate-y-px hover:border-black/10 dark:hover:border-white/[0.08]'
                    } ${deleteMode ? 'cursor-pointer' : ''} select-none touch-manipulation [-webkit-touch-callout:none]`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="font-medium text-gray-900 dark:text-white truncate">{project.projectName}</div>
                        </div>
                        <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                          Deleted {deletedAt.toLocaleDateString()}
                        </div>
                        <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                          Permanently removed after {expiresAt.toLocaleDateString()}
                        </div>
                      </div>
                      {!deleteMode && (
                        <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => void handleRestoreProject(project.id)}
                          onContextMenu={(event) => event.preventDefault()}
                          onPointerDown={(event) => event.stopPropagation()}
                          className="segmented-chip px-3 py-2 text-sm"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          Restore
                        </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : singleProjectMainView ? (
          <div className="list-stack mx-auto min-h-[calc(100%+1px)] w-full max-w-6xl">
            {sortedAreas.length === 0 ? (
              <div className="flex min-h-[50vh] items-center justify-center py-12">
                <div className="empty-state-card w-full max-w-sm rounded-[1.9rem] p-8 text-center">
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">No areas yet</h2>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    Add the first area to turn this project into an active inspection dashboard.
                  </p>
                </div>
              </div>
            ) : (
              sortedAreas.map((area) => {
                const metric = areaMetrics.get(area.id);
                const isSelected = selectedAreaIds.has(area.id);
                return (
                  <HomeAreaCard
                    key={area.id}
                    projectId={singleProject.id}
                    area={area}
                    metric={metric}
                    deleteMode={deleteMode}
                    isSelected={isSelected}
                    onToggleSelection={toggleAreaSelection}
                  />
                );
              })
            )}
          </div>
        ) : (
          <div className="list-stack mx-auto min-h-[calc(100%+1px)] w-full max-w-6xl">
            {sortedProjects.length === 0 ? (
              <div className="flex min-h-[50vh] items-center justify-center py-12">
                <div className="empty-state-card w-full max-w-sm rounded-[1.9rem] p-8 text-center">
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">No projects yet</h2>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    Create a project to start tracking units, issues, and inspection progress.
                  </p>
                </div>
              </div>
            ) : (
              sortedProjects.map((project) => {
                const metric = projectMetrics.get(project.id);
                const isSelected = selectedProjectIds.has(project.id);
                return (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    metric={metric}
                    selectionMode={selectionMode}
                    isSelected={isSelected}
                    menuOpen={showProjectMenuId === project.id}
                    onToggleSelection={toggleProjectSelection}
                    onToggleMenu={handleToggleProjectMenu}
                    onCloseMenu={handleCloseProjectMenu}
                    onEditProject={handleOpenProjectEditor}
                    onDeleteProject={handleTrashProject}
                    onLongPressSelect={handleProjectCardLongPress}
                  />
                );
              })
            )}
          </div>
        )}
      </main>

      {!showTrash && !selectionMode && (
        <div className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+1.25rem)] left-1/2 z-20 -translate-x-1/2">
          {singleProjectMainView ? (
            <button
              onClick={() => {
                setAreaTargetProjectId(singleProject.id);
                setShowAddArea(true);
              }}
            className="floating-action pointer-events-auto inline-flex h-14 w-[10.75rem] items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition hover:translate-y-[-1px]"
            >
              <Plus className="h-4 w-4" />
              Add Area
            </button>
          ) : (
            <button
              onClick={() => setShowNewProject(true)}
            className="floating-action pointer-events-auto inline-flex h-14 w-[11.25rem] items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition hover:translate-y-[-1px]"
            >
              <Plus className="h-4 w-4" />
              Add Project
            </button>
          )}
        </div>
      )}

      <AreaEditorModal
        open={showAddArea}
        title="Add Area"
        value={newAreaForm}
        recentAreaTypeKeys={recentAreaTypeKeys}
        facadeLevelOptions={facadeLevelOptions}
        enableFacadeLevelBatch
        onChange={setNewAreaForm}
        onClose={() => {
          setShowAddArea(false);
          setAreaTargetProjectId(null);
          setNewAreaForm(getDefaultAreaFormValue());
        }}
        onSubmit={() => void handleAddArea()}
        submitLabel="Add"
      />

      {showAreaProjectPicker && !singleProjectMainView && (
        <div className="modal-overlay fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
          <div className="w-full max-w-md pointer-events-auto">
            <div className="modal-panel rounded-[1.8rem] p-5">
              <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Choose Project</h2>
              <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">Pick the project that should receive the new area.</p>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Project
              </label>
              <select
                value={areaTargetProjectId ?? ''}
                onChange={(e) => setAreaTargetProjectId(e.target.value)}
                className="field-shell"
              >
                <option value="">Select project</option>
                {sortedProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.projectName}
                  </option>
                ))}
              </select>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => {
                    setShowAreaProjectPicker(false);
                    setAreaTargetProjectId(null);
                  }}
                  className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (!areaTargetProjectId) return;
                    setShowAreaProjectPicker(false);
                    setShowAddArea(true);
                  }}
                  disabled={!areaTargetProjectId}
                  className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200 disabled:opacity-50"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* New Project Modal */}
      {showNewProject && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel w-full max-w-md rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">New Project</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">Create a polished inspection workspace with the basics filled in.</p>
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Project Name *
                </label>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  className="field-shell"
                  placeholder="Enter project name"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Address
                </label>
                <input
                  type="text"
                  value={newProjectAddress}
                  onChange={(e) => setNewProjectAddress(e.target.value)}
                  className="field-shell"
                  placeholder="Enter address"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Inspected By
                </label>
                <input
                  type="text"
                  value={newProjectInspector}
                  onChange={(e) => setNewProjectInspector(e.target.value)}
                  className="field-shell"
                  placeholder="Enter inspector name"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  GC Name
                </label>
                <input
                  type="text"
                  value={newProjectGcName}
                  onChange={(e) => setNewProjectGcName(e.target.value)}
                  className="field-shell"
                  placeholder="Enter GC name"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Level Range
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="number"
                    value={newProjectLevelStart}
                    onChange={(e) => setNewProjectLevelStart(e.target.value)}
                    className="field-shell"
                    placeholder="From"
                  />
                  <input
                    type="number"
                    value={newProjectLevelEnd}
                    onChange={(e) => setNewProjectLevelEnd(e.target.value)}
                    className="field-shell"
                    placeholder="To"
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowNewProject(false);
                  setNewProjectName('');
                  setNewProjectAddress('');
                  setNewProjectInspector('');
                  setNewProjectGcName('');
                  setNewProjectLevelStart('');
                  setNewProjectLevelEnd('');
                }}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim()}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {editingProject && (
        <ProjectEditModal
          project={editingProject}
          onSave={handleEditProject}
          onDelete={singleProjectMainView ? () => void handleDeleteEditingProject() : undefined}
          onClose={() => setEditingProject(null)}
        />
      )}

      {actionSheet && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <div className="modal-panel overflow-hidden rounded-[1.8rem] p-2">
              {actionSheet === 'export' ? (
                <>
                  <button
                    onClick={() => void handleExportSelectedToDrive()}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    OneDrive
                  </button>
                  <button
                    onClick={() => void handleExportSelectedLocal()}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Local
                  </button>
                  <button
                    onClick={() => setActionSheet(null)}
                    className="mt-1 w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      if (singleProjectMainView) {
                        void handleDeleteSelectedAreas();
                        return;
                      }
                      void handleDeleteSelectedProjects();
                    }}
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
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
