'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Area, Project, checkpointHasIssue, getReviewMetrics } from '@/types';
import { clearPendingSharedSyncsForProject, getProject, getProjectMetadata, saveProject, saveProjectMetadataOnly, saveProjectPreserveTimestamps, createArea } from '@/lib/db';
import { cacheProjectPreview, getCachedProjectPreview } from '@/lib/projectNavigationCache';
import { readLocalStorage, writeLocalStorage } from '@/lib/browserStorage';
import AreaEditorModal from '@/components/AreaEditorModal';
import ProjectEditModal from '@/components/ProjectEditModal';
import AppMessageDialog from '@/components/AppMessageDialog';
import AppConfirmDialog from '@/components/AppConfirmDialog';
import AppPromptDialog from '@/components/AppPromptDialog';
import CollaborationHealthDialog from '@/components/CollaborationHealthDialog';
import InvitePeopleDialog from '@/components/InvitePeopleDialog';
import SharedMembersDialog from '@/components/SharedMembersDialog';
import { buildSharedProjectInviteUrl } from '@/features/collaboration/inviteLinks';
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
import { applyTemplateToArea } from '@/lib/template';
import { hydrateProjectMediaFromOneDrive } from '@/lib/oneDriveSync';
import {
  hasPendingSyncState,
  queuePendingSync,
} from '@/lib/pendingSync';
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
} from '@/features/collaboration/detachedSharedProject';
import { AreaCard,
  type AreaCardMetrics as AreaMetrics,
  type AreaCardClaimDisplay as AreaClaimDisplay,
} from '@/features/projects/AreaCard';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import {
  captureSharedProjectBackup,
  claimSharedProjectArea,
  createSharedProjectFromLocalProject,
  disconnectSharedProject,
  generateSharedProjectJoinCode,
  getActiveSharedProjectAreaClaimSummaries,
  getCollaborationErrorMessage,
  getSharedProjectMembers,
  getSharedProjectBackupSnapshot,
  getSharedProjectSnapshot,
  getSharedProjectSnapshotMetadata,
  hasNewerLocalChangesThanSharedSnapshot,
  isSharedSnapshotNewer,
  isSharedProjectPublishConflictError,
  listSharedProjectBackups,
  publishSharedProjectSnapshot,
  queueSharedProjectAreaSyncs,
  removeSharedProjectMember,
  saveAndQueueSharedProjectMetadataSync,
  runCollaborationHealthCheck,
  subscribeToSharedProjectAreaClaimChanges,
  subscribeToSharedProjectAreaSnapshotChanges,
  subscribeToSharedProjectMetadataSnapshotChanges,
  subscribeToSharedProjectSnapshotChanges,
  syncSharedProjectMetadataNow,
  transferSharedProjectOwnership,
} from '@/lib/collaboration';
import type { CollaborationHealthReport, CollaborationProjectMember, CollaborationSnapshotBackup } from '@/lib/collaboration';
import { getNextOneDriveExportFilename, uploadPdfToOneDrive } from '@/lib/oneDrive';
import {
  formatDateForExport,
  getOneDriveProjectFolderName,
  sanitizeExportNamePart,
} from '@/lib/projectNaming';
import Link from 'next/link';
import {
  ArrowLeft,
  Building2,
  FileDown,
  Loader2,
  Trash2,
  RotateCcw,
  Plus,
  CloudUpload,
} from 'lucide-react';

type SortOption = 'alphabetical' | 'issues' | 'progress';
type ExportDestination = 'local' | 'onedrive';
type ExportScope = 'project' | 'selected-areas';

const SORT_STORAGE_KEY = 'punchlist-areas-sort';
const RECENT_AREA_TYPES_STORAGE_KEY = 'punchlist-recent-area-types';
const SHARED_AREA_CLAIM_REFRESH_MS = 15 * 1000;

type MessageDialogState = {
  title: string;
  message: string;
};

function formatSharedBackupReason(reason: CollaborationSnapshotBackup['reason']) {
  if (reason === 'publish') return 'Published version';
  if (reason === 'before_publish') return 'Before publish';
  if (reason === 'before_pull') return 'Before pull';
  if (reason === 'restore') return 'Before restore';
  return 'Manual backup';
}

