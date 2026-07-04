'use client';

import {
  AlertTriangle,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  MoreVertical,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Area, Checkpoint, IssueState } from '@/types';
import { getCheckpointIssueState } from '@/types';
import PhotoCapture from '@/components/PhotoCapture';
import MetadataLine from '@/components/MetadataLine';

type CheckpointReviewState = 'pending' | 'ok' | Exclude<IssueState, 'none'>;

type Metrics = {
  stats: { total: number; ok: number; issues: number };
  pending: number;
  photoCount: number;
  commentCount: number;
};

type InspectionLocationCardProps = {
  location: Area['locations'][number];
  locationMetric?: Metrics;
  itemMetrics: Map<string, Metrics>;
  deleteMode?: boolean;
  isSelected?: boolean;
  onToggleSelection?: (locationId: string) => void;
  showOnlyIssues?: boolean;
  expandedItems: Set<string>;
  isExpanded: boolean;
  alwaysExpanded?: boolean;
  hideHeader?: boolean;
  onToggleLocation: (locationId: string) => void | Promise<void>;
  onToggleItem: (itemId: string) => void | Promise<void>;
  onEditCustomLocation?: (locationId: string, currentName: string) => void | Promise<void>;
  onDeleteCustomLocation?: (locationId: string) => void | Promise<void>;
  onToggleCheckpoint: (payload: {
    locationId: string;
    itemId: string;
    checkpointId: string;
    comments: string;
  }) => void | Promise<void>;
  onCommentChange: (value: string) => void;
  onCommentBlur: (locationId: string, itemId: string, checkpointId: string, value: string) => void | Promise<void>;
  onUpdateCheckpointStatus: (locationId: string, itemId: string, checkpointId: string, nextState: CheckpointReviewState) => void | Promise<void>;
  expandedCheckpointId: string | null;
  commentText: string;
  recentComments: string[];
  onAddPhoto: (imageData: string, thumbnail?: string) => void | Promise<void>;
  onAddPhotos: (photos: Array<{ imageData: string; thumbnail?: string }>) => void | Promise<void>;
  onAddFiles: (files: Array<{ data: string; name: string; mimeType: string; size: number }>) => void | Promise<void>;
  onDeletePhoto: (photoId: string) => void | Promise<void>;
  onDeleteFile: (fileId: string) => void | Promise<void>;
  registerItemRef: (itemId: string, node: HTMLDivElement | null) => void;
  editingCustomItemId?: string | null;
  editingCustomItemName?: string;
  onEditingCustomItemChange?: (value: string) => void;
  onSaveCustomItemEdit?: () => void | Promise<void>;
  onCancelCustomItemEdit?: () => void;
  onEditCustomItem?: (locationId: string, itemId: string, currentName: string) => void | Promise<void>;
  onDeleteCustomItem?: (locationId: string, itemId: string) => void | Promise<void>;
  editingCustomCheckpointId?: string | null;
  editingCustomCheckpointName?: string;
  onEditingCustomCheckpointChange?: (value: string) => void;
  onSaveCustomCheckpointEdit?: () => void | Promise<void>;
  onCancelCustomCheckpointEdit?: () => void;
  onEditCustomCheckpoint?: (
    locationId: string,
    itemId: string,
    checkpointId: string,
    currentName: string
  ) => void | Promise<void>;
  onDeleteCustomCheckpoint?: (
    locationId: string,
    itemId: string,
    checkpointId: string
  ) => void | Promise<void>;
  addItemControl?: ReactNode;
  renderCheckpointAddControl?: (locationId: string, itemId: string) => ReactNode;
};

