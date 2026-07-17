'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Area, Project, checkpointHasIssue, getReviewMetrics } from '@/types';
import {
  getAllProjects,
  getProject,
  getProjectMetadata,
  saveProject,
  saveProjectMetadataOnly,
  saveProjectPreserveTimestamps,
  deleteProject,
  createProject,
  createArea,
  clearPendingSharedSyncsForProject,
} from '@/lib/db';
import {
  markProjectDeleted,
  unmarkProjectDeleted,
  hydrateProjectMediaFromOneDrive,
} from '@/lib/oneDriveSync';
import {
  hasPendingSyncState,
  queuePendingSync,
} from '@/lib/pendingSync';
import type { PdfExportMode } from '@/lib/pdfExport';
import { uploadPdfToOneDrive, getNextOneDriveExportFilename } from '@/lib/oneDrive';
import {
  formatDateForExport,
  getOneDriveProjectFolderName,
  sanitizeExportNamePart,
} from '@/lib/projectNaming';
import { runManualOneDriveSync } from '@/features/sync/runManualOneDriveSync';
import {
  formatPendingSharedPullMessage,
  formatPendingSharedPullSuccessMessage,
  getPendingSharedPullState,
  mergeSharedProjectAreasWithPendingMetadata,
  type PendingSharedPullState,
} from '@/features/collaboration/manualSharedPull';
import {
  clearDetachedSharedProjectMetadata,
  detachLocalSharedProject,
  findDetachedSharedProject,
  relinkDetachedSharedProject,
} from '@/features/collaboration/detachedSharedProject';
import { ProjectCard, type ProjectCardMetrics as ProjectMetrics } from '@/features/projects/ProjectCard';
import { HomeAreaCard,
  type HomeAreaCardMetrics as AreaMetrics,
  type HomeAreaClaimDisplay as AreaClaimDisplay,
} from '@/features/projects/HomeAreaCard';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import {
  createSharedProjectFromLocalProject,
  captureSharedProjectBackup,
  claimSharedProjectArea,
  disconnectSharedProject,
  generateSharedProjectJoinCode,
  getActiveSharedProjectAreaClaimSummaries,
  getSharedProjectMembers,
  getSharedProjectBackupSnapshot,
  getSharedProjectSnapshot,
  getSharedProjectSnapshotMetadata,
  hasNewerLocalChangesThanSharedSnapshot,
  getCollaborationErrorMessage,
  isSharedProjectPublishConflictError,
  isSharedSnapshotNewer,
  joinSharedProjectByCode,
  listMySharedProjects,
  listSharedProjectBackups,
  publishSharedProjectSnapshot,
  queueSharedProjectAreaSyncs,
  saveAndQueueSharedProjectMetadataSync,
  runCollaborationHealthCheck,
  subscribeToSharedProjectAreaSnapshotChanges,
  subscribeToSharedProjectAreaClaimChanges,
  subscribeToSharedProjectMetadataSnapshotChanges,
  subscribeToSharedProjectSnapshotChanges,
  syncSharedProjectMetadataNow,
  transferSharedProjectOwnership,
} from '@/lib/collaboration';
import type { CollaborationHealthReport, CollaborationProjectMember, CollaborationSharedProjectDirectoryEntry, CollaborationSnapshotBackup } from '@/lib/collaboration';
import ProjectEditModal from '@/components/ProjectEditModal';
import AreaEditorModal from '@/components/AreaEditorModal';
import AppMessageDialog from '@/components/AppMessageDialog';
import AppConfirmDialog from '@/components/AppConfirmDialog';
import AppPromptDialog from '@/components/AppPromptDialog';
import CollaborationHealthDialog from '@/components/CollaborationHealthDialog';
import { applyTemplateToArea } from '@/lib/template';
import {
  cacheProjectPreview,
  getCachedProjectPreviews,
  removeCachedProjectPreview,
  replaceProjectPreviewCache,
} from '@/lib/projectNavigationCache';
import { readLocalStorage, writeLocalStorage } from '@/lib/browserStorage';
import {
  buildAreaName,
  buildFacadeLevelOptions,
  compareAreaNames,
  getAreaDisplayNameMap,
  getAreaCreationForms,
  getDefaultAreaFormValue,
  upsertFacadeElevationDrawing,
  type AreaFormValue,
  type AreaTypeKey,
} from '@/lib/areas';
import { useRouter } from 'next/navigation';
import {
  Trash2,
  FileDown,
  Loader2,
  RotateCcw,
  Plus,
} from 'lucide-react';

type SortOption = 'alphabetical' | 'issues' | 'progress';
type ExportDestination = 'local' | 'onedrive';
type ExportScope = 'selected-projects' | 'selected-areas';

const SORT_STORAGE_KEY = 'punchlist-projects-sort';
const RECENT_AREA_TYPES_STORAGE_KEY = 'punchlist-recent-area-types';
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LONG_PRESS_MS = 500;
const SHARED_AREA_CLAIM_REFRESH_MS = 15 * 1000;

function formatSharedBackupReason(reason: CollaborationSnapshotBackup['reason']) {
  if (reason === 'publish') return 'Published version';
  if (reason === 'before_publish') return 'Before publish';
  if (reason === 'before_pull') return 'Before pull';
  if (reason === 'restore') return 'Before restore';
  return 'Manual backup';
}

function formatMemberStatus(status: CollaborationProjectMember['accessState']) {
  if (status === 'active') return 'Active';
  if (status === 'invited') return 'Invited';
  return 'Removed';
}

function formatMemberJoinMethod(method: CollaborationProjectMember['joinedBy']) {
  return method === 'joinCode' ? 'Joined by code' : 'Email invite';
}

type MessageDialogState = {
  title: string;
  message: string;
};

type BackupRestoreConfirmState = {
  backup: CollaborationSnapshotBackup;
  publishAfterRestore: boolean;
};

type TrashedAreaEntry = {
  project: Project;
  area: Area;
  deletedAt: Date;
};

