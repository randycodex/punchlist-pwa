'use client';

import { useState, useEffect, useMemo, useRef, useCallback, type TouchEvent } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Project,
  Area,
  Checkpoint,
  getReviewMetrics,
  checkpointHasIssue,
  isAreaInspectionComplete,
  type IssueState,
} from '@/types';
import { getActiveProjectCount, getProject, saveProject, createPhotoAttachment, createFileAttachment, createLocation, createItem, createCheckpoint } from '@/lib/db';
import { getMicrosoftErrorMessage, getMicrosoftRetryDelayMs } from '@/lib/microsoftErrors';
import AreaEditorModal from '@/components/AreaEditorModal';
import {
  areaHasRecordedActivity,
  buildAreaName,
  getAreaFormValue,
  isApartmentArea,
  type AreaTypeKey,
} from '@/lib/areas';
import { applyTemplateToArea } from '@/lib/template';
import { pushProjectsToOneDrive, syncProjectsWithOneDrive } from '@/lib/oneDriveSync';
import {
  clearPendingProjectSync,
  clearPendingSyncState,
  hasPendingSyncState,
  loadPendingSyncState,
  queuePendingSync,
} from '@/lib/pendingSync';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import AreaNotesCard from '@/components/inspection/AreaNotesCard';
import CustomItemComposer from '@/components/inspection/CustomItemComposer';
import InspectionLocationCard from '@/components/inspection/InspectionLocationCard';
import Link from 'next/link';
import {
  ArrowLeft,
  MoreVertical,
  RefreshCw,
  Trash2,
} from 'lucide-react';

const RECENT_COMMENTS_STORAGE_KEY = 'punchlist-recent-comments';
const RECENT_AREA_TYPES_STORAGE_KEY = 'punchlist-recent-area-types';
const CUSTOM_ITEMS_LOCATION_NAME = 'Custom Items';
const OTHER_LOCATION_NAME = 'Other';
const MAX_RECENT_COMMENTS = 5;

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

type LocationMetrics = {
  stats: StatusMetrics;
  pending: number;
  progress: number;
  photoCount: number;
  commentCount: number;
};

type CheckpointReviewState = 'pending' | 'ok' | 'open' | 'resolved' | 'verified';

