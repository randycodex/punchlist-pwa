'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Project,
  Area,
  Checkpoint,
  getCheckpointIssueState,
  isAreaInspectionComplete,
  type IssueState,
} from '@/types';
import {
  getActiveProjectCount,
  getProjectForArea,
  saveProjectArea,
  saveProjectAreaMetadataOnly,
  createPhotoAttachment,
  createFileAttachment,
  createLocation,
  createItem,
  createCheckpoint,
} from '@/lib/db';
import { cacheProjectPreview, getCachedProjectPreview } from '@/lib/projectNavigationCache';
import { readLocalStorage, writeLocalStorage } from '@/lib/browserStorage';
import AreaEditorModal from '@/components/AreaEditorModal';
import AppConfirmDialog from '@/components/AppConfirmDialog';
import AppPromptDialog from '@/components/AppPromptDialog';
import {
  areaHasRecordedActivity,
  buildAreaName,
  buildFacadeLevelOptions,
  compareLevelNames,
  getFacadeInspectionLevels,
  getAreaFormValue,
  isApartmentArea,
  splitFacadeLevels,
  upsertFacadeElevationDrawing,
  type AreaTypeKey,
} from '@/lib/areas';
import {
  buildElevationMarkerReferenceMap,
  buildElevationMarkerReferences,
} from '@/lib/elevationMarkers';
import { applyTemplateToArea } from '@/lib/template';
import { getAreaReturnPath } from '@/lib/projectNavigation';
import {
  hasPendingSyncState,
  queuePendingSync,
} from '@/lib/pendingSync';
import { runManualOneDriveSync } from '@/features/sync/runManualOneDriveSync';
import { getInspectionAreaMetrics } from '@/features/inspection/inspectionMetrics';
import {
  CUSTOM_ITEMS_LOCATION_NAME,
  OTHER_LOCATION_NAME,
  checkpointHasFacadeListContent,
  checkpointHasStoredMedia,
  dedupeInspectionHierarchy,
  facadeAreaNeedsTemplateRefresh,
  itemHasStoredMedia,
  locationHasFacadeListContent,
  locationHasRecordedActivity,
  locationHasStoredMedia,
} from '@/features/inspection/inspectionContent';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import {
  claimSharedProjectArea,
  getCollaborationErrorMessage,
  getSharedProjectSnapshotMetadata,
  flushPendingSharedAreaSyncs,
  isSharedSnapshotNewer,
  queueSharedProjectAreaSync,
  releaseSharedProjectArea,
  resumePendingSharedAreaSyncs,
  SHARED_AREA_SYNC_EVENT,
  subscribeToSharedProjectAreaSnapshotChanges,
  subscribeToSharedProjectSnapshotChanges,
  type SharedAreaSyncEventDetail,
} from '@/lib/collaboration';
import AreaNotesCard from '@/components/inspection/AreaNotesCard';
import CustomItemComposer from '@/components/inspection/CustomItemComposer';
import FacadeElevationViewer, {
  type FacadeElevationSelection,
} from '@/components/inspection/FacadeElevationViewer';
import InspectionLocationCard from '@/components/inspection/InspectionLocationCard';
import Link from 'next/link';
import {
  ArrowLeft,
  ChevronsDown,
  ChevronsUp,
  MoreVertical,
  Trash2,
  UnlockKeyhole,
} from 'lucide-react';

const RECENT_COMMENTS_STORAGE_KEY = 'punchlist-recent-comments';
const RECENT_AREA_TYPES_STORAGE_KEY = 'punchlist-recent-area-types';
const MAX_RECENT_COMMENTS = 5;

function inspectionNamesMatch(left: string, right: string) {
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

type ConfirmDialogState = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
};

type PromptDialogState = {
  title: string;
  label: string;
  initialValue: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void | Promise<void>;
};

type CheckpointReviewState = 'pending' | 'ok' | 'open' | 'resolved' | 'verified';
type ScheduleSyncOptions = { fullSync?: boolean };
type SharedAreaLockProblem =
  | { kind: 'blocked'; message: string }
  | { kind: 'lost'; message: string }
  | null;

const SHARED_AREA_LOCK_BLOCKED_MESSAGE =
  'This shared area is locked by someone else. Try again after they release it, or return to the project.';
const SHARED_AREA_LOCK_LOST_MESSAGE =
  'Shared area lock lost. Try again before editing so your changes do not conflict.';

function isSharedAreaClaimBlockedMessage(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('claimed by another user') || normalized.includes('currently claimed');
}