export default function InspectionLocationCard({
  location,
  locationMetric,
  itemMetrics,
  deleteMode = false,
  isSelected = false,
  onToggleSelection,
  showOnlyIssues = false,
  expandedItems,
  isExpanded,
  alwaysExpanded = false,
  hideHeader = false,
  onToggleLocation,
  onToggleItem,
  onEditCustomLocation,
  onDeleteCustomLocation,
  onToggleCheckpoint,
  onCommentChange,
  onCommentBlur,
  onUpdateCheckpointStatus,
  expandedCheckpointId,
  commentText,
  recentComments,
  onAddPhoto,
  onAddPhotos,
  onAddFiles,
  onDeletePhoto,
  onDeleteFile,
  registerItemRef,
  editingCustomItemId,
  editingCustomItemName,
  onEditingCustomItemChange,
  onSaveCustomItemEdit,
  onCancelCustomItemEdit,
  onEditCustomItem,
  onDeleteCustomItem,
  editingCustomCheckpointId,
  editingCustomCheckpointName,
  onEditingCustomCheckpointChange,
  onSaveCustomCheckpointEdit,
  onCancelCustomCheckpointEdit,
  onEditCustomCheckpoint,
  onDeleteCustomCheckpoint,
  addItemControl,
  renderCheckpointAddControl,
}: InspectionLocationCardProps) {
  const locationStats = locationMetric?.stats ?? { total: 0, ok: 0, issues: 0 };
  const isCustomItemsList =
    hideHeader && alwaysExpanded && location.name.trim().toLowerCase() === 'custom items';
  const [openCustomItemMenuId, setOpenCustomItemMenuId] = useState<string | null>(null);
  const [cameraRequest, setCameraRequest] = useState<{ checkpointId: string; token: number } | null>(null);
  const [cameraOnlyCheckpointId, setCameraOnlyCheckpointId] = useState<string | null>(null);
  const customMenuRef = useRef<HTMLDivElement | null>(null);
  const customItemEditRef = useRef<HTMLDivElement | null>(null);
  const customCheckpointEditRef = useRef<HTMLDivElement | null>(null);
  const cameraRequestTokenRef = useRef(0);
  const activeCameraOnlyCheckpointId =
    expandedCheckpointId === cameraOnlyCheckpointId ? cameraOnlyCheckpointId : null;
  const visibleItems = useMemo(
    () =>
      showOnlyIssues
        ? location.items.filter((item) => (itemMetrics.get(item.id)?.stats.issues ?? 0) > 0)
        : location.items,
    [showOnlyIssues, location.items, itemMetrics]
  );

  useEffect(() => {
    if (!openCustomItemMenuId) return;

    function handleDocumentClick(event: MouseEvent) {
      if (!customMenuRef.current?.contains(event.target as Node)) {
        setOpenCustomItemMenuId(null);
      }
    }

    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, [openCustomItemMenuId]);

  useEffect(() => {
    const hasInlineEdit = !!editingCustomItemId || !!editingCustomCheckpointId;
    if (!hasInlineEdit) return;

    function handleDocumentClick(event: MouseEvent) {
      const target = event.target as Node;
      if (customItemEditRef.current?.contains(target) || customCheckpointEditRef.current?.contains(target)) {
        return;
      }

      onCancelCustomItemEdit?.();
      onCancelCustomCheckpointEdit?.();
    }

    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, [
    editingCustomCheckpointId,
    editingCustomItemId,
    onCancelCustomCheckpointEdit,
    onCancelCustomItemEdit,
  ]);

  function openCheckpointComments(locationId: string, itemId: string, checkpointId: string, comments: string) {
    setCameraOnlyCheckpointId(null);
    setCameraRequest(null);
    void onToggleCheckpoint({ locationId, itemId, checkpointId, comments });
  }

  function openCheckpointCamera(locationId: string, itemId: string, checkpointId: string, comments: string) {
    if (expandedCheckpointId !== checkpointId) {
      setCameraOnlyCheckpointId(checkpointId);
      void onToggleCheckpoint({ locationId, itemId, checkpointId, comments });
    } else {
      setCameraOnlyCheckpointId((current) => current ?? null);
    }

    cameraRequestTokenRef.current += 1;
    setCameraRequest({ checkpointId, token: cameraRequestTokenRef.current });
  }

  return (
    <div
      className={
        hideHeader
          ? ''
          : `${openCustomItemMenuId ? 'overflow-visible' : 'overflow-hidden'} rounded-[1.7rem] ${
              isSelected ? 'bg-gray-200 dark:bg-white/[0.09]' : 'card-surface-subtle'
            }`
      }
    >
      {!hideHeader && (
        <button
          onClick={() => {
            if (deleteMode) {
              onToggleSelection?.(location.id);
            } else if (!alwaysExpanded) {
              void onToggleLocation(location.id);
            }
          }}
          className={`w-full px-4 py-4 text-left transition ${
            deleteMode ? '' : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.04]'
          }`}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[1.02rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
                {location.name}
              </div>
              <MetadataLine className="mt-1" issues={locationStats.issues} issuesOnly />
            </div>
            <div className="ml-3 flex items-center gap-2">
              {!deleteMode && location.isCustom ? (
                <div
                  ref={openCustomItemMenuId === location.id ? customMenuRef : null}
                  className="relative"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setOpenCustomItemMenuId((current) => (current === location.id ? null : location.id));
                    }}
                    className="flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-500 transition hover:bg-white hover:text-gray-700 dark:border-white/10 dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
                    aria-label={`More actions for ${location.name}`}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                  {openCustomItemMenuId === location.id && (
                    <div
                      className="menu-surface absolute right-0 top-[calc(100%+0.35rem)] z-50 min-w-[10rem] rounded-2xl p-1.5"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={async (event) => {
                          event.stopPropagation();
                          setOpenCustomItemMenuId(null);
                          await onEditCustomLocation?.(location.id, location.name);
                        }}
                        className="flex w-full items-center gap-3 rounded-[1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                      >
                        <Pencil className="h-4 w-4" />
                        Edit item
                      </button>
                      <button
                        type="button"
                        onClick={async (event) => {
                          event.stopPropagation();
                          setOpenCustomItemMenuId(null);
                          await onDeleteCustomLocation?.(location.id);
                        }}
                        className="flex w-full items-center gap-3 rounded-[1rem] px-4 py-3 text-left text-sm text-[var(--accent)] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete item
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
              {!alwaysExpanded && !deleteMode && (
                isExpanded ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />
              )}
            </div>
          </div>
        </button>
      )}

      {(alwaysExpanded || isExpanded) && (
        <div className={hideHeader ? 'space-y-2.5' : 'space-y-2.5 px-2.5 pb-2.5 pt-2'}>
          <div className="space-y-2.5">
          {visibleItems.map((item) => {
            const itemMetric = itemMetrics.get(item.id);
            const itemStats = itemMetric?.stats ?? { total: 0, ok: 0, issues: 0 };
            const customCheckpoint = isCustomItemsList ? item.checkpoints[0] ?? null : null;
            const isExpandedCustomCheckpoint = customCheckpoint ? expandedCheckpointId === customCheckpoint.id : false;
            const isInlineCustomItem = !!item.isCustom && !isCustomItemsList;

            if (isCustomItemsList && customCheckpoint) {
              const customIssueState = getCheckpointIssueState(customCheckpoint);
              const isEditingCustomItem = editingCustomItemId === item.id;
              return (
                <div key={item.id} ref={(node) => registerItemRef(item.id, node)} className="space-y-2">
                  <CheckpointRow
                    checkpoint={customCheckpoint}
                    label={item.name}
                    editContainerRef={isEditingCustomItem ? customItemEditRef : undefined}
                    editableLabel={isEditingCustomItem}
                    editableValue={editingCustomItemName ?? item.name}
                    onEditableValueChange={onEditingCustomItemChange}
                    onSaveEdit={onSaveCustomItemEdit}
                    onCancelEdit={onCancelCustomItemEdit}
                    issueState={customIssueState}
                    onToggleExpand={() =>
                      openCheckpointComments(location.id, item.id, customCheckpoint.id, customCheckpoint.comments)
                    }
                    onToggleIssue={() =>
                      void onUpdateCheckpointStatus(
                        location.id,
                        item.id,
                        customCheckpoint.id,
                        customIssueState === 'open' ? 'pending' : 'open'
                      )
                    }
                    onOpenCamera={() => {
                      openCheckpointCamera(location.id, item.id, customCheckpoint.id, customCheckpoint.comments);
                    }}
                    extraActions={
                      <div
                        ref={openCustomItemMenuId === item.id ? customMenuRef : null}
                        className="relative"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setOpenCustomItemMenuId((current) => (current === item.id ? null : item.id));
                          }}
                    className="flex h-12 w-12 items-center justify-center rounded-[1.15rem] border border-black/5 bg-white/70 text-gray-500 transition hover:bg-white hover:text-gray-700 dark:border-white/10 dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
                          aria-label={`More actions for ${item.name}`}
                        >
                          <MoreVertical className="h-5 w-5" />
                        </button>
                        {openCustomItemMenuId === item.id && (
                          <div
                            className="menu-surface absolute right-0 top-[calc(100%+0.35rem)] z-50 min-w-[10rem] rounded-2xl p-1.5"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={async (event) => {
                                event.stopPropagation();
                                setOpenCustomItemMenuId(null);
                                await onEditCustomItem?.(location.id, item.id, item.name);
                              }}
                              className="flex w-full items-center gap-3 rounded-[1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                            >
                              <Pencil className="h-4 w-4" />
                              Edit item
                            </button>
                            <button
                              type="button"
                              onClick={async (event) => {
                                event.stopPropagation();
                                setOpenCustomItemMenuId(null);
                                await onDeleteCustomItem?.(location.id, item.id);
                              }}
                              className="flex w-full items-center gap-3 rounded-[1rem] px-4 py-3 text-left text-sm text-[var(--accent)] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete item
                            </button>
                          </div>
                        )}
                      </div>
                    }
                  />
                  {isExpandedCustomCheckpoint && (
                    <InlineCheckpointEditor
                      checkpoint={customCheckpoint}
                      locationId={location.id}
                      itemId={item.id}
                      commentText={commentText}
                      recentComments={recentComments}
                      onCommentChange={onCommentChange}
                      onCommentBlur={onCommentBlur}
                      onAddPhoto={onAddPhoto}
                      onAddPhotos={onAddPhotos}
                      onAddFiles={onAddFiles}
                      onDeletePhoto={onDeletePhoto}
                      onDeleteFile={onDeleteFile}
                      showCommentEditor={activeCameraOnlyCheckpointId !== customCheckpoint.id}
                      onCloseEditor={() =>
                        openCheckpointComments(location.id, item.id, customCheckpoint.id, customCheckpoint.comments)
                      }
                      openCameraSignal={
                        cameraRequest?.checkpointId === customCheckpoint.id ? cameraRequest.token : undefined
                      }
                    />
                  )}
                </div>
              );
            }

            const isItemExpanded = expandedItems.has(item.id);
            const isEditingCustomItem = editingCustomItemId === item.id;
            // When a location has exactly one non-custom item sharing the same name,
            // skip the item header and render checkpoints directly (no redundant wrapper).
            const hideItemHeader =
              !item.isCustom &&
              visibleItems.filter((i) => !i.isCustom).length === 1 &&
              item.name.trim().toLowerCase() === location.name.trim().toLowerCase();

            if (hideItemHeader) {
              const filteredCheckpoints = item.checkpoints.filter(
                (checkpoint) => !showOnlyIssues || getCheckpointIssueState(checkpoint) !== 'none'
              );
              return (
                <div key={item.id} ref={(node) => registerItemRef(item.id, node)} className="space-y-2.5">
                  {filteredCheckpoints.map((checkpoint) => {
                    const issueState = getCheckpointIssueState(checkpoint);
                    const isExpandedCheckpoint = expandedCheckpointId === checkpoint.id;
                    return (
                      <div key={checkpoint.id} className="space-y-2">
                        <CheckpointRow
                          checkpoint={checkpoint}
                          issueState={issueState}
                          onToggleExpand={() =>
                            openCheckpointComments(location.id, item.id, checkpoint.id, checkpoint.comments)
                          }
                          onToggleIssue={() =>
                            void onUpdateCheckpointStatus(
                              location.id,
                              item.id,
                              checkpoint.id,
                              issueState === 'open' ? 'pending' : 'open'
                            )
                          }
                          onOpenCamera={() => {
                            openCheckpointCamera(location.id, item.id, checkpoint.id, checkpoint.comments);
                          }}
                          extraActions={
                            checkpoint.isCustom ? (
                              <div
                                ref={openCustomItemMenuId === checkpoint.id ? customMenuRef : null}
                                className="relative"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onPointerDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                  }}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setOpenCustomItemMenuId((current) => (current === checkpoint.id ? null : checkpoint.id));
                                  }}
                                  className="flex h-10 w-10 items-center justify-center rounded-[1rem] bg-black/[0.05] text-gray-500 transition hover:bg-black/[0.08] hover:text-gray-700 dark:bg-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
                                  aria-label={`More actions for ${checkpoint.name}`}
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </button>
                                {openCustomItemMenuId === checkpoint.id && (
                                  <div
                                    className="menu-surface absolute right-0 top-[calc(100%+0.35rem)] z-50 min-w-[10rem] rounded-2xl py-1"
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <button
                                      type="button"
                                      onClick={async (event) => {
                                        event.stopPropagation();
                                        setOpenCustomItemMenuId(null);
                                        await onEditCustomCheckpoint?.(
                                          location.id,
                                          item.id,
                                          checkpoint.id,
                                          checkpoint.name
                                        );
                                      }}
                                      className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
                                    >
                                      <Pencil className="h-4 w-4" />
                                      Edit item
                                    </button>
                                    <button
                                      type="button"
                                      onClick={async (event) => {
                                        event.stopPropagation();
                                        setOpenCustomItemMenuId(null);
                                        await onDeleteCustomCheckpoint?.(location.id, item.id, checkpoint.id);
                                      }}
                                      className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-[var(--accent)] hover:bg-gray-50 dark:hover:bg-gray-700"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                      Delete item
                                    </button>
                                  </div>
                                )}
                              </div>
                            ) : null
                          }
                        />
                        {isExpandedCheckpoint && (
                          <InlineCheckpointEditor
                            checkpoint={checkpoint}
                            locationId={location.id}
                            itemId={item.id}
                            commentText={commentText}
                            recentComments={recentComments}
                            onCommentChange={onCommentChange}
                            onCommentBlur={onCommentBlur}
                            onAddPhoto={onAddPhoto}
                            onAddPhotos={onAddPhotos}
                            onAddFiles={onAddFiles}
                            onDeletePhoto={onDeletePhoto}
                            onDeleteFile={onDeleteFile}
                            showCommentEditor={activeCameraOnlyCheckpointId !== checkpoint.id}
                            onCloseEditor={() =>
                              openCheckpointComments(location.id, item.id, checkpoint.id, checkpoint.comments)
                            }
                            openCameraSignal={
                              cameraRequest?.checkpointId === checkpoint.id ? cameraRequest.token : undefined
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            }

            return (
              <div
                key={item.id}
                ref={(node) => registerItemRef(item.id, node)}
                className={isItemExpanded ? 'card-surface-subtle rounded-[1.5rem]' : ''}
              >
                {isEditingCustomItem ? (
                  <div
                    ref={customItemEditRef}
                    className="card-surface-subtle w-full rounded-[1.4rem] px-4 py-3 text-left dark:border-transparent"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <input
                          type="text"
                          value={editingCustomItemName ?? item.name}
                          onChange={(event) => onEditingCustomItemChange?.(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void onSaveCustomItemEdit?.();
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              onCancelCustomItemEdit?.();
                            }
                          }}
                          className="w-full rounded-[1rem] bg-transparent text-[1.02rem] tracking-[-0.01em] text-gray-900 outline-none dark:text-white"
                          aria-label={`Edit name for ${item.name}`}
                          autoFocus
                        />
                        <MetadataLine
                          className="mt-1"
                          issues={itemStats.issues}
                          notes={itemMetric?.commentCount ?? 0}
                          photos={itemMetric?.photoCount ?? 0}
                        />
                      </div>
                      <div className="ml-3 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void onSaveCustomItemEdit?.()}
                          className="flex h-10 w-10 items-center justify-center rounded-[1rem] bg-black/[0.05] text-gray-500 transition hover:bg-black/[0.08] hover:text-gray-700 dark:bg-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
                          aria-label={`Save ${item.name}`}
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={onCancelCustomItemEdit}
                          className="flex h-10 w-10 items-center justify-center rounded-[1rem] bg-black/[0.05] text-gray-500 transition hover:bg-black/[0.08] hover:text-gray-700 dark:bg-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
                          aria-label={`Cancel editing ${item.name}`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => void onToggleItem(item.id)}
                    className={`w-full px-4 py-3 text-left transition ${
                      isItemExpanded
                        ? 'rounded-t-[1.4rem]'
                        : 'card-surface-subtle rounded-[1.3rem] dark:border-transparent hover:bg-[var(--surface-strong)] dark:hover:bg-white/[0.06]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[1.02rem] tracking-[-0.01em] text-gray-900 dark:text-white">
                          {item.name}
                        </div>
                        <MetadataLine
                          className="mt-1"
                          issues={itemStats.issues}
                          notes={itemMetric?.commentCount ?? 0}
                          photos={itemMetric?.photoCount ?? 0}
                        />
                      </div>
                      <div className="ml-3 flex items-center gap-2">
                        {isInlineCustomItem ? (
                          <div
                            ref={openCustomItemMenuId === item.id ? customMenuRef : null}
                            className="relative"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <button
                              type="button"
                              onPointerDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setOpenCustomItemMenuId((current) => (current === item.id ? null : item.id));
                              }}
                              className="flex h-10 w-10 items-center justify-center rounded-[1rem] bg-black/[0.05] text-gray-500 transition hover:bg-black/[0.08] hover:text-gray-700 dark:bg-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
                              aria-label={`More actions for ${item.name}`}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                            {openCustomItemMenuId === item.id && (
                              <div
                                className="menu-surface absolute right-0 top-[calc(100%+0.35rem)] z-50 min-w-[10rem] rounded-2xl py-1"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={async (event) => {
                                    event.stopPropagation();
                                    setOpenCustomItemMenuId(null);
                                    await onEditCustomItem?.(location.id, item.id, item.name);
                                  }}
                                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
                                >
                                  <Pencil className="h-4 w-4" />
                                  Edit item
                                </button>
                                <button
                                  type="button"
                                  onClick={async (event) => {
                                    event.stopPropagation();
                                    setOpenCustomItemMenuId(null);
                                    await onDeleteCustomItem?.(location.id, item.id);
                                  }}
                                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-[var(--accent)] hover:bg-gray-50 dark:hover:bg-gray-700"
                                >
                                  <Trash2 className="h-4 w-4" />
                                  Delete item
                                </button>
                              </div>
                            )}
                          </div>
                        ) : null}
                        {isItemExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                      </div>
                    </div>
                  </button>
                )}

                {isItemExpanded && (
                  <div className="space-y-2.5 px-2 pb-2">
                    {item.checkpoints
                      .filter((checkpoint) => !showOnlyIssues || getCheckpointIssueState(checkpoint) !== 'none')
                      .map((checkpoint) => {
                        const issueState = getCheckpointIssueState(checkpoint);
                        const isExpandedCheckpoint = expandedCheckpointId === checkpoint.id;

                        return (
                          <div key={checkpoint.id} className="space-y-2">
                          <CheckpointRow
                            checkpoint={checkpoint}
                            editContainerRef={editingCustomCheckpointId === checkpoint.id ? customCheckpointEditRef : undefined}
                            editableLabel={editingCustomCheckpointId === checkpoint.id}
                            editableValue={editingCustomCheckpointName ?? checkpoint.name}
                            onEditableValueChange={onEditingCustomCheckpointChange}
                            onSaveEdit={onSaveCustomCheckpointEdit}
                            onCancelEdit={onCancelCustomCheckpointEdit}
                            issueState={issueState}
                            onToggleExpand={() =>
                              openCheckpointComments(location.id, item.id, checkpoint.id, checkpoint.comments)
                            }
                            onToggleIssue={() =>
                              void onUpdateCheckpointStatus(
                                location.id,
                                item.id,
                                checkpoint.id,
                                issueState === 'open' ? 'pending' : 'open'
                              )
                            }
                            onOpenCamera={() => {
                              openCheckpointCamera(location.id, item.id, checkpoint.id, checkpoint.comments);
                            }}
                            extraActions={
                              checkpoint.isCustom || item.isCustom ? (
                                <div
                                  ref={openCustomItemMenuId === checkpoint.id ? customMenuRef : null}
                                  className="relative"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    onPointerDown={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                    }}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      setOpenCustomItemMenuId((current) => (current === checkpoint.id ? null : checkpoint.id));
                                    }}
                                    className="flex h-10 w-10 items-center justify-center rounded-[1rem] bg-black/[0.05] text-gray-500 transition hover:bg-black/[0.08] hover:text-gray-700 dark:bg-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
                                    aria-label={`More actions for ${checkpoint.name}`}
                                  >
                                    <MoreVertical className="h-4 w-4" />
                                  </button>
                                  {openCustomItemMenuId === checkpoint.id && (
                                    <div
                                      className="menu-surface absolute right-0 top-[calc(100%+0.35rem)] z-50 min-w-[10rem] rounded-2xl py-1"
                                      onPointerDown={(event) => event.stopPropagation()}
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      <button
                                        type="button"
                                        onClick={async (event) => {
                                          event.stopPropagation();
                                          setOpenCustomItemMenuId(null);
                                          await onEditCustomCheckpoint?.(
                                            location.id,
                                            item.id,
                                            checkpoint.id,
                                            checkpoint.name
                                          );
                                        }}
                                        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
                                      >
                                        <Pencil className="h-4 w-4" />
                                        Edit item
                                      </button>
                                      <button
                                        type="button"
                                        onClick={async (event) => {
                                          event.stopPropagation();
                                          setOpenCustomItemMenuId(null);
                                          await onDeleteCustomCheckpoint?.(location.id, item.id, checkpoint.id);
                                        }}
                                        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-[var(--accent)] hover:bg-gray-50 dark:hover:bg-gray-700"
                                      >
                                        <Trash2 className="h-4 w-4" />
                                        Delete item
                                      </button>
                                    </div>
                                  )}
                                </div>
                              ) : null
                            }
                          />
                          {isExpandedCheckpoint && (
                            <InlineCheckpointEditor
                              checkpoint={checkpoint}
                              locationId={location.id}
                              itemId={item.id}
                              commentText={commentText}
                              recentComments={recentComments}
                              onCommentChange={onCommentChange}
                              onCommentBlur={onCommentBlur}
                              onAddPhoto={onAddPhoto}
                              onAddPhotos={onAddPhotos}
                              onAddFiles={onAddFiles}
                              onDeletePhoto={onDeletePhoto}
                              onDeleteFile={onDeleteFile}
                              showCommentEditor={activeCameraOnlyCheckpointId !== checkpoint.id}
                              onCloseEditor={() =>
                                openCheckpointComments(location.id, item.id, checkpoint.id, checkpoint.comments)
                              }
                              openCameraSignal={
                                cameraRequest?.checkpointId === checkpoint.id ? cameraRequest.token : undefined
                              }
                            />
                          )}
                        </div>
                      );
                    })}
                    {renderCheckpointAddControl ? renderCheckpointAddControl(location.id, item.id) : null}
                  </div>
                )}
              </div>
            );
          })}
          {addItemControl ? <div>{addItemControl}</div> : null}
          </div>
        </div>
      )}
    </div>
  );
}

function CheckpointRow({
  checkpoint,
  label,
  editContainerRef,
  editableLabel = false,
  editableValue,
  onEditableValueChange,
  onSaveEdit,
  onCancelEdit,
  issueState,
  onToggleExpand,
  onToggleIssue,
  onOpenCamera,
  extraActions,
}: {
  checkpoint: Checkpoint;
  label?: string;
  editContainerRef?: RefObject<HTMLDivElement | null>;
  editableLabel?: boolean;
  editableValue?: string;
  onEditableValueChange?: (value: string) => void;
  onSaveEdit?: () => void | Promise<void>;
  onCancelEdit?: () => void;
  issueState: IssueState;
  onToggleExpand: () => void;
  onToggleIssue: () => void;
  onOpenCamera: () => void;
  extraActions?: ReactNode;
}) {
  const photoCount = checkpoint.photos.length;

  return (
    <div
      ref={editableLabel ? editContainerRef : undefined}
      className={`rounded-[1.35rem] px-3.5 py-3.5 transition ${
        !editableLabel ? 'cursor-pointer' : ''
      } ${
        issueState === 'open'
          ? 'accent-tint dark:bg-[#882D17]'
          : 'bg-blue-50 dark:bg-[#44362F]'
      }`}
      onClick={!editableLabel ? onToggleExpand : undefined}
    >
      <div className="flex items-center justify-between gap-3">
        {editableLabel ? (
          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={editableValue ?? label ?? checkpoint.name}
              onChange={(event) => onEditableValueChange?.(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void onSaveEdit?.();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancelEdit?.();
                }
              }}
              className="w-full rounded-[1rem] bg-transparent text-[0.98rem] font-normal text-gray-900 outline-none dark:text-white"
              aria-label={`Edit name for ${label ?? checkpoint.name}`}
              autoFocus
            />
          </div>
        ) : (
          <div className="min-w-0 flex-1 text-left">
            <div className="text-[0.98rem] font-normal tracking-[-0.01em] text-gray-900 dark:text-white">{label ?? checkpoint.name}</div>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {editableLabel ? (
            <>
              <button
                type="button"
                onClick={() => void onSaveEdit?.()}
                className="flex h-10 w-10 items-center justify-center rounded-[1rem] bg-white text-gray-700 transition dark:bg-white/[0.09] dark:text-white"
                aria-label={`Save ${label ?? checkpoint.name}`}
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                className="flex h-10 w-10 items-center justify-center rounded-[1rem] text-gray-400 transition hover:bg-white/70 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/[0.08] dark:hover:text-gray-100"
                aria-label={`Cancel editing ${label ?? checkpoint.name}`}
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenCamera();
                }}
                className={`flex h-10 w-10 items-center justify-center rounded-[1rem] transition ${
                  photoCount > 0
                    ? 'accent-bg text-white'
                    : 'border border-black/5 bg-white/70 text-gray-400 hover:bg-white hover:text-gray-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-400 dark:hover:bg-white/[0.08] dark:hover:text-gray-100'
                }`}
                aria-label={`Add photos for ${checkpoint.name}`}
              >
                <Camera className="h-4 w-4" />
              </button>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleIssue();
                }}
                className={`flex h-10 w-10 items-center justify-center rounded-[1rem] transition ${
                  issueState === 'open'
                    ? 'accent-bg text-white'
                    : 'border border-black/5 bg-white/70 text-gray-400 hover:bg-white hover:text-[var(--accent)] dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-400 dark:hover:bg-white/[0.08]'
                }`}
                aria-label={`Flag issue for ${checkpoint.name}`}
              >
                <AlertTriangle className="w-5 h-5" />
              </button>
              {extraActions}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function InlineCheckpointEditor({
  checkpoint,
  locationId,
  itemId,
  commentText,
  recentComments,
  onCommentChange,
  onCommentBlur,
  onAddPhoto,
  onAddPhotos,
  onAddFiles,
  onDeletePhoto,
  onDeleteFile,
  showCommentEditor = true,
  onCloseEditor,
  openCameraSignal,
  issueState,
  onToggleIssue,
}: {
  checkpoint: Checkpoint;
  locationId: string;
  itemId: string;
  commentText: string;
  recentComments: string[];
  onCommentChange: (value: string) => void;
  onCommentBlur: (locationId: string, itemId: string, checkpointId: string, value: string) => void | Promise<void>;
  onAddPhoto: (imageData: string, thumbnail?: string) => void | Promise<void>;
  onAddPhotos: (photos: Array<{ imageData: string; thumbnail?: string }>) => void | Promise<void>;
  onAddFiles: (files: Array<{ data: string; name: string; mimeType: string; size: number }>) => void | Promise<void>;
  onDeletePhoto: (photoId: string) => void | Promise<void>;
  onDeleteFile: (fileId: string) => void | Promise<void>;
  showCommentEditor?: boolean;
  onCloseEditor?: () => void;
  openCameraSignal?: number;
  issueState?: IssueState;
  onToggleIssue?: () => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleDocumentClick(event: MouseEvent) {
      if (!editorRef.current) return;
      if (editorRef.current.contains(event.target as Node)) return;
      onCloseEditor?.();
    }

    document.addEventListener('click', handleDocumentClick);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, [onCloseEditor]);

  return (
    <div ref={editorRef} className="space-y-2.5 px-1 pb-1 pt-1">
      {onToggleIssue && (
        <div className="flex items-center justify-end gap-2">
          {onToggleIssue && (
            <button
              onClick={onToggleIssue}
              className={`flex h-9 w-9 items-center justify-center rounded-[0.95rem] transition ${
                issueState === 'open'
                  ? 'accent-bg text-white'
                  : 'border border-black/5 bg-white/70 text-gray-400 hover:bg-white hover:text-[var(--accent)] dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-400 dark:hover:bg-white/[0.08]'
              }`}
              aria-label={`Flag issue for ${checkpoint.name}`}
            >
              <AlertTriangle className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      <PhotoCapture
        photos={checkpoint.photos}
        files={checkpoint.files ?? []}
        onAddPhoto={onAddPhoto}
        onAddPhotos={onAddPhotos}
        onAddFiles={onAddFiles}
        onDeletePhoto={onDeletePhoto}
        onDeleteFile={onDeleteFile}
        hideCameraButton
        openCameraSignal={openCameraSignal}
      />
      {showCommentEditor && (
        <>
          <textarea
            value={commentText}
            onChange={(e) => onCommentChange(e.target.value)}
            onBlur={(e) => void onCommentBlur(locationId, itemId, checkpoint.id, e.target.value)}
            className="field-shell min-h-[96px] resize-none text-sm"
            placeholder="Add inspection note"
          />
          {recentComments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {recentComments.map((comment) => (
                <button
                  key={comment}
                  onClick={() => onCommentChange(comment)}
                  className="segmented-chip px-3 py-1.5 text-left text-xs transition hover:bg-white hover:text-gray-900 dark:hover:bg-white/[0.1] dark:hover:text-white"
                >
                  {comment}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