export default function AreaDetailPage() {
  const params = useParams<{ id: string; areaId: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const areaId = Array.isArray(params.areaId) ? params.areaId[0] : params.areaId;
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [area, setArea] = useState<Area | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedLocations, setExpandedLocations] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
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
  const [generalNotes, setGeneralNotes] = useState('');
  const [returnToHome, setReturnToHome] = useState(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backgroundSyncInFlightRef = useRef(false);
  const backgroundSyncQueuedRef = useRef(false);
  const dirtyProjectIdsRef = useRef<Set<string>>(new Set());
  const fullSyncNeededRef = useRef(false);
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesDraftRef = useRef('');
  const pullStartYRef = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  const pullArmedRef = useRef(false);
  const listRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement | null>());
  const locationRefs = useRef(new Map<string, HTMLDivElement | null>());
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const { accessToken, ensureAccessToken } = useMicrosoftAuth();
  const { setStatus: setSyncStatus } = useSyncStatus();
  const { inspectionShowOnlyIssues, setInspectionShowOnlyIssues, quickSort, markSyncedNow } = useAppSettings();

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
    loadData();
  }, [id, areaId]);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
      }
      backgroundSyncInFlightRef.current = false;
      backgroundSyncQueuedRef.current = false;
      fullSyncNeededRef.current = false;
      if (notesTimerRef.current) {
        clearTimeout(notesTimerRef.current);
        void persistGeneralNotes(notesDraftRef.current);
      }
    };
  }, []);

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
    if (!accessToken || !hasPendingSyncState()) return;
    scheduleSync();
  }, [accessToken]);

  useEffect(() => {
    const value = area?.notes ?? '';
    setGeneralNotes(value);
    notesDraftRef.current = value;
  }, [area?.id, area?.notes]);

  useEffect(() => {
    setAreaForm(getAreaFormValue(area));
  }, [area]);

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
      visibleLocations.filter(
        (location) => location.name.trim().toLowerCase() !== CUSTOM_ITEMS_LOCATION_NAME.toLowerCase()
      ),
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
        setProject(projectData);
        const areaData = projectData.areas.find((a) => a.id === areaId);
        if (areaData && !areaData.deletedAt) {
          const normalizedLocations = areaData.locations.filter(
            (location) => location.name.trim().toLowerCase() !== OTHER_LOCATION_NAME.toLowerCase()
          );
          if (normalizedLocations.length !== areaData.locations.length) {
            areaData.locations = normalizedLocations.map((location, index) => ({
              ...location,
              sortOrder: index,
            }));
            await saveProject(projectData);
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

  const filteredCustomItemsLocation = useMemo(() => {
    if (!customItemsLocation) return null;
    if (!inspectionShowOnlyIssues) return customItemsLocation;
    return (areaDerived?.locationMetrics.get(customItemsLocation.id)?.stats.issues ?? 0) > 0
      ? customItemsLocation
      : null;
  }, [customItemsLocation, inspectionShowOnlyIssues, areaDerived]);

  const filteredStandardLocations = useMemo(
    () =>
      inspectionShowOnlyIssues
        ? standardLocations.filter(
            (location) => (areaDerived?.locationMetrics.get(location.id)?.stats.issues ?? 0) > 0
          )
        : standardLocations,
    [inspectionShowOnlyIssues, standardLocations, areaDerived]
  );

  const sortedStandardLocations = useMemo(() => {
    const hasSectionLabels = filteredStandardLocations.some((l) => l.sectionLabel);
    if (hasSectionLabels) return [...filteredStandardLocations].sort((a, b) => a.sortOrder - b.sortOrder);

    return [...filteredStandardLocations].sort((a, b) => {
      if (quickSort === 'alphabetical') {
        return a.name.localeCompare(b.name);
      }

      if (quickSort === 'issues') {
        const issuesA = areaDerived?.locationMetrics.get(a.id)?.stats.issues ?? 0;
        const issuesB = areaDerived?.locationMetrics.get(b.id)?.stats.issues ?? 0;
        if (issuesB !== issuesA) return issuesB - issuesA;
        return a.name.localeCompare(b.name);
      }

      const progressA = areaDerived?.locationMetrics.get(a.id)?.progress ?? 0;
      const progressB = areaDerived?.locationMetrics.get(b.id)?.progress ?? 0;
      if (progressB !== progressA) return progressB - progressA;
      return a.name.localeCompare(b.name);
    });
  }, [areaDerived, filteredStandardLocations, quickSort]);

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
    await saveProject(project);
    scheduleSync(project.id);
    setArea({ ...area });
  }

  async function persistCheckpointComment(
    locationId: string,
    itemId: string,
    checkpointId: string,
    value: string
  ) {
    if (!project || !area) return;

    const checkpoint = findCheckpoint(locationId, itemId, checkpointId);
    if (!checkpoint) return;
    if (checkpoint.comments === value) return;

    checkpoint.comments = value;
    checkpoint.updatedAt = new Date();
    syncAreaCompletion(area);
    await saveProject(project);
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

  async function saveAreaChanges() {
    if (!project || !area) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    if (!targetArea) return;

    const originalTypeKey = targetArea.areaTypeKey;
    const originalUnitType = targetArea.unitType;
    const originalAreaNumber = targetArea.areaNumber;
    const originalFacadeLevel = targetArea.facadeLevel;
    const nextName = buildAreaName(areaForm);
    targetArea.name = nextName;
    targetArea.areaTypeKey = areaForm.areaTypeKey;
    targetArea.unitType = areaForm.unitType || undefined;
    targetArea.customAreaName = areaForm.customAreaName.trim() || undefined;
    targetArea.areaNumber = areaForm.areaNumber.trim() || undefined;
    targetArea.facadeLevel = areaForm.facadeLevel.trim() || undefined;

    const templateChanged =
      originalTypeKey !== areaForm.areaTypeKey ||
      originalUnitType !== (areaForm.unitType || undefined) ||
      originalAreaNumber !== (areaForm.areaNumber.trim() || undefined);
    if (templateChanged) {
      if (
        areaHasRecordedActivity(targetArea) &&
        !window.confirm(
          'Changing this area will reset checklist issues, comments, and images for this unit. Continue?'
        )
      ) {
        targetArea.name = area.name;
        targetArea.areaTypeKey = originalTypeKey;
        targetArea.unitType = originalUnitType;
        targetArea.customAreaName = area.customAreaName;
        targetArea.areaNumber = area.areaNumber;
        targetArea.facadeLevel = originalFacadeLevel;
        return;
      }
      applyTemplateToArea(targetArea);
    }

    syncAreaCompletion(targetArea);
    await saveProject(project);
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
      await saveProject(project);
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

    await saveProject(project);
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
    await saveProject(project);
    scheduleSync(project.id);

    setCustomSubareaName('');
    setShowCustomSubareaComposer(false);
    setExpandedLocations(new Set([location.id]));
    setExpandedItems(new Set());
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleEditCustomItem(locationId: string, itemId: string, currentName: string) {
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
      await saveProject(project);
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
    await saveProject(project);
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
    if (!project || !area) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    const targetLocation = targetArea?.locations.find((location) => location.id === locationId);
    const targetItem = targetLocation?.items.find((item) => item.id === itemId);
    if (!targetArea || !targetLocation || !targetItem) return;

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
    await saveProject(project);
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleDeleteCustomItem(locationId: string, itemId: string) {
    if (!project || !area) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    const targetLocation = targetArea?.locations.find((location) => location.id === locationId);
    if (!targetArea || !targetLocation) return;

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
    await saveProject(project);
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleEditCustomLocation(locationId: string, currentName: string) {
    if (!project || !area) return;

    const nextName = window.prompt('Edit item', currentName)?.trim();
    if (!nextName || nextName === currentName) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    const targetLocation = targetArea?.locations.find((location) => location.id === locationId);
    if (!targetArea || !targetLocation) return;

    targetLocation.name = nextName;
    targetLocation.updatedAt = new Date();

    syncAreaCompletion(targetArea);
    await saveProject(project);
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  async function handleDeleteCustomLocation(locationId: string) {
    if (!project || !area) return;

    const targetArea = project.areas.find((entry) => entry.id === area.id);
    if (!targetArea) return;

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
    await saveProject(project);
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
      await loadData();
    } catch (error) {
      console.error('Sync failed:', error);
      const retryDelayMs = getMicrosoftRetryDelayMs(error);
      if (retryDelayMs) {
        setSyncError(`Saved locally. Microsoft sync will retry in about ${Math.ceil(retryDelayMs / 1000)} seconds.`);
        scheduleSync(undefined, { fullSync: true, delayMs: retryDelayMs });
        setSyncStatus('pending');
        return;
      }
      const message = getMicrosoftErrorMessage(error, 'Sync failed.');
      if (message.startsWith('Saved locally.')) {
        setSyncError('Saved locally. Microsoft sync will retry in about 60 seconds.');
        scheduleSync(undefined, { fullSync: true, delayMs: 60_000 });
        setSyncStatus('pending');
        return;
      }
      setSyncError(message);
      setSyncStatus('error');
    } finally {
      setSyncing(false);
    }
  }

  async function persistGeneralNotes(value: string) {
    if (!project || !area) return;
    const targetArea = project.areas.find((entry) => entry.id === area.id);
    if (!targetArea) return;
    if ((targetArea.notes ?? '') === value) return;
    targetArea.notes = value;
    targetArea.updatedAt = new Date();
    await saveProject(project);
    scheduleSync(project.id);
    setProject({ ...project, areas: [...project.areas] });
    setArea({ ...targetArea });
  }

  function handleGeneralNotesChange(value: string) {
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

  async function runBackgroundSync() {
    const pendingSyncState = loadPendingSyncState();
    pendingSyncState.projectIds.forEach((projectId) => dirtyProjectIdsRef.current.add(projectId));
    if (pendingSyncState.fullSyncNeeded) {
      fullSyncNeededRef.current = true;
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
        await loadData();
        setSyncError(null);
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
        await loadData();
        setSyncError(null);
      } else {
        clearPendingProjectSync(dirtyProjectIds);
        setSyncError(null);
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
        setSyncError(`Saved locally. Microsoft sync will retry in about ${Math.ceil(retryDelayMs / 1000)} seconds.`);
        scheduleSync(undefined, { delayMs: retryDelayMs });
        backgroundSyncQueuedRef.current = false;
        return;
      }
      const message = getMicrosoftErrorMessage(error, 'Background sync failed.');
      if (message.startsWith('Saved locally.')) {
        setSyncError('Saved locally. Microsoft sync will retry in about 60 seconds.');
        scheduleSync(undefined, { fullSync: shouldRunFullSync, delayMs: 60_000 });
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

  function scheduleSync(projectId?: string, options?: { fullSync?: boolean; delayMs?: number }) {
    if (projectId) {
      dirtyProjectIdsRef.current.add(projectId);
    }
    if (options?.fullSync) {
      fullSyncNeededRef.current = true;
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

  async function closeExpandedCheckpoint() {
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
      setExpandedLocations(new Set());
      setExpandedItems(new Set());
    } else {
      await closeExpandedCheckpoint();
      setExpandedLocations(new Set([locationId]));
      setExpandedItems(new Set());
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          locationRefs.current.get(locationId)?.scrollIntoView({
            block: 'start',
            behavior: 'smooth',
          });
        });
      });
    }
  }

  async function toggleItem(itemId: string) {
    setShowCustomCheckpointComposer(false);
    setCustomCheckpointName('');
    setCustomCheckpointTarget(null);
    setEditingCustomCheckpoint(null);

    if (expandedItems.has(itemId)) {
      await closeExpandedCheckpoint();
      setExpandedItems(new Set());
    } else {
      await closeExpandedCheckpoint();
      setExpandedItems(new Set([itemId]));
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          itemRefs.current.get(itemId)?.scrollIntoView({
            block: 'start',
            behavior: 'smooth',
          });
        });
      });
    }
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

  const supportsInlineLocationCustomItems = true;
  const supportsCustomSubareas = isApartmentArea(area) && !deleteMode;
  const supportsGlobalCustomItems = !supportsInlineLocationCustomItems && !deleteMode;
  const flattenSingleStairsLocation =
    !deleteMode && !isApartmentArea(area) && sortedStandardLocations.length === 1;

  return (
    <div className="app-page h-[calc(100dvh-env(safe-area-inset-top)-3.5rem)] flex flex-col overflow-hidden">
      <header className="header-stable shrink-0 border-b z-20">
        <div className="mx-auto flex min-h-[4.9rem] w-full max-w-6xl items-center px-4 py-3 sm:px-5">
          <div className="flex w-full items-center gap-3">
            <Link
              href={returnToHome ? '/' : `/project/${project.id}`}
              className="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-600 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="min-w-0 flex flex-1 flex-col">
              <div className="section-eyebrow">Inspection</div>
              <h1 className="truncate text-[1.12rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
                {areaTitle}
              </h1>
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
                    <button
                      onClick={() => {
                        setShowHeaderMenu(false);
                        void handleSync();
                      }}
                      className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-[0.98rem] text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Sync now
                    </button>
                    <button
                      onClick={() => {
                        setShowHeaderMenu(false);
                        setAreaForm(getAreaFormValue(area));
                        setShowEditArea(true);
                      }}
                      className="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left text-[0.98rem] text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                    >
                      <MoreVertical className="h-4 w-4" />
                      Edit area
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
                disabled={selectedLocationIds.size === 0}
                className="accent-text accent-tint hover:accent-tint-strong flex h-10 w-10 items-center justify-center rounded-full transition disabled:opacity-40"
                aria-label="Delete selected sub-areas"
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
      {/* Inspection Items */}
      <main
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-scroll overscroll-y-contain touch-pan-y px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+3.5rem)] sm:px-5"
        onTouchStartCapture={handlePullStart}
        onTouchMoveCapture={handlePullMove}
        onTouchEndCapture={handlePullEnd}
        onTouchCancelCapture={handlePullEnd}
      >
        <div className="list-stack mx-auto min-h-[calc(100%+1px)] w-full max-w-6xl">
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
                  supportsInlineLocationCustomItems
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
                  supportsInlineLocationCustomItems && !editingCustomItem ? (
                    <CustomItemComposer
                      open={showCustomItemComposer && customItemTargetLocationId === location.id}
                      value={customItemName}
                      submitLabel={editingCustomItem ? 'Save' : 'Add'}
                      onOpen={() => {
                        setCustomItemTargetLocationId(location.id);
                        setEditingCustomItem(null);
                        setCustomItemName('');
                        setShowCustomItemComposer(true);
                      }}
                      onClose={() => {
                        setShowCustomItemComposer(false);
                        setCustomItemTargetLocationId(null);
                        setCustomItemName('');
                        setEditingCustomItem(null);
                      }}
                      onChange={setCustomItemName}
                      onSubmit={() => void handleSubmitCustomItem()}
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
        open={showEditArea}
        title="Edit Area"
        value={areaForm}
        recentAreaTypeKeys={recentAreaTypeKeys}
        onChange={setAreaForm}
        onClose={() => {
          setAreaForm(getAreaFormValue(area));
          setShowEditArea(false);
        }}
        onSubmit={() => void saveAreaChanges()}
        submitLabel="Save"
      />
    </div>
  );
}