export default function ProjectsPage() {
  const router = useRouter();
  const cachedProjects = useMemo(() => getCachedProjectPreviews(), []);
  const [projects, setProjects] = useState<Project[]>(() => cachedProjects);
  const [loading, setLoading] = useState(() => cachedProjects.length === 0);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectAddress, setNewProjectAddress] = useState('');
  const [newProjectInspector, setNewProjectInspector] = useState('');
  const [newProjectGcName, setNewProjectGcName] = useState('');
  const [newProjectLevelStart, setNewProjectLevelStart] = useState('');
  const [newProjectLevelEnd, setNewProjectLevelEnd] = useState('');
  const [joinProjectCode, setJoinProjectCode] = useState('');
  const [showJoinProject, setShowJoinProject] = useState(false);
  const [joiningProject, setJoiningProject] = useState(false);
  const [sharedProjectCode, setSharedProjectCode] = useState<{
    projectName: string;
    code: string;
    expiresAt: string;
  } | null>(null);
  const [creatingJoinCode, setCreatingJoinCode] = useState(false);
  const [loadingSharedMembers, setLoadingSharedMembers] = useState(false);
  const [sharedMembersProject, setSharedMembersProject] = useState<Project | null>(null);
  const [sharedMembers, setSharedMembers] = useState<CollaborationProjectMember[]>([]);
  const [pendingPull, setPendingPull] = useState<PendingSharedPullState | null>(null);
  const [disconnectSharedProjectConfirm, setDisconnectSharedProjectConfirm] = useState<Project | null>(null);
  const [disconnectSharedProjectIsOwner, setDisconnectSharedProjectIsOwner] = useState(false);
  const [disconnectSharedProjectLocalOnly, setDisconnectSharedProjectLocalOnly] = useState(false);
  const [disconnectingSharedProject, setDisconnectingSharedProject] = useState(false);
  const [transferringSharedProject, setTransferringSharedProject] = useState(false);
  const [showMySharedProjects, setShowMySharedProjects] = useState(false);
  const [loadingMySharedProjects, setLoadingMySharedProjects] = useState(false);
  const [mySharedProjects, setMySharedProjects] = useState<CollaborationSharedProjectDirectoryEntry[]>([]);
  const [addingSharedProjectId, setAddingSharedProjectId] = useState<string | null>(null);
  const [directoryDisconnectConfirm, setDirectoryDisconnectConfirm] = useState<CollaborationSharedProjectDirectoryEntry | null>(null);
  const [disconnectingDirectoryProjectId, setDisconnectingDirectoryProjectId] = useState<string | null>(null);
  const [backupProject, setBackupProject] = useState<Project | null>(null);
  const [loadingSharedBackups, setLoadingSharedBackups] = useState(false);
  const [sharedBackups, setSharedBackups] = useState<CollaborationSnapshotBackup[]>([]);
  const [restoringBackupId, setRestoringBackupId] = useState<string | null>(null);
  const [backupRestoreConfirm, setBackupRestoreConfirm] = useState<BackupRestoreConfirmState | null>(null);
  const [ownershipTransferProject, setOwnershipTransferProject] = useState<Project | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<Project | null>(null);
  const [showCollaborationHealth, setShowCollaborationHealth] = useState(false);
  const [collaborationHealthReport, setCollaborationHealthReport] = useState<CollaborationHealthReport | null>(null);
  const [runningCollaborationHealth, setRunningCollaborationHealth] = useState(false);
  const [sortOption, setSortOption] = useState<SortOption>('issues');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [deleteMode, setDeleteMode] = useState(false);
  const [exportMode, setExportMode] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [exportingSelected, setExportingSelected] = useState(false);
  const [exportingSelectedToDrive, setExportingSelectedToDrive] = useState(false);
  const [exportingSelectedAreas, setExportingSelectedAreas] = useState(false);
  const [actionSheet, setActionSheet] = useState<'delete' | 'export' | 'export-scope' | null>(null);
  const [exportScope, setExportScope] = useState<ExportScope>('selected-projects');
  const [exportType] = useState<PdfExportMode>('issues');
  const [showProjectMenuId, setShowProjectMenuId] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showAddArea, setShowAddArea] = useState(false);
  const [showAreaProjectPicker, setShowAreaProjectPicker] = useState(false);
  const [areaTargetProjectId, setAreaTargetProjectId] = useState<string | null>(null);
  const [selectedAreaIds, setSelectedAreaIds] = useState<Set<string>>(new Set());
  const [newAreaForm, setNewAreaForm] = useState(getDefaultAreaFormValue());
  const [recentAreaTypeKeys, setRecentAreaTypeKeys] = useState<AreaTypeKey[]>([]);
  const [sharedAreaClaims, setSharedAreaClaims] = useState<Map<string, AreaClaimDisplay>>(new Map());
  const [messageDialog, setMessageDialog] = useState<MessageDialogState | null>(null);
  const backgroundAreaClaimKeysRef = useRef(new Set<string>());
  const projectsRef = useRef<Project[]>(cachedProjects);
  const homeMenuActionHandlerRef = useRef<((event: Event) => void) | null>(null);
  const loadProjectsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const scheduleSyncRef = useRef<(projectId?: string, options?: { fullSync?: boolean }) => void>(() => {});
  const { signIn, signOut, isReady, isSignedIn, ensureAccessToken, accountEmail, accountName } = useMicrosoftAuth();
  const collaborationAuth = useCollaborationAuth();
  const {
    clearSharedUpdateAvailable,
    markSharedUpdateAvailable,
    setSharedTransferStatus,
    setRetryAt,
    setStatus: setSyncStatus,
    setSyncConflicts,
    syncConflicts,
  } = useSyncStatus();
  const { quickSort, setQuickSort, markSyncedNow } = useAppSettings();
  const selectionMode = deleteMode || exportMode;
  loadProjectsRef.current = loadProjects;

  const showMessage = useCallback((message: string, title = 'Punchlist') => {
    setMessageDialog({ title, message });
  }, []);

  scheduleSyncRef.current = scheduleSync;

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    const savedSort = readLocalStorage(SORT_STORAGE_KEY);
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
    // Start the durable load before reading optional UI preferences so blocked
    // browser storage can never leave the app on its startup spinner.
    void loadProjectsRef.current();
    const savedRecentAreaTypes = readLocalStorage(RECENT_AREA_TYPES_STORAGE_KEY);
    if (savedRecentAreaTypes) {
      try {
        setRecentAreaTypeKeys(JSON.parse(savedRecentAreaTypes) as AreaTypeKey[]);
      } catch (error) {
        console.error('Failed to parse recent area types:', error);
      }
    }
  }, []);

  useEffect(() => {
    if (!collaborationAuth.isSignedIn) return;
    if (loading) return;
    void loadProjectsRef.current();
  }, [collaborationAuth.isSignedIn, loading]);

  useEffect(() => {
    if (!isReady || loading) return;
    if (!isSignedIn) {
      setRetryAt(null);
      setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
      return;
    }

    setRetryAt(null);
    setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
  }, [isReady, isSignedIn, loading, setRetryAt, setSyncStatus]);

  function handleSortChange(option: SortOption) {
    setSortOption(option);
    writeLocalStorage(SORT_STORAGE_KEY, option);
  }

  const primeProjectOpen = useCallback(
    (project: Project) => {
      cacheProjectPreview(project);
      router.prefetch(`/project/${project.id}`);
    },
    [router]
  );

  const primeAreaOpen = useCallback(
    (project: Project, areaId: string) => {
      cacheProjectPreview(project);
      router.prefetch(`/project/${project.id}/area/${areaId}`);
    },
    [router]
  );

  const markAreaClaimedByCurrentUser = useCallback((areaId: string, expiresAt?: Date) => {
    setSharedAreaClaims((current) => {
      const existing = current.get(areaId);
      if (
        existing?.ownership === 'mine' &&
        existing.expiresAt?.getTime() === expiresAt?.getTime()
      ) {
        return current;
      }

      const next = new Map(current);
      next.set(areaId, {
        ownership: 'mine',
        label: 'you',
        expiresAt,
      });
      return next;
    });
  }, []);

  const clearOptimisticAreaClaim = useCallback((areaId: string) => {
    setSharedAreaClaims((current) => {
      const existing = current.get(areaId);
      if (existing?.ownership !== 'mine') return current;
      const next = new Map(current);
      next.delete(areaId);
      return next;
    });
  }, []);

  const claimAreaOpenInBackground = useCallback(
    (project: Project, areaId: string) => {
      const sharedProjectId = project.sharedProjectId;
      const userId = collaborationAuth.user?.id;
      if (!sharedProjectId || !collaborationAuth.isSignedIn || !userId) return;

      const claimKey = `${sharedProjectId}:${areaId}`;
      if (backgroundAreaClaimKeysRef.current.has(claimKey)) return;

      backgroundAreaClaimKeysRef.current.add(claimKey);
      markAreaClaimedByCurrentUser(areaId);

      void claimSharedProjectArea(sharedProjectId, areaId)
        .then((claim) => {
          markAreaClaimedByCurrentUser(areaId, claim.expiresAt);
        })
        .catch((error) => {
          clearOptimisticAreaClaim(areaId);
          console.info('Background shared area claim failed:', error);
        })
        .finally(() => {
          backgroundAreaClaimKeysRef.current.delete(claimKey);
        });
    },
    [
      clearOptimisticAreaClaim,
      collaborationAuth.isSignedIn,
      collaborationAuth.user?.id,
      markAreaClaimedByCurrentUser,
    ]
  );

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
          removeCachedProjectPreview(project.id);
        }
        scheduleSync(undefined, { fullSync: true });
      }

      const expiredIds = new Set(expiredProjects.map((project) => project.id));
      const activeData = data.filter((project) => !expiredIds.has(project.id));
      if (collaborationAuth.isSignedIn) {
        void detectNewerSharedSnapshots(activeData);
      }
      replaceProjectPreviewCache(activeData);
      setProjects(activeData);
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
    setRetryAt(null);
    setSyncStatus('syncing');
    try {
      const result = await runManualOneDriveSync({
        ensureAccessToken: () => ensureAccessToken({ interactive: true }),
      });
      if (result.status === 'needs-auth') {
        setSyncError('Please sign in to sync.');
        setSyncStatus('needs-auth');
        await signIn({ selectAccount: true });
        return;
      }
      if (result.status === 'conflict') {
        setSyncConflicts(result.conflicts);
        setSyncError(result.message);
        setSyncStatus('error');
        return;
      }
      if (result.status === 'retry') {
        setSyncError(result.message);
        setSyncStatus('pending');
        return;
      }
      if (result.status === 'error') {
        setSyncError(result.message);
        setSyncStatus('error');
        return;
      }
      setSyncConflicts([]);
      setSyncError(null);
      setRetryAt(null);
      setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
      markSyncedNow();
      await loadProjects();
    } finally {
      setSyncing(false);
    }
  }

  function scheduleSync(projectId?: string, options?: { fullSync?: boolean }) {
    queuePendingSync(projectId, options);
    setSyncStatus('pending');
  }

  async function detectNewerSharedSnapshots(projectsToCheck: Project[]) {
    const sharedProjects = projectsToCheck.filter((project) => project.sharedProjectId);
    if (sharedProjects.length === 0) return;
    try {
      const directory = await listMySharedProjects();
      const publishedAtByProjectId = new Map(
        directory.map((entry) => [entry.projectId, entry.publishedAt] as const)
      );
      for (const project of sharedProjects) {
        const publishedAt = publishedAtByProjectId.get(project.sharedProjectId!);
        if (publishedAt && isSharedSnapshotNewer(project, publishedAt.toISOString())) {
          markSharedUpdateAvailable(project.id);
        } else {
          clearSharedUpdateAvailable(project.id);
        }
      }
    } catch (error) {
      console.info('Shared update check skipped:', error);
    }
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

  const trashedAreaEntries = useMemo<TrashedAreaEntry[]>(
    () =>
      projects
        .flatMap((project) => {
          if (project.deletedAt) return [];
          return project.areas
            .filter((area) => area.deletedAt)
            .map((area) => ({
              project,
              area,
              deletedAt: area.deletedAt ?? new Date(0),
            }));
        })
        .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime()),
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
  const multiProjectSharedProjectSubscriptionKey = useMemo(() => {
    if (activeProjects.length <= 1) return '';
    return activeProjects
      .flatMap((project) => (project.sharedProjectId ? [`${project.id}:${project.sharedProjectId}`] : []))
      .sort()
      .join('|');
  }, [activeProjects]);

  const noticeLiveSharedDashboardProject = useCallback(async (
    localProjectId: string,
    sharedProjectId: string,
    publishedAt?: string
  ) => {
    try {
      const visibleProject = projectsRef.current.find(
        (entry) => entry.id === localProjectId && entry.sharedProjectId === sharedProjectId
      );
      if (!visibleProject || visibleProject.deletedAt) return;

      const storedProject = await getProjectMetadata(localProjectId);
      const comparisonProject = storedProject?.sharedProjectId === sharedProjectId
        ? storedProject
        : visibleProject;

      let remotePublishedAt = publishedAt;
      if (!remotePublishedAt) {
        const metadata = await getSharedProjectSnapshotMetadata(sharedProjectId);
        remotePublishedAt = metadata?.publishedAt;
      }
      if (!remotePublishedAt) return;
      if (!isSharedSnapshotNewer(comparisonProject, remotePublishedAt)) return;
      markSharedUpdateAvailable(localProjectId);
    } catch (error) {
      console.info('Live shared update notice skipped:', error);
    }
  }, [markSharedUpdateAvailable]);

  useEffect(() => {
    if (!collaborationAuth.isSignedIn || !multiProjectSharedProjectSubscriptionKey) return;

    const unsubscribeSnapshotChanges = multiProjectSharedProjectSubscriptionKey
      .split('|')
      .map((entry) => {
        const [localProjectId, sharedProjectId] = entry.split(':');
        if (!localProjectId || !sharedProjectId) return () => {};
        const unsubscribeSnapshot = subscribeToSharedProjectSnapshotChanges(sharedProjectId, (change) => {
          void noticeLiveSharedDashboardProject(localProjectId, sharedProjectId, change.publishedAt);
        });
        const unsubscribeArea = subscribeToSharedProjectAreaSnapshotChanges(sharedProjectId, (change) => {
          void noticeLiveSharedDashboardProject(localProjectId, sharedProjectId, change.publishedAt);
        });
        const unsubscribeMetadata = subscribeToSharedProjectMetadataSnapshotChanges(
          sharedProjectId,
          (change) => {
            void noticeLiveSharedDashboardProject(localProjectId, sharedProjectId, change.publishedAt);
          }
        );
        return () => {
          unsubscribeSnapshot();
          unsubscribeArea();
          unsubscribeMetadata();
        };
      });

    return () => {
      unsubscribeSnapshotChanges.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    collaborationAuth.isSignedIn,
    multiProjectSharedProjectSubscriptionKey,
    noticeLiveSharedDashboardProject,
  ]);

  useEffect(() => {
    if (!collaborationAuth.isSignedIn || !singleProject?.sharedProjectId) return;

    const localProjectId = singleProject.id;
    const activeSharedProjectId = singleProject.sharedProjectId;
    const unsubscribeSnapshotChanges = subscribeToSharedProjectSnapshotChanges(
      activeSharedProjectId,
      (change) => {
        void noticeLiveSharedDashboardProject(
          localProjectId,
          activeSharedProjectId,
          change.publishedAt
        );
      }
    );
    const unsubscribeAreaChanges = subscribeToSharedProjectAreaSnapshotChanges(
      activeSharedProjectId,
      (change) => {
        void noticeLiveSharedDashboardProject(
          localProjectId,
          activeSharedProjectId,
          change.publishedAt
        );
      }
    );
    const unsubscribeMetadataChanges = subscribeToSharedProjectMetadataSnapshotChanges(
      activeSharedProjectId,
      (change) => {
        void noticeLiveSharedDashboardProject(
          localProjectId,
          activeSharedProjectId,
          change.publishedAt
        );
      }
    );

    return () => {
      unsubscribeSnapshotChanges();
      unsubscribeAreaChanges();
      unsubscribeMetadataChanges();
    };
  }, [
    collaborationAuth.isSignedIn,
    noticeLiveSharedDashboardProject,
    singleProject?.id,
    singleProject?.sharedProjectId,
  ]);

  const areaTargetProject =
    projects.find((project) => project.id === areaTargetProjectId && !project.deletedAt) ??
    singleProject;
  const facadeLevelOptions = buildFacadeLevelOptions(areaTargetProject);
  const activeAreas = useMemo(
    () => (singleProject ? singleProject.areas.filter((area) => !area.deletedAt) : []),
    [singleProject]
  );
  const areaDisplayNames = useMemo(
    () => getAreaDisplayNameMap(activeAreas),
    [activeAreas]
  );

  useEffect(() => {
    const sharedProjectId = singleProject?.sharedProjectId;
    const userId = collaborationAuth.user?.id;
    if (!sharedProjectId || !collaborationAuth.isSignedIn || !userId) {
      setSharedAreaClaims(new Map());
      return;
    }

    const activeSharedProjectId = sharedProjectId;
    const activeUserId = userId;
    let cancelled = false;

    async function refreshSharedAreaClaims() {
      try {
        const claims = await getActiveSharedProjectAreaClaimSummaries(activeSharedProjectId);
        if (cancelled) return;
        setSharedAreaClaims(
          new Map(
            claims.map((claim): [string, AreaClaimDisplay] => {
              const isMine = claim.claimedByUserId === activeUserId;
              return [
                claim.areaId,
                {
                  ownership: isMine ? 'mine' : 'other',
                  label: claim.claimedByDisplayName || claim.claimedByEmail || 'another user',
                  expiresAt: claim.expiresAt,
                },
              ];
            })
          )
        );
      } catch (error) {
        if (cancelled) return;
        console.info('Shared area claims unavailable:', error);
        setSharedAreaClaims(new Map());
      }
    }

    void refreshSharedAreaClaims();
    const unsubscribeAreaClaimChanges = subscribeToSharedProjectAreaClaimChanges(
      activeSharedProjectId,
      () => {
        void refreshSharedAreaClaims();
      }
    );
    const refreshTimer = setInterval(() => {
      void refreshSharedAreaClaims();
    }, SHARED_AREA_CLAIM_REFRESH_MS);

    return () => {
      cancelled = true;
      unsubscribeAreaClaimChanges();
      clearInterval(refreshTimer);
    };
  }, [collaborationAuth.isSignedIn, collaborationAuth.user?.id, singleProject?.sharedProjectId]);

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
    await saveProjectMetadataOnly(project);
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

  async function handleAddArea(submittedForms?: AreaFormValue[]) {
    const targetProject =
      projects.find((project) => project.id === areaTargetProjectId && !project.deletedAt) ??
      singleProject;
    if (!targetProject) return;

    const projectForAreaCreation = targetProject;

    const areaForms = submittedForms ?? getAreaCreationForms(newAreaForm, buildFacadeLevelOptions(projectForAreaCreation));
    if (areaForms.length === 0) return;
    upsertFacadeElevationDrawing(projectForAreaCreation, newAreaForm.pendingElevationDrawing);

    const createdAreas = areaForms.map(
      (areaForm, index) => {
        const areaName = buildAreaName(areaForm);
        if (!areaName) return null;

        const area = createArea(projectForAreaCreation.id, areaName, projectForAreaCreation.areas.length + index, {
          areaTypeKey: areaForm.areaTypeKey,
          unitType: areaForm.unitType,
          customAreaName: areaForm.customAreaName,
          areaNumber: areaForm.areaNumber,
          facadeLevel: areaForm.facadeLevel,
          elevationDrawingId: areaForm.areaTypeKey === 'facade' ? areaForm.elevationDrawingId : '',
        });
        area.areaTypeKey = areaForm.areaTypeKey;
        area.unitType = areaForm.unitType || undefined;
        area.customAreaName = areaForm.customAreaName.trim() || undefined;
        area.areaNumber = areaForm.areaNumber.trim() || undefined;
        area.facadeLevel = areaForm.facadeLevel.trim() || undefined;
        area.elevationDrawingId =
          areaForm.areaTypeKey === 'facade' ? areaForm.elevationDrawingId || undefined : undefined;
        applyTemplateToArea(area);
        return area;
      }
    ).filter((area): area is Area => area !== null);
    if (createdAreas.length === 0) return;

    projectForAreaCreation.areas.push(...createdAreas);
    if (newAreaForm.pendingElevationDrawing) {
      await saveProject(projectForAreaCreation);
    } else {
      await saveProjectMetadataOnly(projectForAreaCreation);
    }
    if (projectForAreaCreation.sharedProjectId && collaborationAuth.isSignedIn && collaborationAuth.user?.id) {
      for (const area of createdAreas) {
        claimAreaOpenInBackground(projectForAreaCreation, area.id);
      }
    }
    await queueSharedProjectAreaSyncs(
      projectForAreaCreation,
      createdAreas.map((area) => area.id)
    ).catch((error) => {
      console.info('New shared areas remain local until they can be queued:', error);
    });
    scheduleSync(projectForAreaCreation.id);
    const nextRecentAreaTypeKeys = [
      newAreaForm.areaTypeKey,
      ...recentAreaTypeKeys.filter((key) => key !== newAreaForm.areaTypeKey),
    ].slice(0, 8);
    setRecentAreaTypeKeys(nextRecentAreaTypeKeys);
    writeLocalStorage(RECENT_AREA_TYPES_STORAGE_KEY, JSON.stringify(nextRecentAreaTypeKeys));
    setNewAreaForm(getDefaultAreaFormValue());
    setAreaTargetProjectId(null);
    setShowAddArea(false);
    setProjects((prev) =>
      prev.map((project) =>
        project.id === projectForAreaCreation.id
          ? { ...projectForAreaCreation, areas: [...projectForAreaCreation.areas] }
          : project
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

  const enterAreaSelectionMode = useCallback((areaId: string) => {
    setShowTrash(false);
    setDeleteMode(true);
    setExportMode(false);
    setExportScope('selected-projects');
    setSelectedProjectIds(new Set());
    setSelectedAreaIds(new Set([areaId]));
  }, []);

  async function handleDeleteSelectedProjects() {
    if (selectedProjectIds.size === 0) return;
    if (showTrash) {
      const projectsToDelete = trashedProjects.filter((project) => selectedProjectIds.has(project.id));
      if (projectsToDelete.length === 0) return;

      for (const project of projectsToDelete) {
        markProjectDeleted(project.id);
        await deleteProject(project.id);
        removeCachedProjectPreview(project.id);
      }
      scheduleSync(undefined, { fullSync: true });
      setProjects((prev) => prev.filter((project) => !selectedProjectIds.has(project.id)));
    } else {
      const projectsToTrash = activeProjects.filter((project) => selectedProjectIds.has(project.id));
      if (projectsToTrash.length === 0) return;

      for (const project of projectsToTrash) {
        project.deletedAt = new Date();
        await saveProjectMetadataOnly(project);
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
    await saveProjectMetadataOnly(project);
    scheduleSyncRef.current(project.id);
    setShowProjectMenuId(null);
    setProjects((prev) =>
      prev.map((entry) => (entry.id === project.id ? { ...project, areas: [...project.areas] } : entry))
    );
  }, []);

  async function handleDeleteSelectedAreas() {
    if (!singleProject) return;
    if (selectedAreaIds.size === 0) {
      setDeleteMode(false);
      setExportScope('selected-projects');
      return;
    }
    const deletedAreaIds = [...selectedAreaIds];
    const now = new Date();
    singleProject.areas.forEach((area) => {
      if (selectedAreaIds.has(area.id)) {
        area.deletedAt = now;
        area.updatedAt = now;
      }
    });
    await saveProjectMetadataOnly(singleProject);
    await queueSharedProjectAreaSyncs(singleProject, deletedAreaIds).catch((error) => {
      console.info('Deleted shared areas remain local until they can be queued:', error);
    });
    scheduleSync(singleProject.id);
    setSelectedAreaIds(new Set());
    setDeleteMode(false);
    setExportScope('selected-projects');
    setActionSheet(null);
    await loadProjects();
  }

  async function handleExportSelectedAreas(destination: ExportDestination) {
    if (!singleProject || exportingSelectedAreas || selectedAreaIds.size === 0) return;
    setExportingSelectedAreas(true);
    setActionSheet(null);
    try {
      const selectedIds = new Set(selectedAreaIds);
      const selectedSortedAreaIds = sortedAreas
        .filter((area) => selectedIds.has(area.id))
        .map((area) => area.id);
      const shouldSaveToDrive = destination === 'onedrive';
      const token = shouldSaveToDrive ? await ensureAccessToken() : null;
      if (shouldSaveToDrive && !token) {
        signIn();
        return;
      }
      const fullProject = token
        ? await hydrateProjectMediaFromOneDrive(token, singleProject.id)
        : await getProject(singleProject.id);
      const projectForExport = fullProject ?? singleProject;
      const { generateProjectPDF, downloadPDF } = await import('@/lib/pdfExport');
      const blob = await generateProjectPDF(projectForExport, 'issues', { areaIds: selectedSortedAreaIds });
      if (destination === 'local') {
        const filename = `${sanitizeExportNamePart(singleProject.projectName)}_Selected_Areas_${formatDateForExport()}.pdf`;
        downloadPDF(blob, filename);
      }
      if (token && shouldSaveToDrive) {
        const projectFolderName = getOneDriveProjectFolderName(singleProject);
        const filename = await getNextOneDriveExportFilename(
          token,
          [`${singleProject.projectName}_Selected_Areas_Issues`],
          new Date(),
          projectFolderName
        );
        await uploadPdfToOneDrive(token, filename, blob, projectFolderName);
      }
      setSelectedAreaIds(new Set());
      setDeleteMode(false);
      setExportMode(false);
    } catch (error) {
      console.error('Failed to export selected areas:', error);
      showMessage('Failed to export selected areas. Please try again.');
    } finally {
      setExportingSelectedAreas(false);
    }
  }

  async function handleRestoreProject(projectId: string) {
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) return;
    delete project.deletedAt;
    unmarkProjectDeleted(project.id);
    await saveProjectMetadataOnly(project);
    scheduleSync(project.id, { fullSync: true });
    setProjects((prev) =>
      prev.map((entry) => (entry.id === project.id ? { ...project, areas: [...project.areas] } : entry))
    );
  }

  async function handleRestoreArea(projectId: string, areaId: string) {
    const project = projects.find((entry) => entry.id === projectId);
    const area = project?.areas.find((entry) => entry.id === areaId);
    if (!project || !area) return;

    delete area.deletedAt;
    area.updatedAt = new Date();
    await saveProjectMetadataOnly(project);
    await queueSharedProjectAreaSyncs(project, [area.id]).catch((error) => {
      console.info('Restored shared area remains local until it can be queued:', error);
    });
    scheduleSync(project.id);
    setProjects((prev) =>
      prev.map((entry) => (entry.id === project.id ? { ...project, areas: [...project.areas] } : entry))
    );
  }

  function handleExportSelectedConfirm() {
    if (exportingSelected || exportingSelectedToDrive || selectedProjectIds.size === 0) return;
    if (singleProjectMainView && selectedAreaIds.size === 0) return;
    setExportScope('selected-projects');
    setActionSheet('export');
  }

  async function loadProjectsForExport(token?: string | null) {
    const selectedAreas = new Set(selectedAreaIds);
    const shouldFilterAreas = singleProjectMainView && exportScope === 'selected-areas';
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
      areas: [...project.areas]
        .filter((area) => !shouldFilterAreas || selectedAreas.has(area.id))
        .sort(compareAreaNames),
    }));
  }

  async function handleExportSelected(destination: ExportDestination) {
    if (exportingSelected || exportingSelectedToDrive || selectedProjectIds.size === 0) return;
    setActionSheet(null);
    const shouldSaveLocal = destination === 'local';
    const shouldSaveToDrive = destination === 'onedrive';
    setExportingSelected(shouldSaveLocal);
    setExportingSelectedToDrive(shouldSaveToDrive);
    try {
      const token = shouldSaveToDrive
        ? await ensureAccessToken()
        : isSignedIn
          ? await ensureAccessToken().catch(() => null)
          : null;
      if (shouldSaveToDrive && !token) {
        signIn();
        return;
      }
      const projectsToExport = [...sortedProjects]
        .filter((project) => selectedProjectIds.has(project.id))
        .sort((a, b) => a.projectName.localeCompare(b.projectName));
      const projectsForExport = await loadProjectsForExport(token);
      const { generateMultiProjectPDF, downloadPDF } = await import('@/lib/pdfExport');
      const blob = await generateMultiProjectPDF(projectsForExport, exportType);
      if (shouldSaveLocal) {
        const filename = exportType === 'issues' ? 'UAI_PUNCHLIST_APP_Issues_Report.pdf' : 'UAI_PUNCHLIST_APP_Full_Report.pdf';
        downloadPDF(blob, filename);
      }
      if (token && shouldSaveToDrive) {
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
      }
    } catch (error) {
      console.error('Failed to export selected projects:', error);
      showMessage('Failed to export selected projects. Please try again.');
    } finally {
      setExportingSelected(false);
      setExportingSelectedToDrive(false);
      setExportMode(false);
      setSelectedProjectIds(new Set());
    }
  }

  async function handleEditProject(updates: Partial<Project>) {
    if (!editingProject) return;
    const updatedProject = { ...editingProject, ...updates, areas: [...editingProject.areas] };
    await saveAndQueueSharedProjectMetadataSync(updatedProject);
    scheduleSync(updatedProject.id);
    setProjects((prev) =>
      prev.map((project) =>
        project.id === updatedProject.id ? updatedProject : project
      )
    );
    setEditingProject(null);
  }

  const handleShareProject = useCallback(async (project: Project) => {
    if (!collaborationAuth.isSignedIn || !collaborationAuth.user) {
      showMessage('Enable shared projects before sharing this project.');
      return;
    }

    if (!accountEmail) {
      showMessage('Sign in with an allowed Microsoft account before sharing this project.');
      return;
    }

    try {
      const sharedProjectId = await createSharedProjectFromLocalProject(
        project,
        accountEmail,
        accountName
      );
      const linkedAt = new Date();
      const nextProject = {
        ...clearDetachedSharedProjectMetadata(project),
        sharedProjectId,
        sharedProjectLinkedAt: linkedAt,
        areas: [...project.areas],
      };
      await saveProject(nextProject);
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === project.id
            ? nextProject
            : entry
        )
      );
      showMessage('Project sharing is enabled. You are the owner of this shared project.');
    } catch (error) {
      console.error('Failed to share project:', error);
      showMessage(getCollaborationErrorMessage(error));
    }
  }, [accountEmail, accountName, collaborationAuth.isSignedIn, collaborationAuth.user, showMessage]);

  const handleCreateJoinCode = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share this project before creating an invite code.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before creating an invite code.');
      return;
    }

    setCreatingJoinCode(true);
    try {
      const result = await generateSharedProjectJoinCode(project.sharedProjectId);
      setSharedProjectCode({
        projectName: project.projectName,
        code: result.joinCode,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      console.error('Failed to create shared project code:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to create invite code. Please try again.'));
    } finally {
      setCreatingJoinCode(false);
    }
  }, [collaborationAuth.isSignedIn, showMessage]);

  const handleShowSharedMembers = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share this project before viewing shared members.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before viewing shared members.');
      return;
    }

    setLoadingSharedMembers(true);
    setSharedMembersProject(project);
    setSharedMembers([]);
    try {
      const members = await getSharedProjectMembers(project.sharedProjectId);
      if (members.length === 0) {
        setSharedMembers([]);
        return;
      }

      setSharedMembers(members);
    } catch (error) {
      console.error('Failed to load shared project members:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to load shared project members. Please try again.'));
      setSharedMembersProject(null);
    } finally {
      setLoadingSharedMembers(false);
    }
  }, [collaborationAuth.isSignedIn, showMessage]);

  async function addSharedProjectToDevice(sharedProjectId: string, projectName: string) {
    const existingProject = projects.find((project) => project.sharedProjectId === sharedProjectId);
    if (existingProject) {
      return { project: existingProject, alreadyLocal: true };
    }

    const detachedProject = findDetachedSharedProject(projects, sharedProjectId);
    const project = detachedProject
      ? relinkDetachedSharedProject(detachedProject, sharedProjectId)
      : createProject(projectName);
    if (!detachedProject) {
      project.sharedProjectId = sharedProjectId;
      project.sharedProjectLinkedAt = new Date();
    }

    let projectToSave = project;
    let pulledSnapshot = false;
    try {
      const snapshot = await getSharedProjectSnapshot(project);
      const merge = detachedProject
        ? await mergeSharedProjectAreasWithPendingMetadata(project, snapshot.project)
        : null;
      projectToSave = detachedProject
        ? clearDetachedSharedProjectMetadata(
            merge!.resolutionProject
          )
        : clearDetachedSharedProjectMetadata(snapshot.project);
      pulledSnapshot = true;
    } catch (error) {
      console.info('Joined shared project before shared data was published:', error);
    }

    await saveProject(projectToSave);
    setProjects((prev) => detachedProject
      ? prev.map((entry) => entry.id === detachedProject.id ? projectToSave : entry)
      : [...prev, projectToSave]
    );
    return {
      project: projectToSave,
      alreadyLocal: false,
      pulledSnapshot,
      reusedDetached: !!detachedProject,
    };
  }

  async function handleJoinSharedProject() {
    const code = joinProjectCode.trim();
    if (!code || joiningProject) return;

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before joining a project.');
      return;
    }

    if (!accountEmail) {
      showMessage('Sign in with an allowed Microsoft account before joining a shared project.');
      return;
    }

    setJoiningProject(true);
    try {
      const result = await joinSharedProjectByCode(code, accountEmail, accountName);
      const { alreadyLocal, pulledSnapshot, reusedDetached } = await addSharedProjectToDevice(
        result.sharedProjectId,
        result.projectName
      );
      setShowJoinProject(false);
      setJoinProjectCode('');
      if (alreadyLocal) {
        showMessage(`You already joined "${result.projectName}".`);
      } else if (reusedDetached && pulledSnapshot) {
        showMessage(`Rejoined "${result.projectName}" using the existing local copy and merged the latest shared data.`);
      } else if (reusedDetached) {
        showMessage(`Rejoined "${result.projectName}" using the existing local copy. No shared data has been published yet.`);
      } else if (pulledSnapshot) {
        showMessage(`Joined "${result.projectName}" and pulled the latest shared data.`);
      } else {
        showMessage(`Joined "${result.projectName}". No shared data has been published yet.`);
      }
    } catch (error) {
      console.error('Failed to join shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to join shared project. Please try again.'));
    } finally {
      setJoiningProject(false);
    }
  }

  async function handleShowMySharedProjects() {
    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before viewing your shared projects.');
      return;
    }

    setShowMySharedProjects(true);
    setLoadingMySharedProjects(true);
    try {
      const entries = await listMySharedProjects();
      setMySharedProjects(entries);
    } catch (error) {
      console.error('Failed to load shared projects:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to load your shared projects. Please try again.'));
      setShowMySharedProjects(false);
    } finally {
      setLoadingMySharedProjects(false);
    }
  }

  async function handleRunCollaborationHealthCheck() {
    setShowCollaborationHealth(true);
    setRunningCollaborationHealth(true);
    try {
      const report = await runCollaborationHealthCheck();
      setCollaborationHealthReport(report);
    } catch (error) {
      console.error('Failed to run collaboration health check:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to run collaboration health check.'));
    } finally {
      setRunningCollaborationHealth(false);
    }
  }

  async function handleAddSharedProjectFromDirectory(entry: CollaborationSharedProjectDirectoryEntry) {
    if (addingSharedProjectId) return;

    setAddingSharedProjectId(entry.projectId);
    try {
      const { alreadyLocal, pulledSnapshot } = await addSharedProjectToDevice(entry.projectId, entry.projectName);
      if (alreadyLocal) {
        showMessage(`"${entry.projectName}" is already on this device.`);
      } else if (pulledSnapshot) {
        showMessage(`"${entry.projectName}" was added to this device with the latest shared data.`);
      } else {
        showMessage(`"${entry.projectName}" was added to this device. No shared data has been published yet.`);
      }
    } catch (error) {
      console.error('Failed to add shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to add this shared project. Please try again.'));
    } finally {
      setAddingSharedProjectId(null);
    }
  }

  function handleDirectoryDisconnect(
    entry: CollaborationSharedProjectDirectoryEntry,
    localProject?: Project
  ) {
    const isOwner = entry.ownerUserId === collaborationAuth.user?.id;
    if (localProject) {
      setShowMySharedProjects(false);
      setMySharedProjects([]);
      handleDisconnectSharedProject(localProject, isOwner);
      return;
    }
    setDirectoryDisconnectConfirm(entry);
  }

  async function confirmDirectoryDisconnect() {
    const entry = directoryDisconnectConfirm;
    if (!entry || disconnectingDirectoryProjectId) return;

    setDisconnectingDirectoryProjectId(entry.projectId);
    try {
      const result = await disconnectSharedProject(entry.projectId);
      setMySharedProjects((current) => current.filter((item) => item.projectId !== entry.projectId));
      setDirectoryDisconnectConfirm(null);
      showMessage(
        result.action === 'archived'
          ? `Sharing stopped for "${entry.projectName}". It is no longer available to project members.`
          : `You left "${entry.projectName}".`
      );
    } catch (error) {
      console.error('Failed to leave shared project from directory:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to leave this shared project. Please try again.'));
    } finally {
      setDisconnectingDirectoryProjectId(null);
    }
  }

  const handlePublishSharedProject = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share this project before publishing shared data.');
      return;
    }

    if (!collaborationAuth.isSignedIn || !collaborationAuth.user) {
      showMessage('Enable shared projects before publishing shared data.');
      return;
    }

    setSharedTransferStatus('publishing');
    let fullProject: Project | undefined;
    try {
      fullProject = await getProject(project.id);
      if (!fullProject) {
        throw new Error('Could not load this project.');
      }

      const loadedProject = fullProject;
      loadedProject.sharedProjectId = project.sharedProjectId;
      loadedProject.sharedProjectLinkedAt = project.sharedProjectLinkedAt;
      const result = await publishSharedProjectSnapshot(loadedProject, collaborationAuth.user.id);
      await saveProjectMetadataOnly(loadedProject, { touch: false });
      clearSharedUpdateAvailable(loadedProject.id);
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === loadedProject.id
            ? { ...entry, sharedSnapshotPublishedAt: loadedProject.sharedSnapshotPublishedAt }
            : entry
        )
      );
      showMessage(`Shared data published at ${new Date(result.publishedAt).toLocaleTimeString()}.`);
    } catch (error) {
      if (fullProject && isSharedProjectPublishConflictError(error)) {
        console.info('Publish blocked because shared data is newer:', error);
        markSharedUpdateAvailable(fullProject.id);
        try {
          setPendingPull(await getPendingSharedPullState(fullProject, 'publish-conflict'));
        } catch (reviewError) {
          console.error('Failed to load shared data for publish conflict review:', reviewError);
          showMessage('Shared data changed before publishing. Pull shared data before publishing again.');
        }
        return;
      }

      console.error('Failed to publish shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to publish shared data. Please try again.'));
    } finally {
      setSharedTransferStatus(null);
    }
  }, [
    clearSharedUpdateAvailable,
    collaborationAuth.isSignedIn,
    collaborationAuth.user,
    markSharedUpdateAvailable,
    setSharedTransferStatus,
    showMessage,
  ]);

  const handlePullSharedProject = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share or join this project before pulling shared data.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before pulling shared data.');
      return;
    }

    setSharedTransferStatus('pulling');
    try {
      const fullProject = await getProject(project.id);
      if (!fullProject) {
        throw new Error('Could not load this project.');
      }

      fullProject.sharedProjectId = project.sharedProjectId;
      fullProject.sharedProjectLinkedAt = project.sharedProjectLinkedAt;
      const metadata = await getSharedProjectSnapshotMetadata(project.sharedProjectId);
      if (!metadata) {
        throw new Error('No shared data has been published for this project yet.');
      }
      if (!isSharedSnapshotNewer(fullProject, metadata.publishedAt)) {
        showMessage('Shared data is already up to date. Your local changes have not been replaced.');
        return;
      }


      const result = await getSharedProjectSnapshot(fullProject);
      const hasNewerLocalChanges = hasNewerLocalChangesThanSharedSnapshot(fullProject, result.publishedAt);
      const merge = await mergeSharedProjectAreasWithPendingMetadata(fullProject, result.project);
      if (hasNewerLocalChanges || merge.preservedLocalProjectMetadata) {
        setPendingPull({
          localProject: fullProject,
          sharedProject: result.project,
          ...merge,
          publishedAt: result.publishedAt,
          hasNewerLocalChanges,
          reason: 'manual-pull',
        });
        return;
      }

      if (!isSharedSnapshotNewer(fullProject, result.publishedAt)) {
        showMessage('Shared data is already up to date.');
        return;
      }

      await saveProjectPreserveTimestamps(result.project);
      clearSharedUpdateAvailable(fullProject.id);
      cacheProjectPreview(result.project);
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === fullProject.id
            ? { ...result.project, areas: [...result.project.areas] }
            : entry
        )
      );
      showMessage(`Shared data pulled from ${new Date(result.publishedAt).toLocaleString()}.`);
    } catch (error) {
      console.error('Failed to pull shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to pull shared data. Please try again.'));
    } finally {
      setSharedTransferStatus(null);
    }
  }, [clearSharedUpdateAvailable, collaborationAuth.isSignedIn, setSharedTransferStatus, showMessage]);

  async function confirmPullSharedProject() {
    if (!pendingPull) return;

    const pullState = pendingPull;
    setPendingPull(null);
    setSharedTransferStatus('pulling');
    try {
      await captureSharedProjectBackup(
        pullState.localProject,
        'before_pull',
        'Local data before pulling shared data.'
      );

      await saveProjectPreserveTimestamps(pullState.resolutionProject);
      if (pullState.preservedLocalProjectMetadata) {
        await saveAndQueueSharedProjectMetadataSync(pullState.resolutionProject);
      }
      clearSharedUpdateAvailable(pullState.localProject.id);
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === pullState.localProject.id
            ? { ...pullState.resolutionProject, areas: [...pullState.resolutionProject.areas] }
            : entry
        )
      );
      showMessage(formatPendingSharedPullSuccessMessage(pullState));
    } catch (error) {
      console.error('Failed to pull shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to pull shared data. Please try again.'));
    } finally {
      setSharedTransferStatus(null);
    }
  }

  const handleShowSharedBackups = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share this project before viewing shared backups.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before viewing shared backups.');
      return;
    }

    setBackupProject(project);
    setLoadingSharedBackups(true);
    setSharedBackups([]);
    try {
      const backups = await listSharedProjectBackups(project.sharedProjectId);
      setSharedBackups(backups);
    } catch (error) {
      console.error('Failed to load shared backups:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to load shared backups. Please try again.'));
      setBackupProject(null);
    } finally {
      setLoadingSharedBackups(false);
    }
  }, [collaborationAuth.isSignedIn, showMessage]);

  async function handleRestoreSharedBackup(backup: CollaborationSnapshotBackup, publishAfterRestore = false) {
    setBackupRestoreConfirm({ backup, publishAfterRestore });
  }

  async function confirmRestoreSharedBackup(backup: CollaborationSnapshotBackup, publishAfterRestore: boolean) {
    if (!backupProject || restoringBackupId) return;
    if (publishAfterRestore && !collaborationAuth.user) {
      showMessage('Enable shared projects before restoring and publishing a backup.');
      return;
    }

    setBackupRestoreConfirm(null);
    setRestoringBackupId(backup.id);
    try {
      const fullProject = await getProject(backupProject.id);
      if (!fullProject) {
        throw new Error('Could not load this project.');
      }

      fullProject.sharedProjectId = backupProject.sharedProjectId;
      fullProject.sharedProjectLinkedAt = backupProject.sharedProjectLinkedAt;
      await captureSharedProjectBackup(
        fullProject,
        'restore',
        'Local data before restoring a shared backup.'
      );

      const result = await getSharedProjectBackupSnapshot(fullProject, backup.id);
      await clearPendingSharedSyncsForProject(fullProject.id);
      await saveProjectPreserveTimestamps(result.project);
      let publishedAt: string | null = null;
      if (publishAfterRestore && collaborationAuth.user) {
        await syncSharedProjectMetadataNow(result.project);
        const publishResult = await publishSharedProjectSnapshot(result.project, collaborationAuth.user.id);
        publishedAt = publishResult.publishedAt;
        await saveProjectMetadataOnly(result.project, { touch: false });
        clearSharedUpdateAvailable(result.project.id);
      }
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === backupProject.id
            ? { ...result.project, areas: [...result.project.areas] }
            : entry
        )
      );
      setBackupProject({ ...result.project, areas: [...result.project.areas] });
      showMessage(
        publishedAt
          ? `Backup restored and published as the team version at ${new Date(publishedAt).toLocaleTimeString()}.`
          : 'Backup restored on this device. Publish shared data if you want this restored version to become the team version.'
      );
    } catch (error) {
      console.error('Failed to restore shared backup:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to restore this backup. Please try again.'));
    } finally {
      setRestoringBackupId(null);
    }
  }

  function handleDisconnectSharedProject(project: Project, isOwner: boolean) {
    if (!project.sharedProjectId) {
      showMessage('This project is not currently shared.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before stopping sharing for this project.');
      return;
    }

    setDisconnectSharedProjectLocalOnly(false);
    setDisconnectSharedProjectIsOwner(isOwner);
    setDisconnectSharedProjectConfirm(project);
  }

  function handleUnlinkInactiveSharedProject(project: Project) {
    if (!project.sharedProjectId) {
      showMessage('This local project is not linked to shared data.');
      return;
    }

    setDisconnectSharedProjectLocalOnly(true);
    setDisconnectSharedProjectIsOwner(false);
    setDisconnectSharedProjectConfirm(project);
  }

  async function confirmDisconnectSharedProject() {
    const targetProject = disconnectSharedProjectConfirm;
    const sharedProjectId = targetProject?.sharedProjectId;
    if (!targetProject || !sharedProjectId || disconnectingSharedProject) return;

    setDisconnectingSharedProject(true);
    try {
      const fullProject = await getProject(targetProject.id);
      if (!fullProject) {
        throw new Error('Could not load this project.');
      }

      fullProject.sharedProjectId = targetProject.sharedProjectId;
      fullProject.sharedProjectLinkedAt = targetProject.sharedProjectLinkedAt;
      let disconnectAction: 'archived' | 'left' | 'local-only' = 'local-only';
      if (!disconnectSharedProjectLocalOnly) {
        await captureSharedProjectBackup(
          fullProject,
          'manual',
          'Local data before stopping shared project access.'
        );
        const result = await disconnectSharedProject(sharedProjectId);
        disconnectAction = result.action;
      }
      const localProject = detachLocalSharedProject(fullProject);
      await clearPendingSharedSyncsForProject(localProject.id);
      await saveProject(localProject);
      scheduleSync(localProject.id);
      clearSharedUpdateAvailable(localProject.id);
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === localProject.id ? { ...localProject, areas: [...localProject.areas] } : entry
        )
      );
      setDisconnectSharedProjectConfirm(null);
      showMessage(
        disconnectAction === 'archived'
          ? 'Sharing has stopped for this project. Your local project data is still on this device.'
          : disconnectAction === 'left'
            ? 'You left this shared project. Your local project data is still on this device.'
            : 'This project is now a local-only copy. Your inspection data is still on this device.'
      );
    } catch (error) {
      console.error('Failed to stop sharing project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to stop sharing this project. Please try again.'));
    } finally {
      setDisconnectingSharedProject(false);
    }
  }

  const handleTransferSharedProjectOwnership = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share this project before transferring ownership.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before transferring ownership.');
      return;
    }

    setOwnershipTransferProject(project);
  }, [collaborationAuth.isSignedIn, showMessage]);

  async function confirmTransferSharedProjectOwnership(newOwnerEmailValue: string) {
    const project = ownershipTransferProject;
    if (!project?.sharedProjectId) return;

    const newOwnerEmail = newOwnerEmailValue.trim().toLowerCase();
    if (!newOwnerEmail) return;

    setOwnershipTransferProject(null);
    setTransferringSharedProject(true);
    try {
      const result = await transferSharedProjectOwnership(project.sharedProjectId, newOwnerEmail);
      showMessage(`Ownership transferred to ${result.ownerEmail}.`);
    } catch (error) {
      console.error('Failed to transfer shared project ownership:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to transfer ownership. Please try again.'));
    } finally {
      setTransferringSharedProject(false);
    }
  }

  async function handleDeleteEditingProject() {
    if (!editingProject) return;
    const projectToDelete = editingProject;
    setDeleteProjectConfirm(projectToDelete);
  }

  async function confirmDeleteEditingProject(projectToDelete: Project) {
    setEditingProject(null);
    setDeleteProjectConfirm(null);
    await handleTrashProject(projectToDelete);
  }

  function cancelSelectionMode() {
    setDeleteMode(false);
    setExportMode(false);
    setActionSheet(null);
    setExportScope('selected-projects');
    setSelectedProjectIds(new Set());
    setSelectedAreaIds(new Set());
  }

  homeMenuActionHandlerRef.current = (event: Event) => {
    const customEvent = event as CustomEvent<{
      action: string;
      sort?: SortOption;
      isSharedProjectOwner?: boolean;
    }>;
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
      setExportScope('selected-projects');
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
      setExportMode(false);
      setSelectedAreaIds(new Set());
      setSelectedProjectIds(new Set([singleProject.id]));
      setExportScope('selected-projects');
      setActionSheet('export-scope');
      return;
    }

    if (detail.action === 'share-project' && singleProject) {
      void handleShareProject(singleProject);
      return;
    }

    if (detail.action === 'invite-code' && singleProject) {
      void handleCreateJoinCode(singleProject);
      return;
    }

    if (detail.action === 'shared-members' && singleProject) {
      void handleShowSharedMembers(singleProject);
      return;
    }

    if (detail.action === 'my-shared-projects') {
      void handleShowMySharedProjects();
      return;
    }

    if (detail.action === 'collaboration-health') {
      void handleRunCollaborationHealthCheck();
      return;
    }

    if (detail.action === 'join-shared-project') {
      setShowJoinProject(true);
      return;
    }

    if (detail.action === 'publish-shared-project' && singleProject) {
      void handlePublishSharedProject(singleProject);
      return;
    }

    if (detail.action === 'pull-shared-project' && singleProject) {
      void handlePullSharedProject(singleProject);
      return;
    }

    if (detail.action === 'shared-backups' && singleProject) {
      void handleShowSharedBackups(singleProject);
      return;
    }

    if (detail.action === 'disconnect-shared-project' && singleProject) {
      handleDisconnectSharedProject(singleProject, detail.isSharedProjectOwner === true);
      return;
    }

    if (detail.action === 'unlink-inactive-shared-project' && singleProject) {
      handleUnlinkInactiveSharedProject(singleProject);
      return;
    }

    if (detail.action === 'transfer-shared-project' && singleProject) {
      void handleTransferSharedProjectOwnership(singleProject);
      return;
    }

    if (detail.action === 'auth') {
      if (isSignedIn) signOut();
      else signIn();
    }
  };

  useEffect(() => {
    function handleHomeMenuAction(event: Event) {
      homeMenuActionHandlerRef.current?.(event);
    }

    window.addEventListener('punchlist-home-menu-action', handleHomeMenuAction as EventListener);
    return () => {
      window.removeEventListener('punchlist-home-menu-action', handleHomeMenuAction as EventListener);
    };
  }, []);

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
          isSharedProject: !!singleProject?.sharedProjectId,
          sharedProjectId: singleProject?.sharedProjectId,
          isCreatingJoinCode: creatingJoinCode,
          isLoadingSharedMembers: loadingSharedMembers,
          isDisconnectingSharedProject: disconnectingSharedProject,
          isTransferringSharedProject: transferringSharedProject,
        },
      })
    );
  }, [
    creatingJoinCode,
    deleteMode,
    disconnectingSharedProject,
    loadingSharedMembers,
    sortOption,
    showTrash,
    singleProject,
    transferringSharedProject,
  ]);

  function toggleTrashView() {
    setShowTrash((current) => {
      const next = !current;
      if (next || current) {
        cancelSelectionMode();
      }
      return next;
    });
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
            <div className="page-header-surface mx-auto flex min-h-[4.9rem] w-full max-w-6xl items-center px-4 py-3 sm:px-5">
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
                      setExportScope('selected-areas');
                      setActionSheet('export');
                    }}
                    disabled={exportingSelectedAreas || selectedAreaIds.size === 0}
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-black/5 bg-white/70 text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08] disabled:opacity-40"
                    aria-label="Export selected areas"
                  >
                    {exportingSelectedAreas ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FileDown className="w-4 h-4" />
                    )}
                  </button>
                  {exportScope !== 'selected-areas' && (
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
                  )}
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
          <div className="text-gray-700 dark:text-gray-200">Sync needs review:</div>
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
        className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+6.5rem)] sm:px-5"
      >
        {showTrash ? (
          trashedProjects.length === 0 && trashedAreaEntries.length === 0 ? (
            <div className="empty-state-card mx-auto max-w-md rounded-[2rem] p-10 text-center">
              <Trash2 className="mx-auto mb-4 h-14 w-14 text-gray-300 dark:text-gray-600" />
              <h2 className="mb-2 text-lg font-medium text-gray-900 dark:text-white">Trash Is Empty</h2>
              <p className="text-gray-500 dark:text-gray-400">Deleted projects and areas stay here so they can be restored.</p>
            </div>
          ) : (
            <div className="list-stack mx-auto w-full max-w-6xl">
              {trashedProjects.length > 0 && (
                <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
                  Deleted Projects
                </div>
              )}
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
              {trashedAreaEntries.length > 0 && (
                <div className={`${trashedProjects.length > 0 ? 'pt-2' : ''} px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400`}>
                  Deleted Areas
                </div>
              )}
              {trashedAreaEntries.map(({ project, area, deletedAt }) => (
                <div
                  key={`${project.id}:${area.id}`}
                  className="card-surface-subtle rounded-[1.5rem] p-4 transition-all sm:p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="truncate font-medium text-gray-900 dark:text-white">{area.name}</div>
                        <span className="shrink-0 rounded-full bg-black/[0.04] px-2.5 py-1 text-[11px] font-semibold text-gray-500 dark:bg-white/[0.08] dark:text-gray-400">
                          Area
                        </span>
                      </div>
                      <div className="mt-1 truncate text-sm font-medium text-gray-700 dark:text-gray-200">
                        Project: {project.projectName}
                      </div>
                      {project.address && (
                        <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                          {project.address}
                        </div>
                      )}
                      <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                        Deleted {deletedAt.toLocaleDateString()}
                      </div>
                    </div>
                    {!deleteMode && (
                      <button
                        onClick={() => void handleRestoreArea(project.id, area.id)}
                        onContextMenu={(event) => event.preventDefault()}
                        onPointerDown={(event) => event.stopPropagation()}
                        className="segmented-chip shrink-0 px-3 py-2 text-sm"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              ))}
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
                    project={singleProject}
                    area={area}
                    displayName={areaDisplayNames.get(area.id) ?? area.name}
                    metric={metric}
                    claimStatus={sharedAreaClaims.get(area.id)}
                    deleteMode={deleteMode}
                    isSelected={isSelected}
                    onToggleSelection={toggleAreaSelection}
                    onLongPressSelect={enterAreaSelectionMode}
                    onBlockedByClaim={(message) => showMessage(message, 'Area in use')}
                    onPrimeOpen={primeAreaOpen}
                    onOpenArea={claimAreaOpenInBackground}
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
                    onPrimeOpen={primeProjectOpen}
                  />
                );
              })
            )}
          </div>
        )}
      </main>

      {!showTrash && !selectionMode && (
        <div className="floating-action-rail pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+1.25rem)] z-20">
          {singleProjectMainView ? (
            <button
              onClick={() => {
                setAreaTargetProjectId(singleProject.id);
                setShowAddArea(true);
              }}
              className="floating-action pointer-events-auto inline-flex h-14 w-[7.5rem] items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition hover:translate-y-[-1px]"
              aria-label="Add area"
              title="Add area"
            >
              <Plus className="h-4 w-4" />
              Area
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

      {messageDialog && (
        <AppMessageDialog
          title={messageDialog.title}
          message={messageDialog.message}
          onClose={() => setMessageDialog(null)}
        />
      )}

      {backupRestoreConfirm && (
        <AppConfirmDialog
          title={backupRestoreConfirm.publishAfterRestore ? 'Restore and Publish' : 'Restore Backup'}
          message={
            backupRestoreConfirm.publishAfterRestore
              ? `Restore backup from ${backupRestoreConfirm.backup.capturedAt.toLocaleString()}, then publish it as the current team version?\n\nThis will replace the shared version after first saving a backup of your current local data.`
              : `Restore backup from ${backupRestoreConfirm.backup.capturedAt.toLocaleString()} to this device?\n\nPublish shared data after restoring if this should become the team version.`
          }
          confirmLabel={backupRestoreConfirm.publishAfterRestore ? 'Restore + Publish' : 'Restore'}
          danger={backupRestoreConfirm.publishAfterRestore}
          onCancel={() => setBackupRestoreConfirm(null)}
          onConfirm={() => void confirmRestoreSharedBackup(backupRestoreConfirm.backup, backupRestoreConfirm.publishAfterRestore)}
        />
      )}

      {pendingPull && (
        <AppConfirmDialog
          title={pendingPull.reason === 'manual-pull' ? 'Pull Shared Data' : 'Review Shared Changes'}
          message={formatPendingSharedPullMessage(pendingPull)}
          confirmLabel="Back Up + Merge"
          danger={pendingPull.hasNewerLocalChanges || pendingPull.reason !== 'manual-pull'}
          onCancel={() => setPendingPull(null)}
          onConfirm={() => void confirmPullSharedProject()}
        />
      )}

      {ownershipTransferProject && (
        <AppPromptDialog
          title="Transfer Ownership"
          message={ownershipTransferProject.projectName}
          label="New owner email"
          placeholder="name@example.com"
          inputMode="email"
          confirmLabel="Transfer"
          onCancel={() => setOwnershipTransferProject(null)}
          onConfirm={(value) => void confirmTransferSharedProjectOwnership(value)}
        />
      )}

      {disconnectSharedProjectConfirm && (
        <AppConfirmDialog
          title={disconnectSharedProjectLocalOnly
            ? 'Keep Local Copy'
            : disconnectSharedProjectIsOwner ? 'Stop Sharing' : 'Leave Shared Project'}
          message={disconnectSharedProjectLocalOnly
            ? `"${disconnectSharedProjectConfirm.projectName}" is no longer available to this account as a shared project.\n\nDisconnect this device's copy from collaboration? Your local inspection data will stay on this device.`
            : disconnectSharedProjectIsOwner
            ? `Stop sharing "${disconnectSharedProjectConfirm.projectName}"?\n\nThis will save a shared backup first, archive the shared project for everyone, and disconnect this device's local copy. Your local inspection data will stay on this device.`
            : `Leave "${disconnectSharedProjectConfirm.projectName}"?\n\nThis will save a shared backup first, remove your membership, and disconnect this device's local copy. Other members will keep access, and your local inspection data will stay on this device.`}
          confirmLabel={disconnectingSharedProject
            ? disconnectSharedProjectLocalOnly ? 'Disconnecting...' : disconnectSharedProjectIsOwner ? 'Stopping...' : 'Leaving...'
            : disconnectSharedProjectLocalOnly ? 'Keep Local Copy' : disconnectSharedProjectIsOwner ? 'Stop Sharing' : 'Leave Project'}
          danger
          onCancel={() => {
            if (!disconnectingSharedProject) {
              setDisconnectSharedProjectConfirm(null);
            }
          }}
          onConfirm={() => void confirmDisconnectSharedProject()}
        />
      )}

      {directoryDisconnectConfirm && (
        <AppConfirmDialog
          title={directoryDisconnectConfirm.ownerUserId === collaborationAuth.user?.id
            ? 'Stop Sharing'
            : 'Leave Shared Project'}
          message={directoryDisconnectConfirm.ownerUserId === collaborationAuth.user?.id
            ? `Stop sharing "${directoryDisconnectConfirm.projectName}"?\n\nYou own this project, so this will archive it for everyone. This project is not stored on this device.`
            : `Leave "${directoryDisconnectConfirm.projectName}"?\n\nThis will remove your membership. Other members will keep access, and no local project data will be deleted.`}
          confirmLabel={disconnectingDirectoryProjectId
            ? directoryDisconnectConfirm.ownerUserId === collaborationAuth.user?.id ? 'Stopping...' : 'Leaving...'
            : directoryDisconnectConfirm.ownerUserId === collaborationAuth.user?.id ? 'Stop Sharing' : 'Leave Project'}
          danger
          onCancel={() => {
            if (!disconnectingDirectoryProjectId) {
              setDirectoryDisconnectConfirm(null);
            }
          }}
          onConfirm={() => void confirmDirectoryDisconnect()}
        />
      )}

      {deleteProjectConfirm && (
        <AppConfirmDialog
          title="Delete Project"
          message={`Delete "${deleteProjectConfirm.projectName}"?\n\nYou can restore it later from Trash.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleteProjectConfirm(null)}
          onConfirm={() => void confirmDeleteEditingProject(deleteProjectConfirm)}
        />
      )}

      {showCollaborationHealth && (
        <CollaborationHealthDialog
          report={collaborationHealthReport}
          loading={runningCollaborationHealth}
          onClose={() => setShowCollaborationHealth(false)}
          onRefresh={() => void handleRunCollaborationHealthCheck()}
        />
      )}

      {sharedMembersProject && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Shared Members</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
              {sharedMembersProject.projectName}
            </p>
            {loadingSharedMembers ? (
              <div className="flex items-center gap-3 rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading members...
              </div>
            ) : sharedMembers.length === 0 ? (
              <div className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                No shared project members found.
              </div>
            ) : (
              <div className="space-y-3">
                {sharedMembers.map((member) => (
                  <div key={`${member.projectId}:${member.email}`} className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 p-4 dark:bg-white/[0.04]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                          {member.displayName || member.email}
                        </div>
                        <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                          {member.email}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {member.isOwner && (
                          <span className="rounded-full bg-black/[0.06] px-2.5 py-1 text-[11px] font-semibold text-gray-700 dark:bg-white/[0.08] dark:text-gray-300">
                            Owner
                          </span>
                        )}
                        <span className="rounded-full bg-green-500/10 px-2.5 py-1 text-[11px] font-semibold text-green-700 dark:bg-green-400/10 dark:text-green-300">
                          {formatMemberStatus(member.accessState)}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-gray-500 dark:text-gray-400">
                      <div>{formatMemberJoinMethod(member.joinedBy)}</div>
                      <div>
                        {member.joinedAt
                          ? `Joined ${member.joinedAt.toLocaleString()}`
                          : `Invited ${member.invitedAt.toLocaleString()}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setSharedMembersProject(null);
                  setSharedMembers([]);
                }}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Done
              </button>
              <button
                onClick={() => void handleShowSharedMembers(sharedMembersProject)}
                disabled={loadingSharedMembers}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}

      <AreaEditorModal
        key={showAddArea ? 'open' : 'closed'}
        open={showAddArea}
        title="Add Area"
        value={newAreaForm}
        recentAreaTypeKeys={recentAreaTypeKeys}
        facadeLevelOptions={facadeLevelOptions}
        facadeElevationDrawings={areaTargetProject?.facadeElevationDrawings ?? []}
        enableFacadeLevelBatch
        onChange={setNewAreaForm}
        onClose={() => {
          setShowAddArea(false);
          setAreaTargetProjectId(null);
          setNewAreaForm(getDefaultAreaFormValue());
        }}
        onSubmit={(values) => void handleAddArea(values)}
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

      {sharedProjectCode && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel w-full max-w-md rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Invite Code</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
              {sharedProjectCode.projectName}
            </p>
            <div className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-center dark:bg-white/[0.04]">
              <div className="select-all font-mono text-3xl font-semibold tracking-[0.18em] text-gray-900 dark:text-white">
                {sharedProjectCode.code}
              </div>
              <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                Expires {new Date(sharedProjectCode.expiresAt).toLocaleString()}
              </div>
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setSharedProjectCode(null)}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Done
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(sharedProjectCode.code);
                }}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}

      {showMySharedProjects && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">My Shared Projects</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
              Projects linked to your shared-project account.
            </p>
            {loadingMySharedProjects ? (
              <div className="flex items-center gap-3 rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading shared projects...
              </div>
            ) : mySharedProjects.length === 0 ? (
              <div className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                No shared projects are attached to this account yet.
              </div>
            ) : (
              <div className="space-y-3">
                {mySharedProjects.map((entry) => {
                  const localProject = projects.find((project) => project.sharedProjectId === entry.projectId);
                  const isAdding = addingSharedProjectId === entry.projectId;
                  const isDisconnecting = disconnectingDirectoryProjectId === entry.projectId;
                  const isOwner = entry.ownerUserId === collaborationAuth.user?.id;
                  return (
                    <div key={entry.projectId} className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 p-4 dark:bg-white/[0.04]">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-gray-900 dark:text-white">{entry.projectName}</div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {entry.ownerEmail ? `Owner: ${entry.ownerEmail}` : 'Shared project'}
                        </div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {entry.publishedAt ? `Latest shared data: ${entry.publishedAt.toLocaleString()}` : 'No shared data published yet'}
                        </div>
                      </div>
                      <button
                        onClick={() => void handleAddSharedProjectFromDirectory(entry)}
                        disabled={!!localProject || !!addingSharedProjectId || !!disconnectingDirectoryProjectId}
                        className="mt-4 w-full rounded-2xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                      >
                        {localProject ? 'On this device' : isAdding ? 'Adding...' : 'Add to this device'}
                      </button>
                      <button
                        onClick={() => handleDirectoryDisconnect(entry, localProject)}
                        disabled={!!addingSharedProjectId || !!disconnectingDirectoryProjectId}
                        className="mt-2 w-full rounded-2xl border border-red-300/90 bg-red-50/80 px-4 py-3 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-400/20 dark:bg-red-400/[0.08] dark:text-red-300 dark:hover:bg-red-400/[0.14]"
                      >
                        {isDisconnecting
                          ? (isOwner ? 'Stopping...' : 'Leaving...')
                          : isOwner ? 'Leave project (stops sharing)' : 'Leave project'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setShowMySharedProjects(false);
                  setMySharedProjects([]);
                }}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Done
              </button>
              <button
                onClick={() => void handleShowMySharedProjects()}
                disabled={loadingMySharedProjects}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}

      {backupProject && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Shared Backups</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
              {backupProject.projectName}
            </p>
            {loadingSharedBackups ? (
              <div className="flex items-center gap-3 rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading backups...
              </div>
            ) : sharedBackups.length === 0 ? (
              <div className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                No shared backups yet. Backups are created when shared data is published, pulled, or restored.
              </div>
            ) : (
              <div className="space-y-3">
                {sharedBackups.map((backup) => {
                  const isRestoring = restoringBackupId === backup.id;
                  return (
                    <div key={backup.id} className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 p-4 dark:bg-white/[0.04]">
                      <div className="text-sm font-semibold text-gray-900 dark:text-white">
                        {formatSharedBackupReason(backup.reason)}
                      </div>
                      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {backup.capturedAt.toLocaleString()}
                      </div>
                      {backup.note && (
                        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                          {backup.note}
                        </div>
                      )}
                      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <button
                          onClick={() => void handleRestoreSharedBackup(backup)}
                          disabled={!!restoringBackupId}
                          className="rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                        >
                          {isRestoring ? 'Restoring...' : 'Restore'}
                        </button>
                        <button
                          onClick={() => void handleRestoreSharedBackup(backup, true)}
                          disabled={!!restoringBackupId}
                          className="rounded-2xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                        >
                          Restore + publish
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setBackupProject(null);
                  setSharedBackups([]);
                }}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Done
              </button>
              <button
                onClick={() => backupProject && void handleShowSharedBackups(backupProject)}
                disabled={loadingSharedBackups}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}

      {showJoinProject && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel w-full max-w-md rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Join Shared Project</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">Enter the code from the project owner.</p>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Code
            </label>
            <input
              type="text"
              value={joinProjectCode}
              onChange={(event) => setJoinProjectCode(event.target.value.toUpperCase())}
              className="field-shell font-mono tracking-[0.12em]"
              placeholder="ABC123"
              autoFocus
            />
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setShowJoinProject(false);
                  setJoinProjectCode('');
                }}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleJoinSharedProject()}
                disabled={!joinProjectCode.trim() || joiningProject}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {joiningProject ? 'Joining...' : 'Join'}
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
              {actionSheet === 'export-scope' ? (
                <>
                  <div className="px-4 pb-2 pt-3 text-center">
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">Export Project</div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Choose specific areas or export every issue area in this project.
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setActionSheet(null);
                      setExportScope('selected-areas');
                      setSelectedAreaIds(new Set());
                      setSelectedProjectIds(new Set());
                      setExportMode(false);
                      setDeleteMode(true);
                    }}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] font-medium text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Select Areas
                  </button>
                  <button
                    onClick={() => {
                      if (!singleProject) return;
                      setExportScope('selected-projects');
                      setSelectedAreaIds(new Set());
                      setSelectedProjectIds(new Set([singleProject.id]));
                      setActionSheet('export');
                    }}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Export All
                  </button>
                  <button
                    onClick={() => setActionSheet(null)}
                    className="mt-1 w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Cancel
                  </button>
                </>
              ) : actionSheet === 'export' ? (
                <>
                  <div className="px-4 pb-2 pt-3 text-center">
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">Export PDF</div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {exportScope === 'selected-areas'
                        ? 'Save selected issue areas locally or to OneDrive.'
                        : 'Save this report locally or to OneDrive.'}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      if (exportScope === 'selected-areas') {
                        void handleExportSelectedAreas('onedrive');
                        return;
                      }
                      void handleExportSelected('onedrive');
                    }}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    OneDrive
                  </button>
                  <button
                    onClick={() => {
                      if (exportScope === 'selected-areas') {
                        void handleExportSelectedAreas('local');
                        return;
                      }
                      void handleExportSelected('local');
                    }}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Local
                  </button>
                  <button
                    onClick={() => setActionSheet('export-scope')}
                    className="mt-1 w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Back
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