export default function AreaDetailPage() {
  const params = useParams<{ id: string; areaId: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const areaId = Array.isArray(params.areaId) ? params.areaId[0] : params.areaId;
  const router = useRouter();
  const cachedProject = useMemo(() => getCachedProjectPreview(id), [id]);
  const cachedArea = cachedProject?.areas.find((entry) => entry.id === areaId && !entry.deletedAt) ?? null;
  const [project, setProject] = useState<Project | null>(() => (cachedArea ? cachedProject : null));
  const [area, setArea] = useState<Area | null>(() => cachedArea);
  const [loading, setLoading] = useState(() => !cachedArea);
  const [expandedLocations, setExpandedLocations] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [bulkExpansionMode, setBulkExpansionMode] = useState<'collapsed' | 'expanded'>('collapsed');
  const [generalNotesExpanded, setGeneralNotesExpanded] = useState(false);
  const [expandedCheckpoint, setExpandedCheckpoint] = useState<{
    locationId: string;
    itemId: string;
    checkpointId: string;
  } | null>(null);
  const [commentText, setCommentText] = useState('');
  const [recentComments, setRecentComments] = useState<string[]>([]);
  const [showEditArea, setShowEditArea] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedLocationIds, setSelectedLocationIds] = useState<Set<string>>(new Set());
  const [areaForm, setAreaForm] = useState(getAreaFormValue());
  const [recentAreaTypeKeys, setRecentAreaTypeKeys] = useState<AreaTypeKey[]>([]);
  const [customItemName, setCustomItemName] = useState('');
  const [showCustomItemComposer, setShowCustomItemComposer] = useState(false);
  const [customSubareaName, setCustomSubareaName] = useState('');
  const [showCustomSubareaComposer, setShowCustomSubareaComposer] = useState(false);
  const [editingCustomItem, setEditingCustomItem] = useState<{ locationId: string; itemId: string } | null>(null);
  const [customItemTargetLocationId, setCustomItemTargetLocationId] = useState<string | null>(null);
  const [customCheckpointName, setCustomCheckpointName] = useState('');
  const [showCustomCheckpointComposer, setShowCustomCheckpointComposer] = useState(false);
  const [customCheckpointTarget, setCustomCheckpointTarget] = useState<{
    locationId: string;
    itemId: string;
  } | null>(null);
  const [editingCustomCheckpoint, setEditingCustomCheckpoint] = useState<{
    locationId: string;
    itemId: string;
    checkpointId: string;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [inspectionNotice, setInspectionNotice] = useState<string | null>(null);
  const [areaClaimError, setAreaClaimError] = useState<string | null>(null);
  const [claimingArea, setClaimingArea] = useState(false);
  const [releasingAreaClaim, setReleasingAreaClaim] = useState(false);
  const [hasAreaClaim, setHasAreaClaim] = useState(false);
  const [areaClaimProblem, setAreaClaimProblem] = useState<SharedAreaLockProblem>(null);
  const [areaClaimRetryNonce, setAreaClaimRetryNonce] = useState(0);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [promptDialog, setPromptDialog] = useState<PromptDialogState | null>(null);
  const [generalNotes, setGeneralNotes] = useState('');
  const [returnToHome, setReturnToHome] = useState(false);
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesDraftRef = useRef('');
  const commentDraftRef = useRef('');
  const projectRef = useRef<Project | null>(null);
  const areaRef = useRef<Area | null>(null);
  const areaClaimProblemRef = useRef<SharedAreaLockProblem>(null);
  const scheduleSyncRef = useRef<(projectId?: string, options?: ScheduleSyncOptions) => void>(() => {});
  const loadDataRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const listRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement | null>());
  const locationRefs = useRef(new Map<string, HTMLDivElement | null>());
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const topMenuActionHandlerRef = useRef<((event: Event) => void) | null>(null);
  const { ensureAccessToken, signIn, isReady, isSignedIn } = useMicrosoftAuth();
  const collaborationAuth = useCollaborationAuth();
  const {
    clearSharedUpdateAvailable,
    markSharedUpdateAvailable,
    setRetryAt,
    setStatus: setSyncStatus,
    setSyncConflicts,
    sharedUpdateProjectIds,
  } = useSyncStatus();
  const { inspectionShowOnlyIssues, setInspectionShowOnlyIssues, quickSort, markSyncedNow } = useAppSettings();

  useEffect(() => {
    projectRef.current = project;
    areaRef.current = area;
    areaClaimProblemRef.current = areaClaimProblem;
    scheduleSyncRef.current = scheduleSync;
    loadDataRef.current = loadData;
  });

  useEffect(() => {
    if (!collaborationAuth.isSignedIn) return;
    resumePendingSharedAreaSyncs();
  }, [collaborationAuth.isSignedIn]);

  useEffect(() => {
    function handleSharedAreaSync(event: Event) {
      const detail = (event as CustomEvent<SharedAreaSyncEventDetail>).detail;
      const currentProject = projectRef.current;
      const currentArea = areaRef.current;
      if (
        !detail
        || !currentProject
        || !currentArea
        || detail.localProjectId !== currentProject.id
        || detail.areaId !== currentArea.id
      ) {
        return;
      }

      if (detail.status === 'conflict') {
        markSharedUpdateAvailable(currentProject.id);
        return;
      }
      if (!detail.areaVersion || !detail.publishedAt) return;
      const publishedAt = new Date(detail.publishedAt);
      if (Number.isNaN(publishedAt.getTime())) return;
      const currentAreaVersion = currentArea.sharedVersion ?? 0;
      if (detail.areaVersion >= currentAreaVersion) {
        currentArea.sharedVersion = detail.areaVersion;
        if ((currentArea.sharedPublishedAt?.getTime() ?? 0) <= publishedAt.getTime()) {
          currentArea.sharedPublishedAt = publishedAt;
        }
        if ((currentProject.sharedSnapshotPublishedAt?.getTime() ?? 0) < publishedAt.getTime()) {
          currentProject.sharedSnapshotPublishedAt = publishedAt;
        }
      }
      setProject({ ...currentProject, areas: [...currentProject.areas] });
      setArea({ ...currentArea });
    }

    window.addEventListener(SHARED_AREA_SYNC_EVENT, handleSharedAreaSync as EventListener);
    return () => {
      window.removeEventListener(SHARED_AREA_SYNC_EVENT, handleSharedAreaSync as EventListener);
    };
  }, [markSharedUpdateAvailable]);

  function sharedAreaEditsAreBlocked() {
    return Boolean(projectRef.current?.sharedProjectId && areaClaimProblemRef.current);
  }

  function canEditSharedArea() {
    return !sharedAreaEditsAreBlocked();
  }

  function replaceCheckpointCommentDraft(value: string) {
    commentDraftRef.current = value;
    setCommentText(value);
  }

  function trackCheckpointCommentDraft(value: string) {
    commentDraftRef.current = value;
  }

  function retrySharedAreaClaim() {
    setAreaClaimProblem(null);
    setAreaClaimError(null);
    setClaimingArea(true);
    setAreaClaimRetryNonce((value) => value + 1);
  }

  function returnToProjectFromSharedLock() {
    const currentProjectId = projectRef.current?.id ?? id;
    router.push(getAreaReturnPath(currentProjectId, returnToHome));
  }

  useEffect(() => {
    if (project) {
      cacheProjectPreview(project);
    }
  }, [project]);

  const persistGeneralNotes = useCallback(async (value: string) => {
    const currentProject = projectRef.current;
    const currentArea = areaRef.current;
    if (currentProject?.sharedProjectId && areaClaimProblemRef.current) return;
    if (!currentProject || !currentArea) return;
    const targetArea = currentProject.areas.find((entry) => entry.id === currentArea.id);
    if (!targetArea) return;
    if ((targetArea.notes ?? '') === value) return;
    targetArea.notes = value;
    targetArea.updatedAt = new Date();
    await saveProjectAreaMetadataOnly(currentProject, targetArea.id);
    scheduleSyncRef.current(currentProject.id);
    setProject({ ...currentProject, areas: [...currentProject.areas] });
    setArea({ ...targetArea });
  }, []);

  useEffect(() => {
    if (!id || !areaId) {
      router.push('/');
      return;
    }
    void loadDataRef.current();
    const savedRecentComments = readLocalStorage(RECENT_COMMENTS_STORAGE_KEY);
    if (savedRecentComments) {
      try {
        const nextRecentComments = (JSON.parse(savedRecentComments) as string[]).slice(0, MAX_RECENT_COMMENTS);
        setRecentComments(nextRecentComments);
        writeLocalStorage(RECENT_COMMENTS_STORAGE_KEY, JSON.stringify(nextRecentComments));
      } catch (error) {
        console.error('Failed to parse recent comments:', error);
      }
    }
    const savedRecentAreaTypes = readLocalStorage(RECENT_AREA_TYPES_STORAGE_KEY);
    if (savedRecentAreaTypes) {
      try {
        setRecentAreaTypeKeys(JSON.parse(savedRecentAreaTypes) as AreaTypeKey[]);
      } catch (error) {
        console.error('Failed to parse recent area types:', error);
      }
    }
  }, [id, areaId, router]);

  useEffect(() => {
    return () => {
      if (notesTimerRef.current) {
        clearTimeout(notesTimerRef.current);
        void persistGeneralNotes(notesDraftRef.current);
      }
    };
  }, [persistGeneralNotes]);

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
    if (!showHeaderMenu) return;

    function handleDocumentClick(event: MouseEvent) {
      if (!headerMenuRef.current?.contains(event.target as Node)) {
        setShowHeaderMenu(false);
      }
    }

    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, [showHeaderMenu]);

  useEffect(() => {
    const value = area?.notes ?? '';
    setGeneralNotes(value);
    notesDraftRef.current = value;
  }, [area?.id, area?.notes]);

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
    setAreaForm(getAreaFormValue(area));
  }, [area]);

  useEffect(() => {
    if (!collaborationAuth.isSignedIn || !project?.sharedProjectId || !area?.id) return;

    const localProjectId = project.id;
    const activeSharedProjectId = project.sharedProjectId;

    const unsubscribeSnapshotChanges = subscribeToSharedProjectSnapshotChanges(
      activeSharedProjectId,
      (change) => {
        const currentProject = projectRef.current;
        if (!currentProject || currentProject.id !== localProjectId) return;
        if (!change.publishedAt || isSharedSnapshotNewer(currentProject, change.publishedAt)) {
          markSharedUpdateAvailable(localProjectId);
        }
      }
    );
    const unsubscribeAreaChanges = subscribeToSharedProjectAreaSnapshotChanges(
      activeSharedProjectId,
      (change) => {
        if (change.publishedByUserId === collaborationAuth.user?.id) return;
        const currentProject = projectRef.current;
        if (!currentProject || currentProject.id !== localProjectId) return;
        if (!change.publishedAt || isSharedSnapshotNewer(currentProject, change.publishedAt)) {
          markSharedUpdateAvailable(localProjectId);
        }
      },
      area.id
    );

    return () => {
      unsubscribeSnapshotChanges();
      unsubscribeAreaChanges();
    };
  }, [
    area?.id,
    collaborationAuth.isSignedIn,
    collaborationAuth.user?.id,
    markSharedUpdateAvailable,
    project?.id,
    project?.sharedProjectId,
  ]);

  useEffect(() => {
    const sharedProjectId = project?.sharedProjectId;
    const currentAreaId = area?.id;
    if (!sharedProjectId || !currentAreaId) {
      setAreaClaimError(null);
      setAreaClaimProblem(null);
      setHasAreaClaim(false);
      setClaimingArea(false);
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      setAreaClaimError('Enable shared projects before working in this shared area.');
      setAreaClaimProblem({ kind: 'lost', message: 'Enable shared projects before editing this shared area.' });
      setHasAreaClaim(false);
      setClaimingArea(false);
      return;
    }

    let cancelled = false;
    setClaimingArea(true);
    setAreaClaimError(null);
    setAreaClaimProblem(null);
    setHasAreaClaim(true);

    void claimSharedProjectArea(sharedProjectId, currentAreaId)
      .then(() => {
        if (!cancelled) {
          setAreaClaimError(null);
          setAreaClaimProblem(null);
          setHasAreaClaim(true);
          resumePendingSharedAreaSyncs();
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = getCollaborationErrorMessage(error, 'Could not claim this shared area.');
        setAreaClaimError(message);
        setHasAreaClaim(false);
        setAreaClaimProblem({
          kind: isSharedAreaClaimBlockedMessage(message) ? 'blocked' : 'lost',
          message: isSharedAreaClaimBlockedMessage(message)
            ? SHARED_AREA_LOCK_BLOCKED_MESSAGE
            : SHARED_AREA_LOCK_LOST_MESSAGE,
        });
      })
      .finally(() => {
        if (!cancelled) {
          setClaimingArea(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [area?.id, areaClaimRetryNonce, collaborationAuth.isSignedIn, project?.sharedProjectId]);

  useEffect(() => {
    if (!areaClaimProblem) return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
  }, [areaClaimProblem]);

  const visibleLocations = useMemo(
    () =>
      area
        ? area.locations.filter(
            (location) => location.name.trim().toLowerCase() !== OTHER_LOCATION_NAME.toLowerCase()
          )
        : [],
    [area]
  );

  const customItemsLocation = useMemo(
    () =>
      visibleLocations.find(
        (location) => location.name.trim().toLowerCase() === CUSTOM_ITEMS_LOCATION_NAME.toLowerCase()
      ) ?? null,
    [visibleLocations]
  );

  const standardLocations = useMemo(
    () =>
      visibleLocations
        .filter((location) => location.name.trim().toLowerCase() !== CUSTOM_ITEMS_LOCATION_NAME.toLowerCase())
        .sort((a, b) => compareLevelNames(a.name, b.name)),
    [visibleLocations]
  );

  async function loadData() {
    if (!id || !areaId) return;
    try {
      const [activeProjectCount, projectData] = await Promise.all([
        getActiveProjectCount(),
        getProjectForArea(id, areaId),
      ]);
      setReturnToHome(activeProjectCount === 1);
      if (projectData) {
        if (projectData.deletedAt) {
          router.push('/');
          return;
        }
        const nextProject = projectData;
        if (collaborationAuth.isSignedIn && projectData.sharedProjectId) {
          try {
            const metadata = await getSharedProjectSnapshotMetadata(projectData.sharedProjectId);
            if (metadata && isSharedSnapshotNewer(projectData, metadata.publishedAt)) {
              markSharedUpdateAvailable(projectData.id);
            } else {
              clearSharedUpdateAvailable(projectData.id);
            }
          } catch (error) {
            console.info('Shared update check skipped:', error);
          }
        }
        setProject(nextProject);
        const areaData = nextProject.areas.find((a) => a.id === areaId);
        if (areaData && !areaData.deletedAt) {
          let inspectionHierarchyChanged = dedupeInspectionHierarchy(areaData);
          const normalizedLocations = areaData.locations.filter(
            (location) => location.name.trim().toLowerCase() !== OTHER_LOCATION_NAME.toLowerCase()
          );
          if (normalizedLocations.length !== areaData.locations.length) {
            areaData.locations = normalizedLocations.map((location, index) => ({
              ...location,
              sortOrder: index,
            }));
            inspectionHierarchyChanged = true;
          }
          if (facadeAreaNeedsTemplateRefresh(areaData)) {
            applyTemplateToArea(areaData, { preserveExisting: true });
            inspectionHierarchyChanged = true;
          }
          if (inspectionHierarchyChanged) {
            await saveProjectAreaMetadataOnly(nextProject, areaData.id);
            scheduleSync(nextProject.id);
          }
          setArea(areaData);
        } else {
          router.push(`/project/${id}`);
        }
      } else {
        router.push('/');
      }
    } catch (error) {
      console.error('Failed to load data:', error);
      router.push('/');
    } finally {
      setLoading(false);
    }
  }

  const areaDerived = useMemo(() => {
    if (!area) return null;
    return getInspectionAreaMetrics(visibleLocations);
  }, [area, visibleLocations]);

  const elevationMarkerRefsByCheckpoint = useMemo(
    () =>
      area
        ? buildElevationMarkerReferenceMap(area, {
            drawingId: area.elevationDrawingId,
            issuesOnly: true,
          })
        : new Map(),
    [area]
  );

  const filteredCustomItemsLocation = useMemo(() => {
    if (!customItemsLocation) return null;
    if (area?.areaTypeKey === 'facade' && inspectionShowOnlyIssues) {
      return locationHasFacadeListContent(customItemsLocation, area.elevationDrawingId)
        ? customItemsLocation
        : null;
    }
    if (!inspectionShowOnlyIssues) return customItemsLocation;
    return (areaDerived?.locationMetrics.get(customItemsLocation.id)?.stats.issues ?? 0) > 0
      ? customItemsLocation
      : null;
  }, [area?.areaTypeKey, area?.elevationDrawingId, customItemsLocation, inspectionShowOnlyIssues, areaDerived]);

  const filteredStandardLocations = useMemo(
    () => {
      if (area?.areaTypeKey === 'facade') {
        if (!inspectionShowOnlyIssues) return standardLocations;

        return standardLocations.filter((location) =>
          locationHasFacadeListContent(location, area.elevationDrawingId)
        );
      }

      return inspectionShowOnlyIssues
        ? standardLocations.filter(
            (location) => (areaDerived?.locationMetrics.get(location.id)?.stats.issues ?? 0) > 0
          )
        : standardLocations;
    },
    [area?.areaTypeKey, area?.elevationDrawingId, inspectionShowOnlyIssues, standardLocations, areaDerived]
  );

  const sortedStandardLocations = useMemo(() => {
    const hasSectionLabels = filteredStandardLocations.some((l) => l.sectionLabel);
    if (hasSectionLabels) return [...filteredStandardLocations].sort((a, b) => a.sortOrder - b.sortOrder);

    return [...filteredStandardLocations].sort((a, b) => {
      const levelCompare = compareLevelNames(a.name, b.name);
      if (levelCompare !== 0) return levelCompare;

      if (quickSort === 'alphabetical') {
        return a.sortOrder - b.sortOrder;
      }

      if (quickSort === 'issues') {
        const issuesA = areaDerived?.locationMetrics.get(a.id)?.stats.issues ?? 0;
        const issuesB = areaDerived?.locationMetrics.get(b.id)?.stats.issues ?? 0;
        if (issuesB !== issuesA) return issuesB - issuesA;
        return a.sortOrder - b.sortOrder;
      }

      const progressA = areaDerived?.locationMetrics.get(a.id)?.progress ?? 0;
      const progressB = areaDerived?.locationMetrics.get(b.id)?.progress ?? 0;
      if (progressB !== progressA) return progressB - progressA;
      return a.sortOrder - b.sortOrder;
    });
  }, [areaDerived, filteredStandardLocations, quickSort]);

  const getBulkExpandableItems = useCallback((targetLocation: Area['locations'][number]) => {
    const itemMetrics = areaDerived?.itemMetrics ?? new Map();
    const showFacadeRelevantItemsOnly = area?.areaTypeKey === 'facade' && inspectionShowOnlyIssues;

    function shouldShowCheckpoint(checkpoint: Checkpoint) {
      if (showFacadeRelevantItemsOnly && !checkpointHasFacadeListContent(checkpoint, area?.elevationDrawingId)) {
        return false;
      }
      return !inspectionShowOnlyIssues || getCheckpointIssueState(checkpoint) !== 'none';
    }

    if (showFacadeRelevantItemsOnly) {
      return targetLocation.items.filter((item) => item.checkpoints.some(shouldShowCheckpoint));
    }

    return inspectionShowOnlyIssues
      ? targetLocation.items.filter((item) => (itemMetrics.get(item.id)?.stats.issues ?? 0) > 0)
      : targetLocation.items;
  }, [area?.areaTypeKey, area?.elevationDrawingId, areaDerived?.itemMetrics, inspectionShowOnlyIssues]);

  const hasFacadeListContent = useMemo(
    () =>
      area?.areaTypeKey === 'facade'
        ? visibleLocations.some((location) =>
            locationHasFacadeListContent(location, area.elevationDrawingId)
          )
        : false,
    [area?.areaTypeKey, area?.elevationDrawingId, visibleLocations]
  );

  function findCheckpoint(locationId: string, itemId: string, checkpointId: string): Checkpoint | null {
    if (!area) return null;
    const location = area.locations.find((l) => l.id === locationId);
    if (!location) return null;
    const item = location.items.find((i) => i.id === itemId);
    if (!item) return null;
    return item.checkpoints.find((c) => c.id === checkpointId) || null;
  }

  function syncAreaCompletion(targetArea: Area) {
    targetArea.isComplete = isAreaInspectionComplete(targetArea);
    targetArea.updatedAt = new Date();
  }

  async function updateCheckpointReviewState(
    locationId: string,
    itemId: string,
    checkpointId: string,
    nextState: CheckpointReviewState | 'pending'
  ) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    const checkpoint = findCheckpoint(locationId, itemId, checkpointId);
    if (!checkpoint) return;

    if (nextState === 'pending') {
      checkpoint.issueState = 'none';
      checkpoint.status = 'pending';
      checkpoint.fixStatus = 'pending';
    } else if (nextState === 'ok') {
      checkpoint.issueState = 'none';
      checkpoint.status = 'ok';
      checkpoint.fixStatus = 'pending';
    } else {
      const nextIssueState: Exclude<IssueState, 'none'> = nextState;
      checkpoint.issueState = nextIssueState;
      checkpoint.status = 'needsReview';
      checkpoint.fixStatus =
        nextIssueState === 'verified' ? 'verified' : nextIssueState === 'resolved' ? 'fixed' : 'pending';
    }
    checkpoint.updatedAt = new Date();
    syncAreaCompletion(area);
    await saveProjectAreaMetadataOnly(project, area.id);
    scheduleSync(project.id);
    setArea({ ...area });
  }

  async function persistCheckpointComment(
    locationId: string,
    itemId: string,
    checkpointId: string,
    value: string
  ) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    const checkpoint = findCheckpoint(locationId, itemId, checkpointId);
    if (!checkpoint) return;
    if (checkpoint.comments === value) return;

    checkpoint.comments = value;
    checkpoint.updatedAt = new Date();
    syncAreaCompletion(area);
    await saveProjectAreaMetadataOnly(project, area.id);
    scheduleSync(project.id);

    const trimmedComment = value.trim();
    if (trimmedComment) {
      const nextRecentComments = [
        trimmedComment,
        ...recentComments.filter((comment) => comment !== trimmedComment),
      ].slice(0, MAX_RECENT_COMMENTS);
      setRecentComments(nextRecentComments);
      writeLocalStorage(RECENT_COMMENTS_STORAGE_KEY, JSON.stringify(nextRecentComments));
    }

    setArea({ ...area });
  }

  async function saveAreaChanges(options: { skipResetConfirm?: boolean; skipFacadeConfirm?: boolean } = {}) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    if (!targetArea) return;

    const originalTypeKey = targetArea.areaTypeKey;
    const originalUnitType = targetArea.unitType;
    const originalAreaNumber = targetArea.areaNumber;
    const originalElevationDrawingId = targetArea.elevationDrawingId;
    const originalFacadeLevels = getFacadeInspectionLevels(targetArea);
    const originalFacadeLevel = originalFacadeLevels.join(',');
    const hadRecordedActivityBeforeTemplateChange = areaHasRecordedActivity(targetArea);
    let removedLocationsWithActivity: Area['locations'] = [];
    const nextName = buildAreaName(areaForm);
    targetArea.name = nextName;
    targetArea.areaTypeKey = areaForm.areaTypeKey;
    targetArea.unitType = areaForm.unitType || undefined;
    targetArea.customAreaName = areaForm.customAreaName.trim() || undefined;
    targetArea.areaNumber = areaForm.areaNumber.trim() || undefined;
    targetArea.facadeLevel = areaForm.facadeLevel.trim() || undefined;
    targetArea.elevationDrawingId =
      areaForm.areaTypeKey === 'facade' ? areaForm.elevationDrawingId || undefined : undefined;

    const templateChanged =
      originalTypeKey !== areaForm.areaTypeKey ||
      originalUnitType !== (areaForm.unitType || undefined) ||
      originalAreaNumber !== (areaForm.areaNumber.trim() || undefined);
    const facadeLevelsChanged =
      areaForm.areaTypeKey === 'facade' &&
      originalTypeKey === 'facade' &&
      originalFacadeLevel !== areaForm.facadeLevel.trim();
    if (templateChanged) {
      if (
        hadRecordedActivityBeforeTemplateChange &&
        !options.skipResetConfirm
      ) {
        targetArea.name = area.name;
        targetArea.areaTypeKey = originalTypeKey;
        targetArea.unitType = originalUnitType;
        targetArea.customAreaName = area.customAreaName;
        targetArea.areaNumber = area.areaNumber;
        targetArea.facadeLevel = originalFacadeLevel;
        targetArea.elevationDrawingId = originalElevationDrawingId;
        setConfirmDialog({
          title: 'Reset Area Checklist',
          message: 'Changing this area will reset checklist issues, comments, and images for this unit. Continue?',
          confirmLabel: 'Continue',
          danger: true,
          onConfirm: async () => {
            setConfirmDialog(null);
            await saveAreaChanges({ skipResetConfirm: true });
          },
        });
        return;
      }
      applyTemplateToArea(targetArea);
    } else if (facadeLevelsChanged) {
      const nextLevels = new Set(splitFacadeLevels(areaForm.facadeLevel));
      const removedActiveLevels = originalFacadeLevels.filter((level) => !nextLevels.has(level));
      removedLocationsWithActivity = targetArea.locations.filter(
        (location) => removedActiveLevels.includes(location.name) && locationHasRecordedActivity(location)
      );

      if (
        removedLocationsWithActivity.length > 0 &&
        !options.skipFacadeConfirm
      ) {
        targetArea.name = area.name;
        targetArea.areaTypeKey = originalTypeKey;
        targetArea.unitType = originalUnitType;
        targetArea.customAreaName = area.customAreaName;
        targetArea.areaNumber = area.areaNumber;
        targetArea.facadeLevel = originalFacadeLevel;
        targetArea.elevationDrawingId = originalElevationDrawingId;
        setConfirmDialog({
          title: 'Remove Facade Floors',
          message: `Removing ${removedLocationsWithActivity.map((location) => location.name).join(', ')} will delete recorded checklist information for those floors. Continue?`,
          confirmLabel: 'Continue',
          danger: true,
          onConfirm: async () => {
            setConfirmDialog(null);
            await saveAreaChanges({ skipFacadeConfirm: true });
          },
        });
        return;
      }

      applyTemplateToArea(targetArea, { preserveExisting: true });
    }

    const shouldUseFullSave =
      Boolean(areaForm.pendingElevationDrawing) ||
      (templateChanged && hadRecordedActivityBeforeTemplateChange) ||
      removedLocationsWithActivity.some(locationHasStoredMedia);

    upsertFacadeElevationDrawing(project, areaForm.pendingElevationDrawing);
    syncAreaCompletion(targetArea);
    targetArea.updatedAt = new Date();
    if (shouldUseFullSave) {
      await saveProjectArea(project, targetArea.id, { includeElevationDrawings: true });
    } else {
      await saveProjectAreaMetadataOnly(project, targetArea.id);
    }
    scheduleSync(project.id);

    const nextRecentAreaTypeKeys = [
      areaForm.areaTypeKey,
      ...recentAreaTypeKeys.filter((key) => key !== areaForm.areaTypeKey),
    ].slice(0, 8);
    setRecentAreaTypeKeys(nextRecentAreaTypeKeys);
    writeLocalStorage(RECENT_AREA_TYPES_STORAGE_KEY, JSON.stringify(nextRecentAreaTypeKeys));

    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
    setShowEditArea(false);
  }

  async function handleSubmitCustomItem() {
    if (!canEditSharedArea()) return;
    if (!project || !area || !customItemName.trim()) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    if (!targetArea) return;

    const trimmedName = customItemName.trim();
    if (editingCustomItem) {
      const targetLocation = targetArea.locations.find((location) => location.id === editingCustomItem.locationId);
      const targetItem = targetLocation?.items.find((item) => item.id === editingCustomItem.itemId);
      if (!targetLocation || !targetItem) return;
      if (
        targetLocation.items.some(
          (item) => item.id !== targetItem.id && inspectionNamesMatch(item.name, trimmedName)
        )
      ) {
        setInspectionNotice(`An item named “${trimmedName}” already exists here.`);
        return;
      }

      targetItem.name = trimmedName;
      syncAreaCompletion(targetArea);
      await saveProjectAreaMetadataOnly(project, targetArea.id);
      scheduleSync(project.id);

      setCustomItemName('');
      setEditingCustomItem(null);
      setShowCustomItemComposer(false);
      setProject({ ...project, areas: [...project.areas] });
      setArea({ ...targetArea });
      return;
    }

    let targetLocation = customItemTargetLocationId
      ? targetArea.locations.find((location) => location.id === customItemTargetLocationId) ?? null
      : null;

    if (!targetLocation) {
      targetLocation = targetArea.locations.find((location) => location.name === CUSTOM_ITEMS_LOCATION_NAME) ?? null;
    }

    if (!targetLocation) {
      targetLocation = createLocation(targetArea.id, CUSTOM_ITEMS_LOCATION_NAME, targetArea.locations.length);
      targetArea.locations.push(targetLocation);
      targetArea.locations.forEach((location, index) => {
        location.sortOrder = index;
      });
    }

    if (targetLocation.items.some((item) => inspectionNamesMatch(item.name, trimmedName))) {
      setInspectionNotice(`An item named “${trimmedName}” already exists here.`);
      return;
    }

    const item = createItem(targetLocation.id, trimmedName, targetLocation.items.length, { isCustom: true });
    targetLocation.items.push(item);
    targetLocation.items.forEach((entry, index) => {
      entry.sortOrder = index;
    });
    syncAreaCompletion(targetArea);

    await saveProjectAreaMetadataOnly(project, targetArea.id);
    scheduleSync(project.id);

    setCustomItemName('');
    setEditingCustomItem(null);
    setCustomItemTargetLocationId(null);
    setShowCustomItemComposer(false);
    setExpandedLocations(new Set([targetLocation.id]));
    setExpandedItems(new Set([item.id]));
    setExpandedCheckpoint(null);
    replaceCheckpointCommentDraft('');
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleSubmitCustomSubarea() {
    if (!canEditSharedArea()) return;
    if (!project || !area || !customSubareaName.trim()) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    if (!targetArea) return;

    const trimmedName = customSubareaName.trim();
    if (targetArea.locations.some((location) => inspectionNamesMatch(location.name, trimmedName))) {
      setInspectionNotice(`A sub-area named “${trimmedName}” already exists here.`);
      return;
    }

    const location = createLocation(targetArea.id, trimmedName, targetArea.locations.length, {
      isCustom: true,
    });
    targetArea.locations.push(location);
    targetArea.locations.forEach((entry, index) => {
      entry.sortOrder = index;
    });

    syncAreaCompletion(targetArea);
    await saveProjectAreaMetadataOnly(project, targetArea.id);
    scheduleSync(project.id);

    setCustomSubareaName('');
    setShowCustomSubareaComposer(false);
    setExpandedLocations(new Set([location.id]));
    setExpandedItems(new Set());
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  function handleEditCustomItem(locationId: string, itemId: string, currentName: string) {
    if (!canEditSharedArea()) return;
    setEditingCustomItem({ locationId, itemId });
    setCustomItemTargetLocationId(locationId);
    setCustomItemName(currentName);
    setShowCustomItemComposer(false);
  }

  function handleCancelCustomItemEdit() {
    setCustomItemName('');
    setEditingCustomItem(null);
    setCustomItemTargetLocationId(null);
  }

  async function handleSubmitCustomCheckpoint() {
    if (!canEditSharedArea()) return;
    if (!project || !area || !customCheckpointTarget || !customCheckpointName.trim()) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    const targetLocation = targetArea?.locations.find((location) => location.id === customCheckpointTarget.locationId);
    const targetItem = targetLocation?.items.find((item) => item.id === customCheckpointTarget.itemId);
    if (!targetArea || !targetLocation || !targetItem) return;

    if (editingCustomCheckpoint) {
      const checkpoint = targetItem.checkpoints.find((entry) => entry.id === editingCustomCheckpoint.checkpointId);
      if (!checkpoint) return;

      const trimmedName = customCheckpointName.trim();
      if (
        targetItem.checkpoints.some(
          (entry) => entry.id !== checkpoint.id && inspectionNamesMatch(entry.name, trimmedName)
        )
      ) {
        setInspectionNotice(`A sub-item named “${trimmedName}” already exists here.`);
        return;
      }

      checkpoint.name = trimmedName;
      checkpoint.updatedAt = new Date();

      syncAreaCompletion(targetArea);
      await saveProjectAreaMetadataOnly(project, targetArea.id);
      scheduleSync(project.id);

      setCustomCheckpointName('');
      setShowCustomCheckpointComposer(false);
      setCustomCheckpointTarget(null);
      setEditingCustomCheckpoint(null);
      setProject({ ...project, areas: [...project.areas] });
      setArea({ ...targetArea });
      return;
    }

    const trimmedName = customCheckpointName.trim();
    if (targetItem.checkpoints.some((checkpoint) => inspectionNamesMatch(checkpoint.name, trimmedName))) {
      setInspectionNotice(`A sub-item named “${trimmedName}” already exists here.`);
      return;
    }

    const checkpoint = createCheckpoint(
      targetItem.id,
      trimmedName,
      targetItem.checkpoints.length,
      { isCustom: true }
    );
    checkpoint.issueState = 'open';
    checkpoint.status = 'needsReview';
    checkpoint.fixStatus = 'pending';
    targetItem.checkpoints.push(checkpoint);
    targetItem.checkpoints.forEach((entry, index) => {
      entry.sortOrder = index;
    });

    syncAreaCompletion(targetArea);
    await saveProjectAreaMetadataOnly(project, targetArea.id);
    scheduleSync(project.id);

    setCustomCheckpointName('');
    setShowCustomCheckpointComposer(false);
    setCustomCheckpointTarget(null);
    setEditingCustomCheckpoint(null);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleEditCustomCheckpoint(
    locationId: string,
    itemId: string,
    checkpointId: string,
    currentName: string
  ) {
    if (!canEditSharedArea()) return;
    setCustomCheckpointTarget({ locationId, itemId });
    setCustomCheckpointName(currentName);
    setEditingCustomCheckpoint({ locationId, itemId, checkpointId });
    setShowCustomCheckpointComposer(false);
  }

  function handleCancelCustomCheckpointEdit() {
    setCustomCheckpointName('');
    setCustomCheckpointTarget(null);
    setEditingCustomCheckpoint(null);
  }

  async function handleDeleteCustomCheckpoint(locationId: string, itemId: string, checkpointId: string) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    const targetLocation = targetArea?.locations.find((location) => location.id === locationId);
    const targetItem = targetLocation?.items.find((item) => item.id === itemId);
    if (!targetArea || !targetLocation || !targetItem) return;

    const removedCheckpoint = targetItem.checkpoints.find((checkpoint) => checkpoint.id === checkpointId);
    const removedStoredMedia = removedCheckpoint ? checkpointHasStoredMedia(removedCheckpoint) : false;
    targetItem.checkpoints = targetItem.checkpoints.filter((checkpoint) => checkpoint.id !== checkpointId);
    targetItem.checkpoints.forEach((checkpoint, index) => {
      checkpoint.sortOrder = index;
    });

    if (targetItem.checkpoints.length === 0 && targetItem.isCustom) {
      targetLocation.items = targetLocation.items.filter((item) => item.id !== itemId);
      targetLocation.items.forEach((item, index) => {
        item.sortOrder = index;
      });
      setExpandedItems((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
      if (targetLocation.items.length === 0 && targetLocation.name === CUSTOM_ITEMS_LOCATION_NAME) {
        targetArea.locations = targetArea.locations.filter((location) => location.id !== targetLocation.id);
        targetArea.locations.forEach((location, index) => {
          location.sortOrder = index;
        });
        setExpandedLocations((prev) => {
          const next = new Set(prev);
          next.delete(locationId);
          return next;
        });
      }
    }

    if (expandedCheckpoint?.checkpointId === checkpointId) {
      setExpandedCheckpoint(null);
      replaceCheckpointCommentDraft('');
    }
    if (editingCustomCheckpoint?.checkpointId === checkpointId) {
      setCustomCheckpointName('');
      setShowCustomCheckpointComposer(false);
      setCustomCheckpointTarget(null);
      setEditingCustomCheckpoint(null);
    }

    syncAreaCompletion(targetArea);
    if (removedStoredMedia) {
      await saveProjectArea(project, targetArea.id);
    } else {
      await saveProjectAreaMetadataOnly(project, targetArea.id);
    }
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleDeleteCustomItem(locationId: string, itemId: string) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    const targetLocation = targetArea?.locations.find((location) => location.id === locationId);
    if (!targetArea || !targetLocation) return;

    const removedItem = targetLocation.items.find((item) => item.id === itemId);
    const removedStoredMedia = removedItem ? itemHasStoredMedia(removedItem) : false;
    targetLocation.items = targetLocation.items.filter((item) => item.id !== itemId);
    targetLocation.items.forEach((item, index) => {
      item.sortOrder = index;
    });
    if (targetLocation.items.length === 0 && targetLocation.name === CUSTOM_ITEMS_LOCATION_NAME) {
      targetArea.locations = targetArea.locations.filter((location) => location.id !== targetLocation.id);
      targetArea.locations.forEach((location, index) => {
        location.sortOrder = index;
      });
    }

    if (expandedCheckpoint?.itemId === itemId) {
      setExpandedCheckpoint(null);
      replaceCheckpointCommentDraft('');
    }
    setExpandedItems((prev) => {
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });

    syncAreaCompletion(targetArea);
    if (removedStoredMedia) {
      await saveProjectArea(project, targetArea.id);
    } else {
      await saveProjectAreaMetadataOnly(project, targetArea.id);
    }
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleEditCustomLocation(locationId: string, currentName: string) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    setPromptDialog({
      title: 'Edit Item',
      label: 'Item name',
      initialValue: currentName,
      confirmLabel: 'Save',
      onConfirm: async (value) => {
        setPromptDialog(null);
        await renameCustomLocation(locationId, currentName, value);
      },
    });
  }

  async function renameCustomLocation(locationId: string, currentName: string, value: string) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    const nextName = value.trim();
    if (!nextName || nextName === currentName) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    const targetLocation = targetArea?.locations.find((location) => location.id === locationId);
    if (!targetArea || !targetLocation) return;

    targetLocation.name = nextName;
    targetLocation.updatedAt = new Date();

    syncAreaCompletion(targetArea);
    await saveProjectAreaMetadataOnly(project, targetArea.id);
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleDeleteCustomLocation(locationId: string) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    if (!targetArea) return;

    const removedLocation = targetArea.locations.find((location) => location.id === locationId);
    const removedStoredMedia = removedLocation ? locationHasStoredMedia(removedLocation) : false;
    targetArea.locations = targetArea.locations.filter((location) => location.id !== locationId);
    targetArea.locations.forEach((location, index) => {
      location.sortOrder = index;
    });

    setExpandedLocations((prev) => {
      const next = new Set(prev);
      next.delete(locationId);
      return next;
    });
    setSelectedLocationIds((prev) => {
      const next = new Set(prev);
      next.delete(locationId);
      return next;
    });

    syncAreaCompletion(targetArea);
    if (removedStoredMedia) {
      await saveProjectArea(project, targetArea.id);
    } else {
      await saveProjectAreaMetadataOnly(project, targetArea.id);
    }
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  const toggleLocationSelection = useCallback((locationId: string) => {
    setSelectedLocationIds((prev) => {
      const next = new Set(prev);
      if (next.has(locationId)) next.delete(locationId);
      else next.add(locationId);
      return next;
    });
  }, []);

  function cancelSelectionMode() {
    setDeleteMode(false);
    setSelectedLocationIds(new Set());
  }

  async function handleDeleteSelectedLocations() {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;
    if (selectedLocationIds.size === 0) {
      cancelSelectionMode();
      return;
    }

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    if (!targetArea) return;

    targetArea.locations = targetArea.locations.filter((location) => !selectedLocationIds.has(location.id));
    targetArea.locations.forEach((location, index) => {
      location.sortOrder = index;
    });

    syncAreaCompletion(targetArea);
    await saveProjectArea(project, targetArea.id);
    scheduleSync(project.id);

    setExpandedLocations(new Set());
    setExpandedItems(new Set());
    setExpandedCheckpoint(null);
    replaceCheckpointCommentDraft('');
    setDeleteMode(false);
    setSelectedLocationIds(new Set());
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleAddPhoto(
    locationId: string,
    itemId: string,
    checkpointId: string,
    imageData: string,
    thumbnail?: string
  ) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    const checkpoint = findCheckpoint(locationId, itemId, checkpointId);
    if (!checkpoint) return;

    const photo = createPhotoAttachment(checkpointId, imageData, thumbnail);
    checkpoint.photos.push(photo);
    checkpoint.updatedAt = new Date();
    syncAreaCompletion(area);
    await saveProjectArea(project, area.id);
    scheduleSync(project.id);
    setArea({ ...area });
  }

  async function handleAddPhotos(
    locationId: string,
    itemId: string,
    checkpointId: string,
    photos: Array<{ imageData: string; thumbnail?: string }>
  ) {
    if (!canEditSharedArea()) return;
    if (!project || !area || photos.length === 0) return;

    const checkpoint = findCheckpoint(locationId, itemId, checkpointId);
    if (!checkpoint) return;

    for (const photoInput of photos) {
      checkpoint.photos.push(
        createPhotoAttachment(checkpointId, photoInput.imageData, photoInput.thumbnail)
      );
    }
    checkpoint.updatedAt = new Date();
    syncAreaCompletion(area);
    await saveProjectArea(project, area.id);
    scheduleSync(project.id);
    setArea({ ...area });
  }

  async function handleDeletePhoto(
    locationId: string,
    itemId: string,
    checkpointId: string,
    photoId: string
  ) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    const checkpoint = findCheckpoint(locationId, itemId, checkpointId);
    if (!checkpoint) return;

    checkpoint.photos = checkpoint.photos.filter((p) => p.id !== photoId);
    checkpoint.updatedAt = new Date();
    syncAreaCompletion(area);
    await saveProjectArea(project, area.id);
    scheduleSync(project.id);
    setArea({ ...area });
  }

  async function handleAddFiles(
    locationId: string,
    itemId: string,
    checkpointId: string,
    files: Array<{ data: string; name: string; mimeType: string; size: number }>
  ) {
    if (!canEditSharedArea()) return;
    if (!project || !area || files.length === 0) return;

    const checkpoint = findCheckpoint(locationId, itemId, checkpointId);
    if (!checkpoint) return;
    checkpoint.files = checkpoint.files ?? [];

    for (const fileInput of files) {
      checkpoint.files.push(
        createFileAttachment(
          checkpointId,
          fileInput.data,
          fileInput.name,
          fileInput.mimeType,
          fileInput.size
        )
      );
    }
    checkpoint.updatedAt = new Date();
    syncAreaCompletion(area);
    await saveProjectArea(project, area.id);
    scheduleSync(project.id);
    setArea({ ...area });
  }

  async function handleDeleteFile(
    locationId: string,
    itemId: string,
    checkpointId: string,
    fileId: string
  ) {
    if (!canEditSharedArea()) return;
    if (!project || !area) return;

    const checkpoint = findCheckpoint(locationId, itemId, checkpointId);
    if (!checkpoint) return;

    checkpoint.files = (checkpoint.files ?? []).filter((f) => f.id !== fileId);
    checkpoint.updatedAt = new Date();
    syncAreaCompletion(area);
    await saveProjectArea(project, area.id);
    scheduleSync(project.id);
    setArea({ ...area });
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
      await loadData();
    } finally {
      setSyncing(false);
    }
  }

  topMenuActionHandlerRef.current = (event: Event) => {
    const customEvent = event as CustomEvent<{ action: string }>;
    const detail = customEvent.detail;
    if (!detail) return;

    if (detail.action === 'sync-now') {
      void handleSync();
    }
  };

  async function handleReleaseAreaClaim() {
    if (!project?.sharedProjectId || !area || releasingAreaClaim) return;

    setReleasingAreaClaim(true);
    setSyncError(null);
    try {
      await closeExpandedCheckpoint();
      await flushPendingSharedAreaSyncs();
      await releaseSharedProjectArea(project.sharedProjectId, area.id);
      setHasAreaClaim(false);
      setAreaClaimError(null);
      router.push(getAreaReturnPath(project.id, returnToHome));
    } catch (error) {
      console.error('Failed to release shared area claim:', error);
      setSyncError(getCollaborationErrorMessage(error, 'Failed to release this shared area lock.'));
    } finally {
      setReleasingAreaClaim(false);
    }
  }

  function handleGeneralNotesChange(value: string) {
    if (!canEditSharedArea()) return;
    notesDraftRef.current = value;
    if (notesTimerRef.current) {
      clearTimeout(notesTimerRef.current);
    }
    notesTimerRef.current = setTimeout(() => {
      void persistGeneralNotes(value);
    }, 400);
  }

  function scrollLocationToListAnchor(locationId: string) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scroller = listRef.current;
        const target = locationRefs.current.get(locationId);
        if (!scroller || !target) return;

        const scrollerRect = scroller.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const scrollerPaddingTop = Number.parseFloat(window.getComputedStyle(scroller).paddingTop) || 0;
        const targetTop = scrollerRect.top + scrollerPaddingTop;

        scroller.scrollTo({
          top: scroller.scrollTop + targetRect.top - targetTop,
          behavior: 'smooth',
        });
      });
    });
  }

  function scheduleSync(projectId?: string, options?: ScheduleSyncOptions) {
    queuePendingSync(projectId, options);
    setSyncStatus('pending');
    const currentProject = projectRef.current;
    const currentArea = areaRef.current;
    if (
      currentProject?.sharedProjectId
      && currentArea
      && (!projectId || projectId === currentProject.id)
    ) {
      void queueSharedProjectAreaSync(currentProject, currentArea.id).catch((error) => {
        console.info('Shared area update remains local until it can be queued:', error);
      });
    }
  }

  async function closeExpandedCheckpoint() {
    if (!canEditSharedArea()) return;
    if (!expandedCheckpoint) return;
    await persistCheckpointComment(
      expandedCheckpoint.locationId,
      expandedCheckpoint.itemId,
      expandedCheckpoint.checkpointId,
      commentDraftRef.current
    );
    setExpandedCheckpoint(null);
    replaceCheckpointCommentDraft('');
  }

  async function toggleLocation(locationId: string) {
    if (expandedLocations.has(locationId)) {
      await closeExpandedCheckpoint();
      if (bulkExpansionMode === 'expanded') {
        const targetLocation = [
          ...sortedStandardLocations,
          ...(filteredCustomItemsLocation ? [filteredCustomItemsLocation] : []),
        ].find((entry) => entry.id === locationId);
        const targetItemIds = new Set((targetLocation ? getBulkExpandableItems(targetLocation) : []).map((item) => item.id));
        setExpandedLocations((current) => {
          const next = new Set(current);
          next.delete(locationId);
          return next;
        });
        setExpandedItems((current) => {
          const next = new Set(current);
          targetItemIds.forEach((itemId) => next.delete(itemId));
          return next;
        });
      } else {
        setExpandedLocations(new Set());
        setExpandedItems(new Set());
      }
    } else {
      await closeExpandedCheckpoint();
      if (bulkExpansionMode === 'expanded') {
        const targetLocation = [
          ...sortedStandardLocations,
          ...(filteredCustomItemsLocation ? [filteredCustomItemsLocation] : []),
        ].find((entry) => entry.id === locationId);
        setExpandedLocations((current) => new Set([...current, locationId]));
        setExpandedItems((current) => new Set([
          ...current,
          ...(targetLocation ? getBulkExpandableItems(targetLocation).map((item) => item.id) : []),
        ]));
      } else {
        setExpandedLocations(new Set([locationId]));
        setExpandedItems(new Set());
        setGeneralNotesExpanded(false);
      }
      scrollLocationToListAnchor(locationId);
    }
  }

  async function toggleGeneralNotes() {
    if (generalNotesExpanded) {
      setGeneralNotesExpanded(false);
      return;
    }

    await closeExpandedCheckpoint();
    if (bulkExpansionMode !== 'expanded') {
      setExpandedLocations(new Set());
      setExpandedItems(new Set());
    }
    setGeneralNotesExpanded(true);
  }

  async function toggleItem(itemId: string) {
    setShowCustomCheckpointComposer(false);
    setCustomCheckpointName('');
    setCustomCheckpointTarget(null);
    setEditingCustomCheckpoint(null);

    if (expandedItems.has(itemId)) {
      await closeExpandedCheckpoint();
      if (bulkExpansionMode === 'expanded') {
        setExpandedItems((current) => {
          const next = new Set(current);
          next.delete(itemId);
          return next;
        });
      } else {
        setExpandedItems(new Set());
      }
    } else {
      await closeExpandedCheckpoint();
      if (bulkExpansionMode === 'expanded') {
        setExpandedItems((current) => new Set([...current, itemId]));
      } else {
        setExpandedItems(new Set([itemId]));
      }
    }
  }

  async function handleToggleBulkExpansion() {
    setShowCustomCheckpointComposer(false);
    setCustomCheckpointName('');
    setCustomCheckpointTarget(null);
    setEditingCustomCheckpoint(null);
    await closeExpandedCheckpoint();

    if (bulkExpansionMode === 'expanded') {
      setExpandedLocations(new Set());
      setExpandedItems(new Set());
      setGeneralNotesExpanded(false);
      setBulkExpansionMode('collapsed');
      return;
    }

    const visibleExpandableLocations = [
      ...sortedStandardLocations,
      ...(filteredCustomItemsLocation ? [filteredCustomItemsLocation] : []),
    ];
    setExpandedLocations(new Set(sortedStandardLocations.map((location) => location.id)));
    setExpandedItems(
      new Set(
        visibleExpandableLocations.flatMap((location) =>
          getBulkExpandableItems(location).map((item) => item.id)
        )
      )
    );
    setGeneralNotesExpanded(true);
    setBulkExpansionMode('expanded');
  }

  async function openElevationSelection({
    locationId,
    itemId,
    checkpointId,
    xPercent,
    yPercent,
    customItemName,
    customCheckpointName,
  }: FacadeElevationSelection) {
    if (!canEditSharedArea()) return;
    if (!project || !area?.elevationDrawingId) return;

    setShowCustomCheckpointComposer(false);
    setCustomCheckpointName('');
    setCustomCheckpointTarget(null);
    setEditingCustomCheckpoint(null);
    await closeExpandedCheckpoint();

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    const targetLocation = targetArea?.locations.find((location) => location.id === locationId);
    if (!targetArea || !targetLocation) return;

    let targetItem = targetLocation.items.find((item) => item.id === itemId);
    let sourceCheckpoint = targetItem?.checkpoints.find((entry) => entry.id === checkpointId);
    let issueName = sourceCheckpoint?.name;
    let sourceCheckpointId = sourceCheckpoint?.sourceCheckpointId ?? sourceCheckpoint?.id;
    const trimmedCustomItemName = customItemName?.trim();
    const trimmedCustomCheckpointName = customCheckpointName?.trim();

    if (trimmedCustomItemName && trimmedCustomCheckpointName) {
      const customTargetItem =
        targetLocation.items.find(
          (item) => item.isCustom && item.name.trim().toLowerCase() === trimmedCustomItemName.toLowerCase()
        ) ??
        createItem(targetLocation.id, trimmedCustomItemName, targetLocation.items.length, {
          isCustom: true,
        });

      if (!targetLocation.items.some((item) => item.id === customTargetItem.id)) {
        targetLocation.items.push(customTargetItem);
      }
      targetLocation.items.forEach((entry, index) => {
        entry.sortOrder = index;
      });
      targetItem = customTargetItem;
      sourceCheckpoint = undefined;
      issueName = trimmedCustomCheckpointName;
      sourceCheckpointId = undefined;
    }

    if (!targetItem || !issueName) return;

    const checkpoint = createCheckpoint(targetItem.id, issueName, targetItem.checkpoints.length, {
      isCustom: Boolean(trimmedCustomItemName && trimmedCustomCheckpointName),
      isElevationIssue: true,
      sourceCheckpointId,
    });
    checkpoint.elevationMarker = {
      drawingId: area.elevationDrawingId,
      xPercent,
      yPercent,
    };
    checkpoint.issueState = 'open';
    checkpoint.status = 'needsReview';
    checkpoint.fixStatus = 'pending';
    checkpoint.updatedAt = new Date();
    targetItem.checkpoints.push(checkpoint);
    targetItem.checkpoints.forEach((entry, index) => {
      entry.sortOrder = index;
    });
    syncAreaCompletion(targetArea);
    await saveProjectAreaMetadataOnly(project, targetArea.id);
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });

    setExpandedLocations(new Set([locationId]));
    setExpandedItems(new Set([targetItem.id]));
    setExpandedCheckpoint({ locationId, itemId: targetItem.id, checkpointId: checkpoint.id });
    replaceCheckpointCommentDraft(checkpoint.comments);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        itemRefs.current.get(targetItem.id)?.scrollIntoView({
          block: 'start',
          behavior: 'smooth',
        });
      });
    });
  }

  async function toggleCheckpoint(
    locationId: string,
    itemId: string,
    checkpointId: string,
    comments: string
  ) {
    const isSameCheckpoint =
      expandedCheckpoint?.locationId === locationId &&
      expandedCheckpoint?.itemId === itemId &&
      expandedCheckpoint?.checkpointId === checkpointId;

    await closeExpandedCheckpoint();

    if (isSameCheckpoint) {
      return;
    }

    setExpandedCheckpoint({ locationId, itemId, checkpointId });
    replaceCheckpointCommentDraft(comments);
  }

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--background)]">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-black/10 border-t-[var(--accent)] dark:border-white/10 dark:border-t-[var(--accent)]" />
      </div>
    );
  }

  if (!project || !area) {
    return null;
  }

  const areaTitle = isApartmentArea(area)
    ? [area.unitType?.trim(), area.areaNumber?.trim()].filter(Boolean).join(' - ') || area.name
    : area.name;
  const elevationDrawing = area.elevationDrawingId
    ? project.facadeElevationDrawings?.find((drawing) => drawing.id === area.elevationDrawingId) ?? null
    : null;

  const visibleAreaClaimProblem = project.sharedProjectId ? areaClaimProblem : null;
  const areaEditingLocked = Boolean(visibleAreaClaimProblem);
  const supportsInlineLocationCustomItems = true;
  const supportsCustomSubareas = isApartmentArea(area) && !deleteMode && !areaEditingLocked;
  const supportsGlobalCustomItems = !supportsInlineLocationCustomItems && !deleteMode && !areaEditingLocked;
  const flattenSingleStairsLocation =
    !deleteMode && !isApartmentArea(area) && sortedStandardLocations.length === 1;
  const canReleaseAreaClaim = Boolean(
    project.sharedProjectId &&
    hasAreaClaim &&
    !claimingArea &&
    !areaClaimError &&
    !areaClaimProblem
  );
  const visibleLiveSharedUpdate = Boolean(
    collaborationAuth.isSignedIn &&
    project.sharedProjectId &&
    sharedUpdateProjectIds.has(project.id)
  );
  const sharedAreaClaimLabel = visibleAreaClaimProblem
    ? visibleAreaClaimProblem.kind === 'blocked'
      ? 'Area in use by someone else'
      : 'Shared lock needs attention'
    : areaClaimError
    ? 'Shared claim needs attention'
    : releasingAreaClaim
      ? 'Releasing shared lock...'
      : claimingArea
        ? 'Claiming shared area...'
      : hasAreaClaim
        ? 'Locked to you until you release it'
        : 'Shared area claimed';

  return (
    <div className="app-page flex h-full flex-col overflow-hidden">
      <header className="header-stable shrink-0 border-b z-20">
        <div className="page-header-surface mx-auto flex min-h-[4.9rem] w-full max-w-6xl items-center px-4 py-3 sm:px-5">
          <div className="flex w-full items-center gap-3">
            <Link
              href={getAreaReturnPath(project.id, returnToHome)}
              className="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-600 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="min-w-0 flex flex-1 flex-col">
              <h1 className="truncate text-[1.12rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
                {areaTitle}
              </h1>
              {project.sharedProjectId && (
                <div className="mt-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                  {sharedAreaClaimLabel}
                </div>
              )}
            </div>
            <button
              onClick={() => setInspectionShowOnlyIssues(!inspectionShowOnlyIssues)}
              className={`flex h-10 items-center gap-2 rounded-full px-3 text-sm font-medium transition ${
                inspectionShowOnlyIssues
                  ? 'accent-tint accent-text'
                  : 'border border-black/5 bg-white/70 text-gray-500 hover:bg-white hover:text-gray-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white'
              }`}
              aria-label={inspectionShowOnlyIssues ? 'Show all items' : 'Show only issues'}
              aria-pressed={inspectionShowOnlyIssues}
            >
              <span className="text-[0.92rem] font-medium">Issues</span>
            </button>
            <div ref={headerMenuRef} className="relative">
              <button
                onClick={() => setShowHeaderMenu((current) => !current)}
                className="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-500 transition hover:bg-white hover:text-gray-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-400 dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
                aria-label="Area actions"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {showHeaderMenu && (
                <div className="menu-surface absolute right-0 top-[calc(100%+0.6rem)] z-40 w-[14rem] rounded-[1.5rem] p-2">
                  <div className="space-y-1">
                    {canReleaseAreaClaim && (
                      <button
                        onClick={() => {
                          setShowHeaderMenu(false);
                          void handleReleaseAreaClaim();
                        }}
                        disabled={releasingAreaClaim}
                        className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-[0.98rem] text-gray-700 transition hover:bg-black/[0.04] disabled:opacity-50 dark:text-gray-200 dark:hover:bg-white/[0.06]"
                      >
                        <UnlockKeyhole className="h-4 w-4" />
                        {releasingAreaClaim ? 'Releasing lock...' : 'Release lock'}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setShowHeaderMenu(false);
                        if (areaEditingLocked) return;
                        setAreaForm(getAreaFormValue(area));
                        setShowEditArea(true);
                      }}
                      disabled={areaEditingLocked}
                      className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-[0.98rem] text-gray-700 transition hover:bg-black/[0.04] disabled:opacity-50 dark:text-gray-200 dark:hover:bg-white/[0.06]"
                    >
                      <MoreVertical className="h-4 w-4" />
                      Edit area
                    </button>
                    <button
                      onClick={() => {
                        setShowHeaderMenu(false);
                        void handleToggleBulkExpansion();
                      }}
                      className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-[0.98rem] text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                    >
                      {bulkExpansionMode === 'expanded' ? (
                        <ChevronsUp className="h-4 w-4" />
                      ) : (
                        <ChevronsDown className="h-4 w-4" />
                      )}
                      {bulkExpansionMode === 'expanded' ? 'Collapse all' : 'Expand all'}
                    </button>
                  </div>
                </div>
              )}
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
                onClick={() => void handleDeleteSelectedLocations()}
                disabled={selectedLocationIds.size === 0 || areaEditingLocked}
                className="accent-text accent-tint hover:accent-tint-strong flex h-10 w-10 items-center justify-center rounded-full transition disabled:opacity-40"
                aria-label="Delete selected sub-areas"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </header>

      {areaClaimError && !visibleAreaClaimProblem && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">
          {areaClaimError}
        </div>
      )}

      {visibleAreaClaimProblem && (
        <div
          className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-300/20 dark:bg-amber-400/10 dark:text-amber-100"
          aria-live="assertive"
        >
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 flex-1 font-medium">{visibleAreaClaimProblem.message}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={retrySharedAreaClaim}
                className="inline-flex h-9 items-center justify-center rounded-full bg-amber-700 px-3 text-xs font-semibold text-white transition hover:bg-amber-800 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={returnToProjectFromSharedLock}
                className="inline-flex h-9 items-center justify-center rounded-full border border-amber-300 bg-white/70 px-3 text-xs font-semibold text-amber-950 transition hover:bg-white dark:border-amber-200/30 dark:bg-white/[0.06] dark:text-amber-100 dark:hover:bg-white/[0.1]"
              >
                Back to project
              </button>
            </div>
          </div>
        </div>
      )}

      {promptDialog && (
        <AppPromptDialog
          title={promptDialog.title}
          label={promptDialog.label}
          initialValue={promptDialog.initialValue}
          confirmLabel={promptDialog.confirmLabel}
          onCancel={() => setPromptDialog(null)}
          onConfirm={(value) => void promptDialog.onConfirm(value)}
        />
      )}

      {syncError && (
        <div className="shrink-0 border-b border-gray-200/80 bg-white/70 px-4 py-2 text-sm text-gray-700 dark:border-zinc-700 dark:bg-white/[0.03] dark:text-gray-200">
          {syncError}
        </div>
      )}

      {inspectionNotice && (
        <div className="shrink-0 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-900 dark:border-emerald-300/20 dark:bg-emerald-400/10 dark:text-emerald-100" aria-live="polite">
          {inspectionNotice}
        </div>
      )}

      {visibleLiveSharedUpdate && (
        <div
          className="shrink-0 border-b border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-950 dark:border-sky-300/20 dark:bg-sky-400/10 dark:text-sky-100"
          aria-live="polite"
        >
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 flex-1 font-medium">
              A team update is available. Your current inspection stays on this device until you pull it manually.
            </p>
            <button
              type="button"
              onClick={() => router.push(`/project/${project.id}`)}
              className="inline-flex h-9 w-fit items-center justify-center rounded-full bg-sky-700 px-3 text-xs font-semibold text-white transition hover:bg-sky-800 dark:bg-sky-200 dark:text-sky-950 dark:hover:bg-sky-100"
            >
              Review
            </button>
          </div>
        </div>
      )}
      {/* Inspection Items */}
      <main
        ref={listRef}
        className={`flex-1 min-h-0 overflow-y-scroll overscroll-y-contain touch-pan-y px-4 pb-[calc(env(safe-area-inset-bottom)+3.5rem)] sm:px-5 ${
          deleteMode ? '-mt-[8.4rem] pt-[9.65rem]' : '-mt-[4.9rem] pt-[6.15rem]'
        }`}
      >
        <div
          className={`list-stack mx-auto min-h-[calc(100%+1px)] w-full max-w-6xl transition-opacity ${
            areaEditingLocked ? 'pointer-events-none opacity-60' : ''
          }`}
          aria-disabled={areaEditingLocked}
        >
          {!deleteMode && area.areaTypeKey === 'facade' && elevationDrawing && (
            <FacadeElevationViewer
              drawing={elevationDrawing}
              locations={area.locations}
              markers={buildElevationMarkerReferences(area, {
                drawingId: elevationDrawing.id,
                issuesOnly: true,
              })}
              onOpenSelection={openElevationSelection}
            />
          )}
          {!deleteMode &&
            area.areaTypeKey === 'facade' &&
            elevationDrawing &&
            inspectionShowOnlyIssues &&
            !hasFacadeListContent && (
              <div className="empty-state-card rounded-[1.4rem] px-4 py-4 text-sm font-medium text-gray-500 dark:text-gray-300">
                No marked facade issues yet.
              </div>
            )}
          {supportsGlobalCustomItems && !editingCustomItem && (
            <CustomItemComposer
              open={showCustomItemComposer}
              value={customItemName}
              submitLabel={editingCustomItem ? 'Save' : 'Add'}
              onOpen={() => setShowCustomItemComposer(true)}
              onClose={() => {
                setShowCustomItemComposer(false);
                setCustomItemName('');
                setEditingCustomItem(null);
                setCustomItemTargetLocationId(null);
              }}
              onChange={setCustomItemName}
              onSubmit={() => void handleSubmitCustomItem()}
            />
          )}
          {sortedStandardLocations.map((location, index) => {
            const prevLabel = index > 0 ? sortedStandardLocations[index - 1].sectionLabel : undefined;
            const showSectionHeader = location.sectionLabel && location.sectionLabel !== prevLabel;
            const standardItems = location.items.filter((item) => !item.isCustom);
            const primaryStandardItem =
              standardItems.length === 1 &&
              standardItems[0].name.trim().toLowerCase() === location.name.trim().toLowerCase()
                ? standardItems[0]
                : null;
            return (
            <div
              key={location.id}
              ref={(node) => {
                locationRefs.current.set(location.id, node);
              }}
            >
              {showSectionHeader && (
                <div className="px-1 pb-1 pt-3 text-xs font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
                  {location.sectionLabel}
                </div>
              )}
              <InspectionLocationCard
                location={location}
                locationMetric={areaDerived?.locationMetrics.get(location.id)}
                itemMetrics={areaDerived?.itemMetrics ?? new Map()}
                elevationMarkerRefsByCheckpoint={elevationMarkerRefsByCheckpoint}
                showFacadeRelevantItemsOnly={area.areaTypeKey === 'facade' && inspectionShowOnlyIssues}
                deleteMode={deleteMode}
                isSelected={selectedLocationIds.has(location.id)}
                onToggleSelection={toggleLocationSelection}
                showOnlyIssues={inspectionShowOnlyIssues}
                expandedItems={expandedItems}
                isExpanded={!deleteMode && (flattenSingleStairsLocation || expandedLocations.has(location.id))}
                alwaysExpanded={!deleteMode && flattenSingleStairsLocation}
                hideHeader={!deleteMode && flattenSingleStairsLocation}
                onToggleLocation={toggleLocation}
                onToggleItem={toggleItem}
                onEditCustomLocation={handleEditCustomLocation}
                onDeleteCustomLocation={handleDeleteCustomLocation}
                onToggleCheckpoint={({ locationId, itemId, checkpointId, comments }) =>
                  void toggleCheckpoint(locationId, itemId, checkpointId, comments)
                }
                onCommentBlur={(locationId, itemId, checkpointId, value) =>
                  void persistCheckpointComment(locationId, itemId, checkpointId, value)
                }
                onUpdateCheckpointStatus={(locationId, itemId, checkpointId, nextState) =>
                  void updateCheckpointReviewState(locationId, itemId, checkpointId, nextState)
                }
                expandedCheckpointId={expandedCheckpoint?.checkpointId ?? null}
                commentText={commentText}
                recentComments={recentComments}
                onCommentChange={trackCheckpointCommentDraft}
                onAddPhoto={(imageData, thumbnail) =>
                  expandedCheckpoint
                    ? handleAddPhoto(
                        expandedCheckpoint.locationId,
                        expandedCheckpoint.itemId,
                        expandedCheckpoint.checkpointId,
                        imageData,
                        thumbnail
                      )
                    : Promise.resolve()
                }
                onAddPhotos={(photos) =>
                  expandedCheckpoint
                    ? handleAddPhotos(
                        expandedCheckpoint.locationId,
                        expandedCheckpoint.itemId,
                        expandedCheckpoint.checkpointId,
                        photos
                      )
                    : Promise.resolve()
                }
                onAddFiles={(files) =>
                  expandedCheckpoint
                    ? handleAddFiles(
                        expandedCheckpoint.locationId,
                        expandedCheckpoint.itemId,
                        expandedCheckpoint.checkpointId,
                        files
                      )
                    : Promise.resolve()
                }
                onDeletePhoto={(photoId) =>
                  expandedCheckpoint
                    ? handleDeletePhoto(
                        expandedCheckpoint.locationId,
                        expandedCheckpoint.itemId,
                        expandedCheckpoint.checkpointId,
                        photoId
                      )
                    : Promise.resolve()
                }
                onDeleteFile={(fileId) =>
                  expandedCheckpoint
                    ? handleDeleteFile(
                        expandedCheckpoint.locationId,
                        expandedCheckpoint.itemId,
                        expandedCheckpoint.checkpointId,
                        fileId
                      )
                    : Promise.resolve()
                }
                registerItemRef={(itemId, node) => {
                  itemRefs.current.set(itemId, node);
                }}
                editingCustomItemId={editingCustomItem?.locationId === location.id ? editingCustomItem.itemId : null}
                editingCustomItemName={customItemName}
                onEditingCustomItemChange={setCustomItemName}
                onSaveCustomItemEdit={() => void handleSubmitCustomItem()}
                onCancelCustomItemEdit={handleCancelCustomItemEdit}
                onEditCustomItem={handleEditCustomItem}
                onDeleteCustomItem={handleDeleteCustomItem}
                editingCustomCheckpointId={editingCustomCheckpoint?.itemId && editingCustomCheckpoint.locationId === location.id ? editingCustomCheckpoint.checkpointId : null}
                editingCustomCheckpointName={customCheckpointName}
                onEditingCustomCheckpointChange={setCustomCheckpointName}
                onSaveCustomCheckpointEdit={() => void handleSubmitCustomCheckpoint()}
                onCancelCustomCheckpointEdit={handleCancelCustomCheckpointEdit}
                onEditCustomCheckpoint={handleEditCustomCheckpoint}
                onDeleteCustomCheckpoint={handleDeleteCustomCheckpoint}
                renderCheckpointAddControl={
                  supportsInlineLocationCustomItems
                    ? (locationId, itemId) => (
                        <CustomItemComposer
                          open={
                            showCustomCheckpointComposer &&
                            customCheckpointTarget?.locationId === locationId &&
                            customCheckpointTarget?.itemId === itemId
                          }
                          value={customCheckpointName}
                          triggerLabel="+ Sub Item"
                          valuePlaceholder="Sub-item name"
                          submitLabel={editingCustomCheckpoint ? 'Save' : 'Add'}
                          onOpen={() => {
                            setCustomCheckpointTarget({ locationId, itemId });
                            setCustomCheckpointName('');
                            setEditingCustomCheckpoint(null);
                            setShowCustomCheckpointComposer(true);
                          }}
                          onClose={() => {
                            setShowCustomCheckpointComposer(false);
                            setCustomCheckpointName('');
                            setCustomCheckpointTarget(null);
                            setEditingCustomCheckpoint(null);
                          }}
                          onChange={setCustomCheckpointName}
                          onSubmit={() => void handleSubmitCustomCheckpoint()}
                        />
                      )
                    : undefined
                }
                addItemControl={
                  supportsInlineLocationCustomItems && !editingCustomItem ? (
                    <CustomItemComposer
                      open={
                        primaryStandardItem
                          ? showCustomCheckpointComposer &&
                            customCheckpointTarget?.locationId === location.id &&
                            customCheckpointTarget?.itemId === primaryStandardItem.id
                          : showCustomItemComposer && customItemTargetLocationId === location.id
                      }
                      value={primaryStandardItem ? customCheckpointName : customItemName}
                      valuePlaceholder={primaryStandardItem ? 'Item name' : undefined}
                      submitLabel={primaryStandardItem ? (editingCustomCheckpoint ? 'Save' : 'Add') : editingCustomItem ? 'Save' : 'Add'}
                      onOpen={() => {
                        if (primaryStandardItem) {
                          setCustomCheckpointTarget({ locationId: location.id, itemId: primaryStandardItem.id });
                          setCustomCheckpointName('');
                          setEditingCustomCheckpoint(null);
                          setShowCustomCheckpointComposer(true);
                        } else {
                          setCustomItemTargetLocationId(location.id);
                          setEditingCustomItem(null);
                          setCustomItemName('');
                          setShowCustomItemComposer(true);
                        }
                      }}
                      onClose={() => {
                        if (primaryStandardItem) {
                          setShowCustomCheckpointComposer(false);
                          setCustomCheckpointName('');
                          setCustomCheckpointTarget(null);
                          setEditingCustomCheckpoint(null);
                        } else {
                          setShowCustomItemComposer(false);
                          setCustomItemTargetLocationId(null);
                          setCustomItemName('');
                          setEditingCustomItem(null);
                        }
                      }}
                      onChange={primaryStandardItem ? setCustomCheckpointName : setCustomItemName}
                      onSubmit={() => void (primaryStandardItem ? handleSubmitCustomCheckpoint() : handleSubmitCustomItem())}
                    />
                  ) : null
                }
              />
            </div>
            );
          })}
          {supportsCustomSubareas ? (
            <CustomItemComposer
              open={showCustomSubareaComposer}
              value={customSubareaName}
              triggerLabel="+ Sub Area"
              valuePlaceholder="Subarea name"
              submitLabel="Add"
              onOpen={() => setShowCustomSubareaComposer(true)}
              onClose={() => {
                setShowCustomSubareaComposer(false);
                setCustomSubareaName('');
              }}
              onChange={setCustomSubareaName}
              onSubmit={() => void handleSubmitCustomSubarea()}
            />
          ) : null}
          {!deleteMode && filteredCustomItemsLocation && (
            <InspectionLocationCard
              key={filteredCustomItemsLocation.id}
              location={filteredCustomItemsLocation}
              locationMetric={areaDerived?.locationMetrics.get(filteredCustomItemsLocation.id)}
              itemMetrics={areaDerived?.itemMetrics ?? new Map()}
              elevationMarkerRefsByCheckpoint={elevationMarkerRefsByCheckpoint}
              showFacadeRelevantItemsOnly={area.areaTypeKey === 'facade' && inspectionShowOnlyIssues}
              showOnlyIssues={inspectionShowOnlyIssues}
              expandedItems={expandedItems}
              isExpanded
              alwaysExpanded
              hideHeader
              onToggleLocation={toggleLocation}
              onToggleItem={toggleItem}
              onToggleCheckpoint={({ locationId, itemId, checkpointId, comments }) =>
                void toggleCheckpoint(locationId, itemId, checkpointId, comments)
              }
              onCommentBlur={(locationId, itemId, checkpointId, value) =>
                void persistCheckpointComment(locationId, itemId, checkpointId, value)
              }
              onUpdateCheckpointStatus={(locationId, itemId, checkpointId, nextState) =>
                void updateCheckpointReviewState(locationId, itemId, checkpointId, nextState)
              }
              expandedCheckpointId={expandedCheckpoint?.checkpointId ?? null}
              commentText={commentText}
              recentComments={recentComments}
              onCommentChange={trackCheckpointCommentDraft}
              onAddPhoto={(imageData, thumbnail) =>
                expandedCheckpoint
                  ? handleAddPhoto(
                      expandedCheckpoint.locationId,
                      expandedCheckpoint.itemId,
                      expandedCheckpoint.checkpointId,
                      imageData,
                      thumbnail
                    )
                  : Promise.resolve()
              }
              onAddPhotos={(photos) =>
                expandedCheckpoint
                  ? handleAddPhotos(
                      expandedCheckpoint.locationId,
                      expandedCheckpoint.itemId,
                      expandedCheckpoint.checkpointId,
                      photos
                    )
                  : Promise.resolve()
              }
              onAddFiles={(files) =>
                expandedCheckpoint
                  ? handleAddFiles(
                      expandedCheckpoint.locationId,
                      expandedCheckpoint.itemId,
                      expandedCheckpoint.checkpointId,
                      files
                    )
                  : Promise.resolve()
              }
              onDeletePhoto={(photoId) =>
                expandedCheckpoint
                  ? handleDeletePhoto(
                      expandedCheckpoint.locationId,
                      expandedCheckpoint.itemId,
                      expandedCheckpoint.checkpointId,
                      photoId
                    )
                  : Promise.resolve()
              }
              onDeleteFile={(fileId) =>
                expandedCheckpoint
                  ? handleDeleteFile(
                      expandedCheckpoint.locationId,
                      expandedCheckpoint.itemId,
                      expandedCheckpoint.checkpointId,
                      fileId
                    )
                  : Promise.resolve()
              }
              registerItemRef={(itemId, node) => {
                itemRefs.current.set(itemId, node);
              }}
              editingCustomItemId={editingCustomItem?.locationId === filteredCustomItemsLocation.id ? editingCustomItem.itemId : null}
              editingCustomItemName={customItemName}
              onEditingCustomItemChange={setCustomItemName}
              onSaveCustomItemEdit={() => void handleSubmitCustomItem()}
              onCancelCustomItemEdit={handleCancelCustomItemEdit}
              onEditCustomItem={handleEditCustomItem}
              onDeleteCustomItem={handleDeleteCustomItem}
              editingCustomCheckpointId={
                editingCustomCheckpoint?.locationId === filteredCustomItemsLocation.id
                  ? editingCustomCheckpoint.checkpointId
                  : null
              }
              editingCustomCheckpointName={customCheckpointName}
              onEditingCustomCheckpointChange={setCustomCheckpointName}
              onSaveCustomCheckpointEdit={() => void handleSubmitCustomCheckpoint()}
              onCancelCustomCheckpointEdit={handleCancelCustomCheckpointEdit}
              onEditCustomCheckpoint={handleEditCustomCheckpoint}
              onDeleteCustomCheckpoint={handleDeleteCustomCheckpoint}
            />
          )}
          {!deleteMode && (
            <AreaNotesCard
              key={area.id}
              value={generalNotes}
              isExpanded={generalNotesExpanded}
              onToggle={() => void toggleGeneralNotes()}
              onChange={handleGeneralNotesChange}
              onBlur={(value) => {
                if (notesTimerRef.current) {
                  clearTimeout(notesTimerRef.current);
                }
                notesDraftRef.current = value;
                void persistGeneralNotes(value);
              }}
            />
          )}
          <div className="mt-auto pt-1" />
        </div>
      </main>

      <AreaEditorModal
        key={showEditArea ? `edit-${area.id}` : 'closed'}
        open={showEditArea && !areaEditingLocked}
        title="Edit Area"
        value={areaForm}
        recentAreaTypeKeys={recentAreaTypeKeys}
        facadeLevelOptions={buildFacadeLevelOptions(project)}
        facadeElevationDrawings={project.facadeElevationDrawings ?? []}
        enableFacadeLevelBatch
        lockAreaType
        onChange={setAreaForm}
        onClose={() => {
          setAreaForm(getAreaFormValue(area));
          setShowEditArea(false);
        }}
        onSubmit={() => void saveAreaChanges()}
        submitLabel="Save"
      />
      {confirmDialog && (
        <AppConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          danger={confirmDialog.danger}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={() => void confirmDialog.onConfirm()}
        />
      )}
    </div>
  );
}
