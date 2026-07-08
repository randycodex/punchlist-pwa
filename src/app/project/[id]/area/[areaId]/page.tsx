'use client';

import { useState, useEffect, useMemo, useRef, useCallback, type TouchEvent } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Project,
  Area,
  Checkpoint,
  getCheckpointIssueState,
  getReviewMetrics,
  checkpointHasIssue,
  isAreaInspectionComplete,
  type IssueState,
} from '@/types';
import {
  getActiveProjectCount,
  getProject,
  saveProject,
  saveProjectMetadataOnly,
  saveProjectPreserveTimestamps,
  createPhotoAttachment,
  createFileAttachment,
  createLocation,
  createItem,
  createCheckpoint,
} from '@/lib/db';
import { cacheProjectPreview, getCachedProjectPreview } from '@/lib/projectNavigationCache';
import {
  formatMicrosoftManualRetryMessage,
  getMicrosoftErrorMessage,
  getMicrosoftRetryDelayMs,
} from '@/lib/microsoftErrors';
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
import {
  formatSyncConflictReviewMessage,
  syncProjectsWithOneDriveRecovery,
} from '@/lib/oneDriveSyncRecovery';
import { reserveLaunchOneDriveSync, resetLaunchOneDriveSyncReservations } from '@/lib/autoOneDriveSync';
import { queueBackgroundProjectMediaHydration, resetBackgroundMediaHydration } from '@/lib/backgroundMediaHydration';
import {
  queueBackgroundSharedProjectPublish,
  queueStaleBackgroundSharedProjectPublishes,
  resetBackgroundSharedProjectPublish,
} from '@/lib/backgroundSharedPublish';
import {
  clearPendingSyncState,
  getPendingSyncWaitMs,
  hasPendingSyncState,
  isPendingSyncAutoRetryPaused,
  loadPendingSyncState,
  pausePendingSyncAutoRetry,
  queuePendingSync,
  recordPendingSyncRetry,
  resumePendingSyncAutoRetry,
  shouldPausePendingSyncAutoRetry,
} from '@/lib/pendingSync';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import {
  claimSharedProjectArea,
  getCollaborationErrorMessage,
  getCollaborationRuntimeConfig,
  getAreaClaimExpiry,
  getSharedProjectSnapshot,
  hasNewerLocalChangesThanSharedSnapshot,
  isSharedSnapshotNewer,
  releaseSharedProjectArea,
  subscribeToSharedProjectSnapshotChanges,
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
const CUSTOM_ITEMS_LOCATION_NAME = 'Custom Items';
const OTHER_LOCATION_NAME = 'Other';
const MAX_RECENT_COMMENTS = 5;
const AUTO_SYNC_DELAY_MS = 2_500;
const REQUIRED_FACADE_ITEM_NAMES = [
  'Doors',
  'Storefront',
  'Planting',
  'Light Fixture',
  'Security Camera',
  'Fence',
  'Signage',
  'Canopy',
  'Louvers',
];

function locationHasRecordedActivity(location: Area['locations'][number]) {
  return location.items.some((item) =>
    item.checkpoints.some(
      (checkpoint) =>
        checkpoint.status !== 'pending' ||
        checkpoint.comments.trim().length > 0 ||
        Boolean(checkpoint.elevationMarker) ||
        checkpoint.photos.length > 0 ||
        (checkpoint.files?.length ?? 0) > 0
    )
  );
}

function checkpointHasStoredMedia(checkpoint: Checkpoint) {
  return checkpoint.photos.length > 0 || (checkpoint.files?.length ?? 0) > 0;
}

function itemHasStoredMedia(item: Area['locations'][number]['items'][number]) {
  return item.checkpoints.some(checkpointHasStoredMedia);
}

function locationHasStoredMedia(location: Area['locations'][number]) {
  return location.items.some(itemHasStoredMedia);
}

function checkpointHasFacadeListContent(checkpoint: Checkpoint, drawingId?: string) {
  const hasComments = checkpoint.comments.trim().length > 0;
  const hasMedia = checkpoint.photos.length > 0 || (checkpoint.files?.length ?? 0) > 0;

  if (checkpoint.isElevationIssue) {
    const matchesDrawing = !drawingId || checkpoint.elevationMarker?.drawingId === drawingId;
    return matchesDrawing && (checkpointHasIssue(checkpoint) || hasComments || hasMedia);
  }

  return (
    checkpoint.status !== 'pending' ||
    checkpointHasIssue(checkpoint) ||
    hasComments ||
    hasMedia ||
    Boolean(checkpoint.elevationMarker)
  );
}

function locationHasFacadeListContent(location: Area['locations'][number], drawingId?: string) {
  return location.items.some((item) =>
    item.checkpoints.some((checkpoint) => checkpointHasFacadeListContent(checkpoint, drawingId))
  );
}

function facadeAreaNeedsTemplateRefresh(area: Area) {
  if (area.areaTypeKey !== 'facade') return false;
  const standardLocations = area.locations.filter(
    (location) =>
      !location.isCustom &&
      location.name.trim().toLowerCase() !== CUSTOM_ITEMS_LOCATION_NAME.toLowerCase() &&
      location.name.trim().toLowerCase() !== OTHER_LOCATION_NAME.toLowerCase()
  );
  if (standardLocations.length === 0) return false;

  return standardLocations.some((location) => {
    const itemNames = new Set(location.items.map((item) => item.name));
    return REQUIRED_FACADE_ITEM_NAMES.some((itemName) => !itemNames.has(itemName));
  });
}

type StatusMetrics = {
  total: number;
  ok: number;
  issues: number;
};

type ItemMetrics = {
  stats: StatusMetrics;
  pending: number;
  photoCount: number;
  commentCount: number;
};

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

type LocationMetrics = {
  stats: StatusMetrics;
  pending: number;
  progress: number;
  photoCount: number;
  commentCount: number;
};

type CheckpointReviewState = 'pending' | 'ok' | 'open' | 'resolved' | 'verified';
type ScheduleSyncOptions = { fullSync?: boolean };
type LiveSharedUpdateState =
  | { kind: 'waiting-for-draft'; message: string }
  | { kind: 'local-newer'; message: string }
  | null;
type SharedAreaLockProblem =
  | { kind: 'blocked'; message: string }
  | { kind: 'lost'; message: string }
  | null;

const LIVE_SHARED_WAITING_MESSAGE = 'Shared update ready. It will apply automatically when this edit is finished.';
const LIVE_SHARED_LOCAL_NEWER_MESSAGE =
  'Shared update ready. Review it from the project page to keep your local edits safe.';
const SHARED_AREA_LOCK_BLOCKED_MESSAGE =
  'This shared area is in use by someone else. Try again when they leave, or return to the project.';
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
  const cachedProject = getCachedProjectPreview(id);
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
  const [liveSharedUpdate, setLiveSharedUpdate] = useState<LiveSharedUpdateState>(null);
  const [areaClaimError, setAreaClaimError] = useState<string | null>(null);
  const [claimingArea, setClaimingArea] = useState(false);
  const [releasingAreaClaim, setReleasingAreaClaim] = useState(false);
  const [areaClaimExpiresAt, setAreaClaimExpiresAt] = useState<Date | null>(null);
  const [areaClaimProblem, setAreaClaimProblem] = useState<SharedAreaLockProblem>(null);
  const [areaClaimRetryNonce, setAreaClaimRetryNonce] = useState(0);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [promptDialog, setPromptDialog] = useState<PromptDialogState | null>(null);
  const [generalNotes, setGeneralNotes] = useState('');
  const [returnToHome, setReturnToHome] = useState(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesDraftRef = useRef('');
  const projectRef = useRef<Project | null>(null);
  const areaRef = useRef<Area | null>(null);
  const areaClaimProblemRef = useRef<SharedAreaLockProblem>(null);
  const liveSharedRefreshBlockedRef = useRef(false);
  const pendingLiveSharedRefreshRef = useRef(false);
  const retryLiveSharedRefreshRef = useRef<() => void>(() => {});
  const scheduleSyncRef = useRef<(projectId?: string, options?: ScheduleSyncOptions) => void>(() => {});
  const scheduleOneDriveSyncRef = useRef<(delayMs?: number, options?: { silentStatus?: boolean }) => void>(() => {});
  const loadDataRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const pullStartYRef = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const pullArmedRef = useRef(false);
  const listRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement | null>());
  const locationRefs = useRef(new Map<string, HTMLDivElement | null>());
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const topMenuActionHandlerRef = useRef<((event: Event) => void) | null>(null);
  const { ensureAccessToken, isReady, isSignedIn, accountEmail, accountName } = useMicrosoftAuth();
  const ensureAccessTokenRef = useRef(ensureAccessToken);
  const collaborationAuth = useCollaborationAuth();
  const { setRetryAt, setStatus: setSyncStatus } = useSyncStatus();
  const { inspectionShowOnlyIssues, setInspectionShowOnlyIssues, quickSort, markSyncedNow } = useAppSettings();

  useEffect(() => {
    projectRef.current = project;
    areaRef.current = area;
    areaClaimProblemRef.current = areaClaimProblem;
    scheduleSyncRef.current = scheduleSync;
    scheduleOneDriveSyncRef.current = scheduleOneDriveSync;
    ensureAccessTokenRef.current = ensureAccessToken;
    loadDataRef.current = loadData;
  });

  const pauseAutoSyncRetry = useCallback(() => {
    pausePendingSyncAutoRetry();
    setRetryAt(null);
    setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
  }, [setRetryAt, setSyncStatus]);

  function sharedAreaEditsAreBlocked() {
    return Boolean(projectRef.current?.sharedProjectId && areaClaimProblemRef.current);
  }

  function canEditSharedArea() {
    return !sharedAreaEditsAreBlocked();
  }

  function retrySharedAreaClaim() {
    setAreaClaimProblem(null);
    setAreaClaimError(null);
    setClaimingArea(true);
    setAreaClaimRetryNonce((value) => value + 1);
  }

  function returnToProjectFromSharedLock() {
    const currentProjectId = projectRef.current?.id ?? id;
    router.push(`/project/${currentProjectId}`);
  }

  useEffect(() => {
    if (project) {
      cacheProjectPreview(project);
    }
  }, [project]);

  useEffect(() => {
    const expandedComment = expandedCheckpoint && area
      ? area.locations
          .find((location) => location.id === expandedCheckpoint.locationId)
          ?.items.find((item) => item.id === expandedCheckpoint.itemId)
          ?.checkpoints.find((checkpoint) => checkpoint.id === expandedCheckpoint.checkpointId)
      : null;
    const hasUnsavedCheckpointComment = expandedComment
      ? (expandedComment.comments ?? '') !== commentText
      : false;
    const hasUnsavedGeneralNotes = (area?.notes ?? '') !== notesDraftRef.current;
    const hasComposerDraft =
      customItemName.trim().length > 0 ||
      customSubareaName.trim().length > 0 ||
      customCheckpointName.trim().length > 0;
    const blocked =
      hasUnsavedGeneralNotes ||
      hasUnsavedCheckpointComment ||
      hasComposerDraft ||
      showEditArea ||
      deleteMode ||
      showCustomItemComposer ||
      showCustomSubareaComposer ||
      showCustomCheckpointComposer ||
      Boolean(editingCustomItem) ||
      Boolean(editingCustomCheckpoint) ||
      Boolean(promptDialog) ||
      Boolean(confirmDialog);

    liveSharedRefreshBlockedRef.current = blocked;
    if (!blocked && pendingLiveSharedRefreshRef.current) {
      pendingLiveSharedRefreshRef.current = false;
      retryLiveSharedRefreshRef.current();
    }
  }, [
    area,
    commentText,
    confirmDialog,
    customCheckpointName,
    customItemName,
    customSubareaName,
    deleteMode,
    editingCustomCheckpoint,
    editingCustomItem,
    expandedCheckpoint,
    generalNotes,
    promptDialog,
    showCustomCheckpointComposer,
    showCustomItemComposer,
    showCustomSubareaComposer,
    showEditArea,
  ]);

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
    await saveProjectMetadataOnly(currentProject);
    scheduleSyncRef.current(currentProject.id);
    setProject({ ...currentProject, areas: [...currentProject.areas] });
    setArea({ ...targetArea });
  }, []);

  useEffect(() => {
    if (!id || !areaId) {
      router.push('/');
      return;
    }
    const savedRecentComments = localStorage.getItem(RECENT_COMMENTS_STORAGE_KEY);
    if (savedRecentComments) {
      try {
        const nextRecentComments = (JSON.parse(savedRecentComments) as string[]).slice(0, MAX_RECENT_COMMENTS);
        setRecentComments(nextRecentComments);
        localStorage.setItem(RECENT_COMMENTS_STORAGE_KEY, JSON.stringify(nextRecentComments));
      } catch (error) {
        console.error('Failed to parse recent comments:', error);
      }
    }
    const savedRecentAreaTypes = localStorage.getItem(RECENT_AREA_TYPES_STORAGE_KEY);
    if (savedRecentAreaTypes) {
      try {
        setRecentAreaTypeKeys(JSON.parse(savedRecentAreaTypes) as AreaTypeKey[]);
      } catch (error) {
        console.error('Failed to parse recent area types:', error);
      }
    }
    void loadDataRef.current();
  }, [id, areaId, router]);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
      }
      if (notesTimerRef.current) {
        clearTimeout(notesTimerRef.current);
        void persistGeneralNotes(notesDraftRef.current);
      }
    };
  }, [persistGeneralNotes]);

  useEffect(() => {
    if (!collaborationAuth.isSignedIn) {
      resetBackgroundSharedProjectPublish();
    }
  }, [collaborationAuth.isSignedIn]);

  useEffect(() => {
    if (!isReady || loading) return;
    if (!isSignedIn) {
      resetLaunchOneDriveSyncReservations();
      resetBackgroundMediaHydration();
      return;
    }

    const accountKey = accountEmail ?? accountName ?? 'signed-in';
    if (!hasPendingSyncState()) {
      setRetryAt(null);
      setSyncStatus('idle');
    }
    if (isPendingSyncAutoRetryPaused()) {
      setRetryAt(null);
      setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
      return;
    }
    if (!reserveLaunchOneDriveSync(accountKey)) return;
    scheduleOneDriveSyncRef.current(0, { silentStatus: true });
  }, [accountEmail, accountName, isReady, isSignedIn, loading, setRetryAt, setSyncStatus]);

  useEffect(() => {
    if (!isReady || loading || !isSignedIn || !project) return;
    let active = true;
    const accountKey = accountEmail ?? accountName ?? 'signed-in';
    queueBackgroundProjectMediaHydration({
      accountKey,
      projects: [project],
      getAccessToken: () => ensureAccessTokenRef.current({ interactive: false }),
      onProjectHydrated: (hydratedProject) => {
        if (!active || hydratedProject.id !== projectRef.current?.id) return;
        const hydratedArea = hydratedProject.areas.find((entry) => entry.id === areaRef.current?.id);
        if (!hydratedArea || hydratedArea.deletedAt) return;
        cacheProjectPreview(hydratedProject);
        setProject(hydratedProject);
        setArea(hydratedArea);
      },
    });
    return () => {
      active = false;
    };
  }, [accountEmail, accountName, isReady, isSignedIn, loading, project]);

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
    if (!collaborationAuth.isSignedIn || !project?.sharedProjectId || !area?.id) {
      retryLiveSharedRefreshRef.current = () => {};
      pendingLiveSharedRefreshRef.current = false;
      return;
    }

    const localProjectId = project.id;
    const activeAreaId = area.id;
    const activeSharedProjectId = project.sharedProjectId;
    let cancelled = false;
    let refreshing = false;

    async function pullSafeSharedSnapshot() {
      if (refreshing) return;
      refreshing = true;
      try {
        const localProject = await getProject(localProjectId);
        if (cancelled || !localProject?.sharedProjectId) return;

        const snapshot = await getSharedProjectSnapshot(localProject);
        if (cancelled) return;
        if (!isSharedSnapshotNewer(localProject, snapshot.publishedAt)) {
          pendingLiveSharedRefreshRef.current = false;
          setLiveSharedUpdate(null);
          return;
        }

        if (hasNewerLocalChangesThanSharedSnapshot(localProject, snapshot.publishedAt)) {
          pendingLiveSharedRefreshRef.current = false;
          setLiveSharedUpdate({ kind: 'local-newer', message: LIVE_SHARED_LOCAL_NEWER_MESSAGE });
          return;
        }

        if (liveSharedRefreshBlockedRef.current) {
          pendingLiveSharedRefreshRef.current = true;
          setLiveSharedUpdate({ kind: 'waiting-for-draft', message: LIVE_SHARED_WAITING_MESSAGE });
          return;
        }

        const snapshotArea = snapshot.project.areas.find((entry) => entry.id === activeAreaId);
        await saveProjectPreserveTimestamps(snapshot.project);
        if (cancelled) return;
        cacheProjectPreview(snapshot.project);
        if (!snapshotArea || snapshotArea.deletedAt) {
          router.push(`/project/${localProject.id}`);
          return;
        }
        pendingLiveSharedRefreshRef.current = false;
        setLiveSharedUpdate(null);
        setProject(snapshot.project);
        setArea(snapshotArea);
      } catch (error) {
        if (!cancelled) {
          console.info('Live shared area refresh skipped:', error);
        }
      } finally {
        refreshing = false;
      }
    }

    retryLiveSharedRefreshRef.current = () => {
      void pullSafeSharedSnapshot();
    };

    const unsubscribeSnapshotChanges = subscribeToSharedProjectSnapshotChanges(
      activeSharedProjectId,
      () => {
        void pullSafeSharedSnapshot();
      }
    );

    return () => {
      cancelled = true;
      retryLiveSharedRefreshRef.current = () => {};
      unsubscribeSnapshotChanges();
    };
  }, [area?.id, collaborationAuth.isSignedIn, project?.id, project?.sharedProjectId, router]);

  useEffect(() => {
    const sharedProjectId = project?.sharedProjectId;
    const currentAreaId = area?.id;
    if (!sharedProjectId || !currentAreaId) {
      setAreaClaimError(null);
      setAreaClaimProblem(null);
      setAreaClaimExpiresAt(null);
      setClaimingArea(false);
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      setAreaClaimError('Enable shared projects before working in this shared area.');
      setAreaClaimProblem({ kind: 'lost', message: 'Enable shared projects before editing this shared area.' });
      setAreaClaimExpiresAt(null);
      setClaimingArea(false);
      return;
    }

    let cancelled = false;
    let claimRenewTimer: ReturnType<typeof setInterval> | null = null;
    const config = getCollaborationRuntimeConfig();
    const optimisticExpiresAt = getAreaClaimExpiry(config?.areaClaimTimeoutMs ?? 4 * 60 * 60 * 1000);
    setClaimingArea(true);
    setAreaClaimError(null);
    setAreaClaimProblem(null);
    setAreaClaimExpiresAt(optimisticExpiresAt);

    const releaseClaim = () => {
      void releaseSharedProjectArea(sharedProjectId, currentAreaId).catch((error) => {
        console.error('Failed to release shared area claim:', error);
      });
    };

    void claimSharedProjectArea(sharedProjectId, currentAreaId)
      .then((claim) => {
        if (!cancelled) {
          setAreaClaimError(null);
          setAreaClaimProblem(null);
          setAreaClaimExpiresAt(claim.expiresAt ?? null);
          claimRenewTimer = setInterval(() => {
            void claimSharedProjectArea(sharedProjectId, currentAreaId)
              .then((renewedClaim) => {
                if (cancelled) return;
                setAreaClaimError(null);
                setAreaClaimProblem(null);
                setAreaClaimExpiresAt(renewedClaim.expiresAt ?? null);
              })
              .catch((error) => {
                if (cancelled) return;
                const message = getCollaborationErrorMessage(error, 'Could not renew this shared area claim.');
                setAreaClaimError(message);
                setAreaClaimExpiresAt(null);
                setAreaClaimProblem({
                  kind: isSharedAreaClaimBlockedMessage(message) ? 'blocked' : 'lost',
                  message: isSharedAreaClaimBlockedMessage(message)
                    ? SHARED_AREA_LOCK_BLOCKED_MESSAGE
                    : SHARED_AREA_LOCK_LOST_MESSAGE,
                });
              });
          }, 2 * 60 * 1000);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = getCollaborationErrorMessage(error, 'Could not claim this shared area.');
        setAreaClaimError(message);
        setAreaClaimExpiresAt(null);
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

    window.addEventListener('pagehide', releaseClaim);

    return () => {
      cancelled = true;
      if (claimRenewTimer) {
        clearInterval(claimRenewTimer);
      }
      setAreaClaimExpiresAt(null);
      window.removeEventListener('pagehide', releaseClaim);
      releaseClaim();
    };
  }, [area?.id, areaClaimRetryNonce, collaborationAuth.isSignedIn, id, project?.sharedProjectId, router]);

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
        getProject(id),
      ]);
      setReturnToHome(activeProjectCount === 1);
      if (projectData) {
        if (projectData.deletedAt) {
          router.push('/');
          return;
        }
        let nextProject = projectData;
        if (collaborationAuth.isSignedIn && projectData.sharedProjectId) {
          try {
            const snapshot = await getSharedProjectSnapshot(projectData);
            if (isSharedSnapshotNewer(projectData, snapshot.publishedAt)) {
              await saveProjectPreserveTimestamps(snapshot.project);
              nextProject = snapshot.project;
            }
          } catch (error) {
            console.info('Shared snapshot pull skipped:', error);
          }
        }
        if (collaborationAuth.user?.id) {
          queueStaleBackgroundSharedProjectPublishes({
            projects: [nextProject],
            userId: collaborationAuth.user.id,
          });
        }
        setProject(nextProject);
        const areaData = nextProject.areas.find((a) => a.id === areaId);
        if (areaData && !areaData.deletedAt) {
          const normalizedLocations = areaData.locations.filter(
            (location) => location.name.trim().toLowerCase() !== OTHER_LOCATION_NAME.toLowerCase()
          );
          if (normalizedLocations.length !== areaData.locations.length) {
            areaData.locations = normalizedLocations.map((location, index) => ({
              ...location,
              sortOrder: index,
            }));
            await saveProject(nextProject);
            scheduleSync(nextProject.id);
          }
          if (facadeAreaNeedsTemplateRefresh(areaData)) {
            applyTemplateToArea(areaData, { preserveExisting: true });
            await saveProject(nextProject);
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

    const locationMetrics = new Map<string, LocationMetrics>();
    const itemMetrics = new Map<string, ItemMetrics>();

    let total = 0;
    let ok = 0;
    let issues = 0;

    for (const location of visibleLocations) {
      let locationTotal = 0;
      let locationOk = 0;
      let locationIssues = 0;
      let locationPhotoCount = 0;
      let locationCommentCount = 0;

      for (const item of location.items) {
        let itemTotal = 0;
        let itemOk = 0;
        let itemIssues = 0;
        let itemPhotoCount = 0;
        let itemCommentCount = 0;

        for (const checkpoint of item.checkpoints) {
          itemTotal += 1;
          if (checkpoint.status === 'ok') itemOk += 1;
          else if (checkpointHasIssue(checkpoint)) itemIssues += 1;
          itemPhotoCount += checkpoint.photos.length;
          if (checkpoint.comments.trim()) itemCommentCount += 1;
        }

        const itemPending = itemTotal - itemOk - itemIssues;
        itemMetrics.set(item.id, {
          stats: { total: itemTotal, ok: itemOk, issues: itemIssues },
          pending: itemPending,
          photoCount: itemPhotoCount,
          commentCount: itemCommentCount,
        });

        locationTotal += itemTotal;
        locationOk += itemOk;
        locationIssues += itemIssues;
        locationPhotoCount += itemPhotoCount;
        locationCommentCount += itemCommentCount;
      }

      const locationPending = locationTotal - locationOk - locationIssues;
      const locationReviewMetrics = getReviewMetrics(locationTotal, locationOk, locationIssues);
      locationMetrics.set(location.id, {
        stats: { total: locationTotal, ok: locationOk, issues: locationIssues },
        pending: locationPending,
        progress: locationReviewMetrics.reviewedPercent,
        photoCount: locationPhotoCount,
        commentCount: locationCommentCount,
      });

      total += locationTotal;
      ok += locationOk;
      issues += locationIssues;
    }

    const reviewMetrics = getReviewMetrics(total, ok, issues);
    return {
      stats: { total, ok, issues },
      pending: reviewMetrics.pending,
      reviewedPercent: reviewMetrics.reviewedPercent,
      okPercent: reviewMetrics.okPercent,
      issuePercent: reviewMetrics.issuePercent,
      locationMetrics,
      itemMetrics,
    };
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
    await saveProjectMetadataOnly(project);
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
    await saveProjectMetadataOnly(project);
    scheduleSync(project.id);

    const trimmedComment = value.trim();
    if (trimmedComment) {
      const nextRecentComments = [
        trimmedComment,
        ...recentComments.filter((comment) => comment !== trimmedComment),
      ].slice(0, MAX_RECENT_COMMENTS);
      setRecentComments(nextRecentComments);
      localStorage.setItem(RECENT_COMMENTS_STORAGE_KEY, JSON.stringify(nextRecentComments));
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
      await saveProject(project);
    } else {
      await saveProjectMetadataOnly(project);
    }
    scheduleSync(project.id);

    const nextRecentAreaTypeKeys = [
      areaForm.areaTypeKey,
      ...recentAreaTypeKeys.filter((key) => key !== areaForm.areaTypeKey),
    ].slice(0, 8);
    setRecentAreaTypeKeys(nextRecentAreaTypeKeys);
    localStorage.setItem(RECENT_AREA_TYPES_STORAGE_KEY, JSON.stringify(nextRecentAreaTypeKeys));

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

      targetItem.name = trimmedName;
      syncAreaCompletion(targetArea);
      await saveProjectMetadataOnly(project);
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

    const item = createItem(targetLocation.id, trimmedName, targetLocation.items.length, { isCustom: true });
    targetLocation.items.push(item);
    targetLocation.items.forEach((entry, index) => {
      entry.sortOrder = index;
    });
    syncAreaCompletion(targetArea);

    await saveProjectMetadataOnly(project);
    scheduleSync(project.id);

    setCustomItemName('');
    setEditingCustomItem(null);
    setCustomItemTargetLocationId(null);
    setShowCustomItemComposer(false);
    setExpandedLocations(new Set([targetLocation.id]));
    setExpandedItems(new Set([item.id]));
    setExpandedCheckpoint(null);
    setCommentText('');
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleSubmitCustomSubarea() {
    if (!canEditSharedArea()) return;
    if (!project || !area || !customSubareaName.trim()) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    if (!targetArea) return;

    const location = createLocation(targetArea.id, customSubareaName.trim(), targetArea.locations.length, {
      isCustom: true,
    });
    targetArea.locations.push(location);
    targetArea.locations.forEach((entry, index) => {
      entry.sortOrder = index;
    });

    syncAreaCompletion(targetArea);
    await saveProjectMetadataOnly(project);
    scheduleSync(project.id);

    setCustomSubareaName('');
    setShowCustomSubareaComposer(false);
    setExpandedLocations(new Set([location.id]));
    setExpandedItems(new Set());
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleEditCustomItem(locationId: string, itemId: string, currentName: string) {
    if (!canEditSharedArea()) return;
    void project;
    void area;
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

      checkpoint.name = customCheckpointName.trim();
      checkpoint.updatedAt = new Date();

      syncAreaCompletion(targetArea);
      await saveProjectMetadataOnly(project);
      scheduleSync(project.id);

      setCustomCheckpointName('');
      setShowCustomCheckpointComposer(false);
      setCustomCheckpointTarget(null);
      setEditingCustomCheckpoint(null);
      setProject({ ...project, areas: [...project.areas] });
      setArea({ ...targetArea });
      return;
    }

    const checkpoint = createCheckpoint(
      targetItem.id,
      customCheckpointName.trim(),
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
    await saveProjectMetadataOnly(project);
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
      setCommentText('');
    }
    if (editingCustomCheckpoint?.checkpointId === checkpointId) {
      setCustomCheckpointName('');
      setShowCustomCheckpointComposer(false);
      setCustomCheckpointTarget(null);
      setEditingCustomCheckpoint(null);
    }

    syncAreaCompletion(targetArea);
    if (removedStoredMedia) {
      await saveProject(project);
    } else {
      await saveProjectMetadataOnly(project);
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
      setCommentText('');
    }
    setExpandedItems((prev) => {
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });

    syncAreaCompletion(targetArea);
    if (removedStoredMedia) {
      await saveProject(project);
    } else {
      await saveProjectMetadataOnly(project);
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
    await saveProjectMetadataOnly(project);
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
      await saveProject(project);
    } else {
      await saveProjectMetadataOnly(project);
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
    await saveProject(project);
    scheduleSync(project.id);

    setExpandedLocations(new Set());
    setExpandedItems(new Set());
    setExpandedCheckpoint(null);
    setCommentText('');
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
    await saveProject(project);
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
    await saveProject(project);
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
    await saveProject(project);
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
    await saveProject(project);
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
    await saveProject(project);
    scheduleSync(project.id);
    setArea({ ...area });
  }

  function scheduleOneDriveSync(delayMs = AUTO_SYNC_DELAY_MS, options?: { silentStatus?: boolean }) {
    if (!isSignedIn) return;
    if (isPendingSyncAutoRetryPaused()) {
      pauseAutoSyncRetry();
      return;
    }
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
    }

    const waitMs = Math.max(delayMs, getPendingSyncWaitMs());
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      void handleSync({ interactive: false, quiet: true, silentStatus: options?.silentStatus });
    }, waitMs);
  }

  async function handleSync(options: { interactive?: boolean; quiet?: boolean; silentStatus?: boolean } = {}) {
    if (syncing) return;
    if (!options.quiet) {
      resumePendingSyncAutoRetry();
      setRetryAt(null);
    }
    setSyncing(true);
    if (!options.quiet) {
      setSyncError(null);
    }
    if (!options.silentStatus) {
      setSyncStatus('syncing');
    }
    try {
      const token = await ensureAccessToken({ interactive: options.interactive ?? true });
      if (!token) {
        if (options.quiet) {
          setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
        } else {
          setSyncError('Please sign in to sync.');
          setSyncStatus('needs-auth');
        }
        return;
      }
      const pendingSyncState = loadPendingSyncState();
      const result = await syncProjectsWithOneDriveRecovery(token, {
        pushProjectIds: pendingSyncState.projectIds,
      });
      if (result.conflicts.length > 0) {
        if (!options.quiet) {
          setSyncError(formatSyncConflictReviewMessage(result.conflicts));
        }
        pauseAutoSyncRetry();
        return;
      }
      clearPendingSyncState();
      setSyncError(null);
      setRetryAt(null);
      setSyncStatus('idle');
      markSyncedNow();
      await loadData();
    } catch (error) {
      console.error('Sync failed:', error);
      const hasQueuedSync = hasPendingSyncState();
      const retryDelayMs = getMicrosoftRetryDelayMs(error);
      if (retryDelayMs) {
        if (options.quiet && !hasQueuedSync) {
          setRetryAt(null);
          setSyncStatus('idle');
          return;
        }
        if (options.quiet && shouldPausePendingSyncAutoRetry()) {
          pauseAutoSyncRetry();
          return;
        }
        const retry = recordPendingSyncRetry(retryDelayMs);
        setRetryAt(retry.retryAt);
        if (!options.quiet) {
          setSyncError(formatMicrosoftManualRetryMessage(Math.ceil(retry.delayMs / 1000)));
        }
        setSyncStatus(options.quiet && !hasQueuedSync ? 'idle' : 'pending');
        scheduleOneDriveSync(retry.delayMs);
        return;
      }
      const message = getMicrosoftErrorMessage(error, 'Sync failed.');
      if (message.startsWith('Saved locally.')) {
        if (options.quiet && !hasQueuedSync) {
          setRetryAt(null);
          setSyncStatus('idle');
          return;
        }
        if (options.quiet && shouldPausePendingSyncAutoRetry()) {
          pauseAutoSyncRetry();
          return;
        }
        const retry = recordPendingSyncRetry(60_000);
        setRetryAt(retry.retryAt);
        if (!options.quiet) {
          setSyncError(formatMicrosoftManualRetryMessage(Math.ceil(retry.delayMs / 1000)));
        }
        setSyncStatus(options.quiet && !hasQueuedSync ? 'idle' : 'pending');
        scheduleOneDriveSync(retry.delayMs);
        return;
      }
      if (options.quiet) {
        setSyncStatus(hasQueuedSync ? 'pending' : 'idle');
        return;
      }
      setSyncError(message);
      setSyncStatus('error');
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
      scheduleSharedPublish(project.id);
      await releaseSharedProjectArea(project.sharedProjectId, area.id);
      setAreaClaimExpiresAt(null);
      setAreaClaimError(null);
      router.push(`/project/${project.id}`);
    } catch (error) {
      console.error('Failed to release shared area claim:', error);
      setSyncError(getCollaborationErrorMessage(error, 'Failed to release this shared area lock.'));
    } finally {
      setReleasingAreaClaim(false);
    }
  }

  function handleGeneralNotesChange(value: string) {
    if (!canEditSharedArea()) return;
    setGeneralNotes(value);
    notesDraftRef.current = value;
    if (notesTimerRef.current) {
      clearTimeout(notesTimerRef.current);
    }
    notesTimerRef.current = setTimeout(() => {
      void persistGeneralNotes(value);
    }, 400);
  }

  function isListAtTop() {
    return (listRef.current?.scrollTop ?? 0) <= 8;
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

  function handlePullStart(e: TouchEvent<HTMLElement>) {
    if (e.touches.length !== 1) {
      pullStartYRef.current = null;
      pullDistanceRef.current = 0;
      return;
    }
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
    if (e.touches.length !== 1) return;
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

  function scheduleSync(projectId?: string, options?: ScheduleSyncOptions) {
    queuePendingSync(projectId, options);
    setSyncStatus('pending');
    if (projectId) {
      scheduleSharedPublish(projectId);
    }
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
    }
    scheduleOneDriveSync();
  }

  function scheduleSharedPublish(projectId: string) {
    const userId = collaborationAuth.user?.id;
    if (!userId) return;
    queueBackgroundSharedProjectPublish({ projectId, userId });
  }

  async function closeExpandedCheckpoint() {
    if (!canEditSharedArea()) return;
    if (!expandedCheckpoint) return;
    await persistCheckpointComment(
      expandedCheckpoint.locationId,
      expandedCheckpoint.itemId,
      expandedCheckpoint.checkpointId,
      commentText
    );
    setExpandedCheckpoint(null);
    setCommentText('');
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
    await saveProjectMetadataOnly(project);
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });

    setExpandedLocations(new Set([locationId]));
    setExpandedItems(new Set([targetItem.id]));
    setExpandedCheckpoint({ locationId, itemId: targetItem.id, checkpointId: checkpoint.id });
    setCommentText(checkpoint.comments);

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
    setCommentText(comments);
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
  const canReleaseAreaClaim = Boolean(project.sharedProjectId && areaClaimExpiresAt && !areaClaimError && !areaClaimProblem);
  const visibleLiveSharedUpdate = collaborationAuth.isSignedIn && project.sharedProjectId ? liveSharedUpdate : null;
  const sharedAreaClaimLabel = visibleAreaClaimProblem
    ? visibleAreaClaimProblem.kind === 'blocked'
      ? 'Area in use by someone else'
      : 'Shared lock needs attention'
    : areaClaimError
    ? 'Shared claim needs attention'
    : releasingAreaClaim
      ? 'Releasing shared lock...'
      : areaClaimExpiresAt
        ? `Locked to you until ${areaClaimExpiresAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : claimingArea
        ? 'Claiming shared area...'
        : 'Shared area claimed';

  return (
    <div className="app-page h-[calc(100dvh-env(safe-area-inset-top)-3.5rem)] flex flex-col overflow-hidden">
      <header className="header-stable shrink-0 border-b z-20">
        <div className="page-header-surface mx-auto flex min-h-[4.9rem] w-full max-w-6xl items-center px-4 py-3 sm:px-5">
          <div className="flex w-full items-center gap-3">
            <Link
              href={returnToHome ? '/' : `/project/${project.id}`}
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

      {visibleLiveSharedUpdate && (
        <div
          className="shrink-0 border-b border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-950 dark:border-sky-300/20 dark:bg-sky-400/10 dark:text-sky-100"
          aria-live="polite"
        >
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 flex-1 font-medium">{visibleLiveSharedUpdate.message}</p>
            {visibleLiveSharedUpdate.kind === 'local-newer' && (
              <button
                type="button"
                onClick={() => router.push(`/project/${project.id}`)}
                className="inline-flex h-9 w-fit items-center justify-center rounded-full bg-sky-700 px-3 text-xs font-semibold text-white transition hover:bg-sky-800 dark:bg-sky-200 dark:text-sky-950 dark:hover:bg-sky-100"
              >
                Review
              </button>
            )}
          </div>
        </div>
      )}
      {/* Inspection Items */}
      <main
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-scroll overscroll-y-contain touch-pan-y px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+3.5rem)] sm:px-5"
        onTouchStartCapture={handlePullStart}
        onTouchMoveCapture={handlePullMove}
        onTouchEndCapture={handlePullEnd}
        onTouchCancelCapture={handlePullEnd}
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
                onCommentChange={setCommentText}
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
                  supportsInlineLocationCustomItems && area.areaTypeKey !== 'facade'
                    ? (locationId, itemId) => (
                        <CustomItemComposer
                          open={
                            showCustomCheckpointComposer &&
                            customCheckpointTarget?.locationId === locationId &&
                            customCheckpointTarget?.itemId === itemId
                          }
                          value={customCheckpointName}
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
                  supportsInlineLocationCustomItems && area.areaTypeKey !== 'facade' && !editingCustomItem ? (
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
              onCommentChange={setCommentText}
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