type BackupRestoreConfirmState = {
  backup: CollaborationSnapshotBackup;
  publishAfterRestore: boolean;
};

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const cachedProject = useMemo(() => getCachedProjectPreview(id), [id]);
  const [project, setProject] = useState<Project | null>(() => cachedProject);
  const [loading, setLoading] = useState(() => !cachedProject);
  const [showAddArea, setShowAddArea] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedAreaIds, setSelectedAreaIds] = useState<Set<string>>(new Set());
  const [exportingSelectedAreas, setExportingSelectedAreas] = useState(false);
  const [newAreaForm, setNewAreaForm] = useState(getDefaultAreaFormValue());
  const [recentAreaTypeKeys, setRecentAreaTypeKeys] = useState<AreaTypeKey[]>([]);
  const [sortOption, setSortOption] = useState<SortOption>('issues');
  const [showTrash, setShowTrash] = useState(false);
  const [actionSheet, setActionSheet] = useState<'delete' | 'export' | 'export-scope' | null>(null);
  const [exportScope, setExportScope] = useState<ExportScope>('project');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [sharedAreaClaims, setSharedAreaClaims] = useState<Map<string, AreaClaimDisplay>>(new Map());
  const [messageDialog, setMessageDialog] = useState<MessageDialogState | null>(null);
  const [showCollaborationHealth, setShowCollaborationHealth] = useState(false);
  const [collaborationHealthReport, setCollaborationHealthReport] = useState<CollaborationHealthReport | null>(null);
  const [runningCollaborationHealth, setRunningCollaborationHealth] = useState(false);
  const [sharedProjectCode, setSharedProjectCode] = useState<{
    projectName: string;
    code: string;
    expiresAt: string;
    inviteUrl: string;
  } | null>(null);
  const [creatingJoinCode, setCreatingJoinCode] = useState(false);
  const [loadingSharedMembers, setLoadingSharedMembers] = useState(false);
  const [showSharedMembers, setShowSharedMembers] = useState(false);
  const [sharedMembers, setSharedMembers] = useState<CollaborationProjectMember[]>([]);
  const [memberRemovalConfirm, setMemberRemovalConfirm] = useState<CollaborationProjectMember | null>(null);
  const [removingMemberEmail, setRemovingMemberEmail] = useState('');
  const [memberRemovalError, setMemberRemovalError] = useState('');
  const [pendingPull, setPendingPull] = useState<PendingSharedPullState | null>(null);
  const [backupProject, setBackupProject] = useState<Project | null>(null);
  const [loadingSharedBackups, setLoadingSharedBackups] = useState(false);
  const [sharedBackups, setSharedBackups] = useState<CollaborationSnapshotBackup[]>([]);
  const [restoringBackupId, setRestoringBackupId] = useState<string | null>(null);
  const [backupRestoreConfirm, setBackupRestoreConfirm] = useState<BackupRestoreConfirmState | null>(null);
  const [ownershipTransferProject, setOwnershipTransferProject] = useState<Project | null>(null);
  const [transferringSharedProject, setTransferringSharedProject] = useState(false);
  const [disconnectSharedProjectConfirm, setDisconnectSharedProjectConfirm] = useState<Project | null>(null);
  const [disconnectSharedProjectIsOwner, setDisconnectSharedProjectIsOwner] = useState(false);
  const [disconnectSharedProjectLocalOnly, setDisconnectSharedProjectLocalOnly] = useState(false);
  const [disconnectingSharedProject, setDisconnectingSharedProject] = useState(false);
  const projectRef = useRef<Project | null>(cachedProject);
  const backgroundAreaClaimKeysRef = useRef(new Set<string>());
  const topMenuActionHandlerRef = useRef<((event: Event) => void) | null>(null);
  const loadProjectRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const { ensureAccessToken, signIn, isReady, isSignedIn, accountEmail, accountName } = useMicrosoftAuth();
  const collaborationAuth = useCollaborationAuth();
  const {
    clearSharedUpdateAvailable,
    markSharedUpdateAvailable,
    setSharedTransferStatus,
    setRetryAt,
    setStatus: setSyncStatus,
    setSyncConflicts,
  } = useSyncStatus();
  const { quickSort, markSyncedNow } = useAppSettings();
  loadProjectRef.current = loadProject;

  const showMessage = useCallback((message: string, title = 'Punchlist') => {
    setMessageDialog({ title, message });
  }, []);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

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

  useEffect(() => {
    // Load saved sort preference
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
    if (!id) {
      router.push('/');
      return;
    }
    void loadProjectRef.current();
    const savedRecentAreaTypes = readLocalStorage(RECENT_AREA_TYPES_STORAGE_KEY);
    if (savedRecentAreaTypes) {
      try {
        setRecentAreaTypeKeys(JSON.parse(savedRecentAreaTypes) as AreaTypeKey[]);
      } catch (error) {
        console.error('Failed to parse recent area types:', error);
      }
    }
  }, [id, router]);

  useEffect(() => {
    if (!collaborationAuth.isSignedIn) return;
    if (loading) return;
    void loadProjectRef.current();
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

  useEffect(() => {
    if (project) {
      cacheProjectPreview(project);
    }
  }, [project]);

  const primeAreaOpen = useCallback(
    (areaId: string) => {
      if (!project) return;
      cacheProjectPreview(project);
      router.prefetch(`/project/${project.id}/area/${areaId}`);
    },
    [project, router]
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
    (areaId: string) => {
      const sharedProjectId = project?.sharedProjectId;
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
      project?.sharedProjectId,
    ]
  );

  function handleSortChange(option: SortOption) {
    setSortOption(option);
    writeLocalStorage(SORT_STORAGE_KEY, option);
  }

  async function handleEditProject(updates: Partial<Project>) {
    if (!editingProject) return;
    const updatedProject = { ...editingProject, ...updates, areas: [...editingProject.areas] };
    await saveAndQueueSharedProjectMetadataSync(updatedProject);
    scheduleSync(updatedProject.id);
    setProject(updatedProject);
    setEditingProject(null);
  }

  async function loadProject() {
    if (!id) return;
    try {
      const data = await getProjectMetadata(id);
      if (data) {
        if (data.deletedAt) {
          router.push('/');
          return;
        }
        const nextProject = data;
        if (collaborationAuth.isSignedIn && data.sharedProjectId) {
          try {
            const metadata = await getSharedProjectSnapshotMetadata(data.sharedProjectId);
            if (metadata && isSharedSnapshotNewer(data, metadata.publishedAt)) {
              markSharedUpdateAvailable(data.id);
            } else {
              clearSharedUpdateAvailable(data.id);
            }
          } catch (error) {
            console.info('Shared update check skipped:', error);
          }
        }
        setProject(nextProject);
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
  const areaDisplayNames = useMemo(
    () => getAreaDisplayNameMap(activeAreas),
    [activeAreas]
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

  useEffect(() => {
    if (!collaborationAuth.isSignedIn || !project?.sharedProjectId) return;

    const localProjectId = project.id;
    const activeSharedProjectId = project.sharedProjectId;
    const markUpdateIfNewer = async (publishedAt?: string) => {
      const currentProject = await getProjectMetadata(localProjectId);
      if (!currentProject || currentProject.sharedProjectId !== activeSharedProjectId) return;
      if (!publishedAt || isSharedSnapshotNewer(currentProject, publishedAt)) {
        markSharedUpdateAvailable(localProjectId);
      }
    };
    const unsubscribeSnapshotChanges = subscribeToSharedProjectSnapshotChanges(
      activeSharedProjectId,
      (change) => {
        void markUpdateIfNewer(change.publishedAt);
      }
    );
    const unsubscribeAreaChanges = subscribeToSharedProjectAreaSnapshotChanges(
      activeSharedProjectId,
      (change) => {
        void markUpdateIfNewer(change.publishedAt);
      }
    );
    const unsubscribeMetadataChanges = subscribeToSharedProjectMetadataSnapshotChanges(
      activeSharedProjectId,
      (change) => {
        void markUpdateIfNewer(change.publishedAt);
      }
    );

    return () => {
      unsubscribeSnapshotChanges();
      unsubscribeAreaChanges();
      unsubscribeMetadataChanges();
    };
  }, [
    collaborationAuth.isSignedIn,
    markSharedUpdateAvailable,
    project?.id,
    project?.sharedProjectId,
  ]);

  useEffect(() => {
    const sharedProjectId = project?.sharedProjectId;
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
  }, [collaborationAuth.isSignedIn, collaborationAuth.user?.id, project?.sharedProjectId]);

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
  }, [activeAreas, sortOption, areaMetrics]);

  async function handleAddArea(submittedForms?: AreaFormValue[]) {
    if (!project) return;

    const projectForAreaCreation = project;

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
        claimAreaOpenInBackground(area.id);
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
    setShowAddArea(false);
    setProject({ ...projectForAreaCreation, areas: [...projectForAreaCreation.areas] });
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
      setExportScope('project');
      return;
    }
    const deletedAreaIds = [...selectedAreaIds];
    const now = new Date();
    project.areas.forEach((area) => {
      if (selectedAreaIds.has(area.id)) {
        area.deletedAt = now;
        area.updatedAt = now;
      }
    });
    await saveProjectMetadataOnly(project);
    await queueSharedProjectAreaSyncs(project, deletedAreaIds).catch((error) => {
      console.info('Deleted shared areas remain local until they can be queued:', error);
    });
    scheduleSync(project.id);
    setSelectedAreaIds(new Set());
    setDeleteMode(false);
    setExportScope('project');
    setActionSheet(null);
    setProject({ ...project, areas: [...project.areas] });
  }

  async function handleExportSelectedAreas(destination: ExportDestination) {
    if (!project || exportingSelectedAreas || selectedAreaIds.size === 0) return;
    setExportingSelectedAreas(true);
    setActionSheet(null);
    try {
      const selectedIds = new Set(selectedAreaIds);
      const sortedAreaIds = [...sortedAreas]
        .filter((area) => selectedIds.has(area.id))
        .map((area) => area.id);
      const shouldSaveToDrive = destination === 'onedrive';
      const token = shouldSaveToDrive ? await ensureAccessToken() : null;
      if (shouldSaveToDrive && !token) {
        signIn();
        return;
      }
      const projectForExport = token
        ? await hydrateProjectMediaFromOneDrive(token, project.id)
        : await getProject(project.id);
      const { generateProjectPDF, downloadPDF } = await import('@/lib/pdfExport');
      const blob = await generateProjectPDF(projectForExport ?? project, 'issues', { areaIds: sortedAreaIds });
      if (destination === 'local') {
        const filename = `${sanitizeExportNamePart(project.projectName)}_Selected_Areas_${formatDateForExport()}.pdf`;
        downloadPDF(blob, filename);
      }
      if (token && shouldSaveToDrive) {
        const projectFolderName = getOneDriveProjectFolderName(project);
        const filename = await getNextOneDriveExportFilename(
          token,
          [`${project.projectName}_Selected_Areas_Issues`],
          new Date(),
          projectFolderName
        );
        await uploadPdfToOneDrive(token, filename, blob, projectFolderName);
      }
    } catch (error) {
      console.error('Failed to export selected areas:', error);
      showMessage('Failed to export selected areas. Please try again.');
    } finally {
      setExportingSelectedAreas(false);
      setDeleteMode(false);
      setSelectedAreaIds(new Set());
    }
  }

  async function handleExportProject(destination: ExportDestination) {
    if (!project || exportingSelectedAreas) return;
    setExportingSelectedAreas(true);
    setActionSheet(null);
    try {
      const shouldSaveToDrive = destination === 'onedrive';
      const token = shouldSaveToDrive ? await ensureAccessToken() : null;
      if (shouldSaveToDrive && !token) {
        signIn();
        return;
      }
      const projectForExport = token
        ? await hydrateProjectMediaFromOneDrive(token, project.id)
        : await getProject(project.id);
      const { generateProjectPDF, downloadPDF } = await import('@/lib/pdfExport');
      const blob = await generateProjectPDF(projectForExport ?? project, 'issues');
      if (destination === 'local') {
        const filename = `${sanitizeExportNamePart(project.projectName)}_Issues_${formatDateForExport()}.pdf`;
        downloadPDF(blob, filename);
      }
      if (token && shouldSaveToDrive) {
        const projectFolderName = getOneDriveProjectFolderName(project);
        const filename = await getNextOneDriveExportFilename(
          token,
          [`${project.projectName}_Issues`],
          new Date(),
          projectFolderName
        );
        await uploadPdfToOneDrive(token, filename, blob, projectFolderName);
      }
    } catch (error) {
      console.error('Failed to export project:', error);
      showMessage('Failed to export project. Please try again.');
    } finally {
      setExportingSelectedAreas(false);
    }
  }

  async function handleRestoreArea(areaId: string) {
    if (!project) return;
    const area = project.areas.find((entry) => entry.id === areaId);
    if (!area) return;
    delete area.deletedAt;
    area.updatedAt = new Date();
    await saveProjectMetadataOnly(project);
    await queueSharedProjectAreaSyncs(project, [area.id]).catch((error) => {
      console.info('Restored shared area remains local until it can be queued:', error);
    });
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
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
      await loadProject();
    } finally {
      setSyncing(false);
    }
  }

  function scheduleSync(projectId?: string, options?: { fullSync?: boolean }) {
    queuePendingSync(projectId, options);
    setSyncStatus('pending');
  }

  const handleShareProject = useCallback(async () => {
    if (!project) return;

    if (!collaborationAuth.isSignedIn || !collaborationAuth.user) {
      showMessage('Enable shared projects before sharing this project.');
      return;
    }

    if (!accountEmail) {
      showMessage('Sign in with an allowed Microsoft account before sharing this project.');
      return;
    }

    try {
      const fullProject = await getProject(project.id);
      if (!fullProject) {
        throw new Error('Could not load this project.');
      }
      const sharedProjectId = await createSharedProjectFromLocalProject(
        fullProject,
        accountEmail,
        accountName
      );
      const linkedAt = new Date();
      const nextProject = {
        ...clearDetachedSharedProjectMetadata(fullProject),
        sharedProjectId,
        sharedProjectLinkedAt: linkedAt,
        areas: [...fullProject.areas],
      };
      await saveProjectMetadataOnly(nextProject);
      setProject({ ...nextProject, areas: [...nextProject.areas] });
      showMessage('Project sharing is enabled. You are the owner of this shared project.');
    } catch (error) {
      console.error('Failed to share project:', error);
      showMessage(getCollaborationErrorMessage(error));
    }
  }, [accountEmail, accountName, collaborationAuth.isSignedIn, collaborationAuth.user, project, showMessage]);

  const handleCreateJoinCode = useCallback(async () => {
    if (!project) return;

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
        inviteUrl: buildSharedProjectInviteUrl(result.joinCode, window.location.origin),
      });
    } catch (error) {
      console.error('Failed to create shared project code:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to create invite code. Please try again.'));
    } finally {
      setCreatingJoinCode(false);
    }
  }, [collaborationAuth.isSignedIn, project, showMessage]);

  const handleShowSharedMembers = useCallback(async () => {
    if (!project) return;

    if (!project.sharedProjectId) {
      showMessage('Share this project before viewing shared members.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before viewing shared members.');
      return;
    }

    setLoadingSharedMembers(true);
    setShowSharedMembers(true);
    setSharedMembers([]);
    setMemberRemovalError('');
    try {
      const members = await getSharedProjectMembers(project.sharedProjectId);
      setSharedMembers(members);
    } catch (error) {
      console.error('Failed to load shared project members:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to load shared project members. Please try again.'));
      setShowSharedMembers(false);
    } finally {
      setLoadingSharedMembers(false);
    }
  }, [collaborationAuth.isSignedIn, project, showMessage]);

  async function confirmRemoveSharedProjectMember() {
    const targetProject = project;
    const member = memberRemovalConfirm;
    if (!targetProject?.sharedProjectId || !member || removingMemberEmail) return;

    setMemberRemovalConfirm(null);
    setRemovingMemberEmail(member.email);
    setMemberRemovalError('');
    try {
      await removeSharedProjectMember(targetProject.sharedProjectId, member.email);
      setSharedMembers((currentMembers) => currentMembers.filter(
        (currentMember) => currentMember.email.toLowerCase() !== member.email.toLowerCase()
      ));
    } catch (error) {
      console.error('Failed to remove shared project member:', error);
      setMemberRemovalError(getCollaborationErrorMessage(
        error,
        'Failed to remove this project member. Please try again.'
      ));
    } finally {
      setRemovingMemberEmail('');
    }
  }

  const handlePublishSharedProject = useCallback(async () => {
    if (!project) return;

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
      setProject((currentProject) =>
        currentProject?.id === loadedProject.id
          ? { ...currentProject, sharedSnapshotPublishedAt: loadedProject.sharedSnapshotPublishedAt }
          : currentProject
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
    project,
    setSharedTransferStatus,
    showMessage,
  ]);

  const handlePullSharedProject = useCallback(async () => {
    if (!project) return;

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
      setProject({ ...result.project, areas: [...result.project.areas] });
      showMessage(`Shared data pulled from ${new Date(result.publishedAt).toLocaleString()}.`);
    } catch (error) {
      console.error('Failed to pull shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to pull shared data. Please try again.'));
    } finally {
      setSharedTransferStatus(null);
    }
  }, [clearSharedUpdateAvailable, collaborationAuth.isSignedIn, project, setSharedTransferStatus, showMessage]);

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
      setProject({ ...pullState.resolutionProject, areas: [...pullState.resolutionProject.areas] });
      showMessage(formatPendingSharedPullSuccessMessage(pullState));
    } catch (error) {
      console.error('Failed to pull shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to pull shared data. Please try again.'));
    } finally {
      setSharedTransferStatus(null);
    }
  }

  const handleShowSharedBackups = useCallback(async () => {
    if (!project) return;

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
  }, [collaborationAuth.isSignedIn, project, showMessage]);

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
      setProject({ ...result.project, areas: [...result.project.areas] });
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

  const handleTransferSharedProjectOwnership = useCallback(() => {
    if (!project) return;

    if (!project.sharedProjectId) {
      showMessage('Share this project before transferring ownership.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before transferring ownership.');
      return;
    }

    setOwnershipTransferProject(project);
  }, [collaborationAuth.isSignedIn, project, showMessage]);

  async function confirmTransferSharedProjectOwnership(newOwnerEmailValue: string) {
    const targetProject = ownershipTransferProject;
    const sharedProjectId = targetProject?.sharedProjectId;
    if (!targetProject || !sharedProjectId) return;

    const newOwnerEmail = newOwnerEmailValue.trim().toLowerCase();
    if (!newOwnerEmail) return;

    setOwnershipTransferProject(null);
    setTransferringSharedProject(true);
    try {
      const result = await transferSharedProjectOwnership(sharedProjectId, newOwnerEmail);
      showMessage(`Ownership transferred to ${result.ownerEmail}.`);
    } catch (error) {
      console.error('Failed to transfer shared project ownership:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to transfer ownership. Please try again.'));
    } finally {
      setTransferringSharedProject(false);
    }
  }

  function handleDisconnectSharedProject(isOwner: boolean) {
    if (!project?.sharedProjectId) {
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

  function handleUnlinkInactiveSharedProject() {
    if (!project?.sharedProjectId) {
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
      setProject({ ...localProject, areas: [...localProject.areas] });
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

  function cancelSelectionMode() {
    setDeleteMode(false);
    setActionSheet(null);
    setExportScope('project');
    setSelectedAreaIds(new Set());
  }

  topMenuActionHandlerRef.current = (event: Event) => {
    const customEvent = event as CustomEvent<{
      action: string;
      sort?: SortOption;
      isSharedProjectOwner?: boolean;
    }>;
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

    if (detail.action === 'toggle-selection') {
      if (deleteMode) {
        cancelSelectionMode();
      } else {
        setExportScope('project');
        setDeleteMode(true);
        setSelectedAreaIds(new Set());
      }
      return;
    }

    if (detail.action === 'export-project') {
      setShowTrash(false);
      setDeleteMode(false);
      setSelectedAreaIds(new Set());
      setExportScope('project');
      setActionSheet('export-scope');
      return;
    }

    if (detail.action === 'share-project') {
      void handleShareProject();
      return;
    }

    if (detail.action === 'invite-people') {
      void handleCreateJoinCode();
      return;
    }

    if (detail.action === 'shared-members') {
      void handleShowSharedMembers();
      return;
    }

    if (detail.action === 'publish-shared-project') {
      void handlePublishSharedProject();
      return;
    }

    if (detail.action === 'pull-shared-project') {
      void handlePullSharedProject();
      return;
    }

    if (detail.action === 'shared-backups') {
      void handleShowSharedBackups();
      return;
    }

    if (detail.action === 'disconnect-shared-project') {
      handleDisconnectSharedProject(detail.isSharedProjectOwner === true);
      return;
    }

    if (detail.action === 'unlink-inactive-shared-project') {
      handleUnlinkInactiveSharedProject();
      return;
    }

    if (detail.action === 'toggle-trash') {
      setShowTrash((current) => !current);
      setDeleteMode(false);
      setSelectedAreaIds(new Set());
      setActionSheet(null);
      return;
    }

    if (detail.action === 'collaboration-health') {
      void handleRunCollaborationHealthCheck();
      return;
    }

    if (detail.action === 'clear-trash') {
      setShowTrash(false);
      setDeleteMode(false);
      setSelectedAreaIds(new Set());
      setActionSheet(null);
    }
  };

  useEffect(() => {
    function handleTopMenuAction(event: Event) {
      topMenuActionHandlerRef.current?.(event);
    }

    window.addEventListener('punchlist-home-menu-action', handleTopMenuAction as EventListener);
    return () => {
      window.removeEventListener('punchlist-home-menu-action', handleTopMenuAction as EventListener);
    };
  }, []);

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
          selectionMode: deleteMode,
          isSharedProject: !!project.sharedProjectId,
          sharedProjectId: project.sharedProjectId,
          isCreatingJoinCode: creatingJoinCode,
          isLoadingSharedMembers: loadingSharedMembers,
          isDisconnectingSharedProject: disconnectingSharedProject,
        },
      })
    );
  }, [
    creatingJoinCode,
    deleteMode,
    disconnectingSharedProject,
    loadingSharedMembers,
    project,
    showTrash,
    sortOption,
  ]);

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
        <div className="page-header-surface mx-auto flex min-h-[4.9rem] w-full max-w-6xl items-center px-4 py-3 sm:px-5">
          <div className="flex w-full items-center gap-3">
            <Link href="/" className="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-600 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="section-eyebrow">Project</div>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <h1 className="min-w-0 truncate text-[1.2rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
                  {project.projectName}
                </h1>
                {project.sharedProjectId && (
                  <span
                    className="inline-flex translate-y-[2px] shrink-0 items-center justify-center text-emerald-500"
                    title="Shared project"
                    aria-label="Shared project"
                    role="img"
                  >
                    <CloudUpload className="h-4 w-4" aria-hidden="true" />
                  </span>
                )}
              </div>
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
                    setActionSheet('delete');
                  }}
                  disabled={selectedAreaIds.size === 0}
                  className="accent-text accent-tint hover:accent-tint-strong flex h-10 w-10 items-center justify-center rounded-full transition disabled:opacity-40"
                  aria-label="Delete selected areas"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
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
        className="flex-1 min-h-0 overflow-y-scroll overscroll-y-contain touch-pan-y px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+6.5rem)] sm:px-5"
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
                    className="card-surface-subtle rounded-[1.5rem] p-4 sm:p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-900 dark:text-white truncate">{area.name}</div>
                        <div className="mt-1 text-xs font-medium uppercase tracking-[0.16em] text-gray-500 dark:text-gray-400">
                          Project: {project.projectName}
                        </div>
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
                    displayName={areaDisplayNames.get(area.id) ?? area.name}
                    metric={metric}
                    claimStatus={sharedAreaClaims.get(area.id)}
                    deleteMode={deleteMode}
                    isSelected={isSelected}
                    onToggleSelection={toggleAreaSelection}
                    onBlockedByClaim={() => showMessage('This shared area is currently locked by another user.')}
                    onPrimeOpen={primeAreaOpen}
                    onOpenArea={claimAreaOpenInBackground}
                  />
                );
              })}
            <div className="mt-auto pt-2" />
          </div>
        )}
      </main>

      {!showTrash && !deleteMode && (
        <div className="floating-action-rail pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+1.25rem)] z-20">
          <button
            onClick={() => setShowAddArea(true)}
            className="floating-action pointer-events-auto inline-flex h-14 w-[7.5rem] items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition hover:translate-y-[-1px]"
            aria-label="Add area"
            title="Add area"
          >
            <Plus className="h-4 w-4" />
            Area
          </button>
        </div>
      )}

      {messageDialog && (
        <AppMessageDialog
          title={messageDialog.title}
          message={messageDialog.message}
          onClose={() => setMessageDialog(null)}
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

      {backupRestoreConfirm && (
        <AppConfirmDialog
          title={backupRestoreConfirm.publishAfterRestore ? 'Restore + Publish Backup' : 'Restore Backup'}
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

      {sharedProjectCode && (
        <InvitePeopleDialog
          projectName={sharedProjectCode.projectName}
          code={sharedProjectCode.code}
          expiresAt={sharedProjectCode.expiresAt}
          inviteUrl={sharedProjectCode.inviteUrl}
          onClose={() => setSharedProjectCode(null)}
        />
      )}

      {showSharedMembers && project && (
        <SharedMembersDialog
          projectName={project.projectName}
          members={sharedMembers}
          loading={loadingSharedMembers}
          canTransferOwnership={sharedMembers.some(
            (member) => member.isOwner && member.userId === collaborationAuth.user?.id
          )}
          canRemoveMembers={sharedMembers.some(
            (member) => member.isOwner && member.userId === collaborationAuth.user?.id
          )}
          transferringOwnership={transferringSharedProject}
          removingMemberEmail={removingMemberEmail}
          removalError={memberRemovalError}
          onClose={() => {
            setShowSharedMembers(false);
            setSharedMembers([]);
            setMemberRemovalConfirm(null);
            setMemberRemovalError('');
          }}
          onRefresh={() => void handleShowSharedMembers()}
          onRemoveMember={(member) => {
            setMemberRemovalError('');
            setMemberRemovalConfirm(member);
          }}
          onTransferOwnership={() => {
            setShowSharedMembers(false);
            setSharedMembers([]);
            handleTransferSharedProjectOwnership();
          }}
        />
      )}

      {memberRemovalConfirm && project && (
        <AppConfirmDialog
          title="Remove Member"
          message={`Remove ${memberRemovalConfirm.displayName || memberRemovalConfirm.email} from “${project.projectName}”?\n\nThey will lose shared access. Their local project copy will remain on their device. The current invite link and code will also be invalidated.`}
          confirmLabel={removingMemberEmail ? 'Removing...' : 'Remove Member'}
          danger
          onCancel={() => {
            if (!removingMemberEmail) {
              setMemberRemovalConfirm(null);
            }
          }}
          onConfirm={() => void confirmRemoveSharedProjectMember()}
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

      {ownershipTransferProject && (
        <AppPromptDialog
          title="Transfer Ownership"
          message={`${ownershipTransferProject.projectName}\n\nEnter the email address of an existing active member. That person will receive owner controls for this shared project.`}
          label="New owner email"
          placeholder="name@example.com"
          inputMode="email"
          confirmLabel="Transfer"
          onCancel={() => setOwnershipTransferProject(null)}
          onConfirm={(value) => void confirmTransferSharedProjectOwnership(value)}
        />
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
                onClick={() => void handleShowSharedBackups()}
                disabled={loadingSharedBackups}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}

      {showCollaborationHealth && (
        <CollaborationHealthDialog
          report={collaborationHealthReport}
          loading={runningCollaborationHealth}
          onClose={() => setShowCollaborationHealth(false)}
          onRefresh={() => void handleRunCollaborationHealthCheck()}
        />
      )}

      <AreaEditorModal
        key={showAddArea ? 'open' : 'closed'}
        open={showAddArea}
        title="Add Area"
        value={newAreaForm}
        recentAreaTypeKeys={recentAreaTypeKeys}
        facadeLevelOptions={buildFacadeLevelOptions(project)}
        facadeElevationDrawings={project?.facadeElevationDrawings ?? []}
        enableFacadeLevelBatch
        onChange={setNewAreaForm}
        onClose={() => {
          setShowAddArea(false);
          setNewAreaForm(getDefaultAreaFormValue());
        }}
        onSubmit={(values) => void handleAddArea(values)}
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
                      setDeleteMode(true);
                    }}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] font-medium text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Select Areas
                  </button>
                  <button
                    onClick={() => {
                      setExportScope('project');
                      setSelectedAreaIds(new Set());
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
                        : 'Save all project issue areas locally or to OneDrive.'}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      if (exportScope === 'selected-areas') {
                        void handleExportSelectedAreas('onedrive');
                        return;
                      }
                      void handleExportProject('onedrive');
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
                      void handleExportProject('local');
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
                </>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
