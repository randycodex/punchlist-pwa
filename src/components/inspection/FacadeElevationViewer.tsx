'use client';

/* eslint-disable @next/next/no-img-element */

import {
  ChevronDown,
  ChevronRight,
  MapPin,
  Minus,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type TouchEvent,
  useCallback,
} from 'react';
import type { Area, FacadeElevationDrawing } from '@/types';
import type { ElevationMarkerReference } from '@/lib/elevationMarkers';

type ChecklistSelection = {
  locationId: string;
  itemId: string;
  checkpointId: string;
};

export type FacadeElevationSelection = ChecklistSelection & {
  xPercent: number;
  yPercent: number;
  customItemName?: string;
  customCheckpointName?: string;
};

type FacadeElevationViewerProps = {
  drawing: FacadeElevationDrawing;
  locations: Area['locations'];
  markers?: ElevationMarkerReference[];
  onOpenSelection: (selection: FacadeElevationSelection) => void | Promise<void>;
};

type TapPoint = {
  xPercent: number;
  yPercent: number;
};

type PickerState = TapPoint & ChecklistSelection;

type PickerMode = 'existing' | 'custom';

type DragGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
};

type PinchGesture = {
  distance: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  centerX: number;
  centerY: number;
};

type TouchPoint = {
  clientX: number;
  clientY: number;
};

type ElevationLocation = Area['locations'][number];
type ElevationItem = ElevationLocation['items'][number];
type ElevationCheckpoint = ElevationItem['checkpoints'][number];

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const ZOOM_STEP = 0.5;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampZoom(value: number) {
  return clamp(value, MIN_ZOOM, MAX_ZOOM);
}

function getTouchDistance(first: TouchPoint, second: TouchPoint) {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function getTouchCenter(first: TouchPoint, second: TouchPoint) {
  return {
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
  };
}

function isExistingElevationCheckpoint(checkpoint: ElevationCheckpoint) {
  return !checkpoint.isCustom && !checkpoint.isElevationIssue;
}

function isExistingElevationItem(item: ElevationItem) {
  return !item.isCustom && item.checkpoints.some(isExistingElevationCheckpoint);
}

function getFirstAvailableSelection(locations: Area['locations']): ChecklistSelection | null {
  for (const location of locations) {
    for (const item of location.items.filter(isExistingElevationItem)) {
      const checkpoint = item.checkpoints.find(isExistingElevationCheckpoint);
      if (checkpoint) {
        return {
          locationId: location.id,
          itemId: item.id,
          checkpointId: checkpoint.id,
        };
      }
    }
  }

  return null;
}

function getLocationOptionLabel(location: Area['locations'][number]) {
  return location.sectionLabel ? `${location.sectionLabel} - ${location.name}` : location.name;
}

export default function FacadeElevationViewer({
  drawing,
  locations,
  markers = [],
  onOpenSelection,
}: FacadeElevationViewerProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [pickerMode, setPickerMode] = useState<PickerMode>('existing');
  const [customItemName, setCustomItemName] = useState('');
  const [customCheckpointName, setCustomCheckpointName] = useState('');
  const [isOpeningSelection, setIsOpeningSelection] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [lastSelection, setLastSelection] = useState<ChecklistSelection | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLImageElement | HTMLObjectElement | HTMLDivElement | null>(null);
  const dragRef = useRef<DragGesture | null>(null);
  const pinchRef = useRef<PinchGesture | null>(null);
  const suppressNextClickRef = useRef(false);
  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);

  const selectableLocations = useMemo(
    () =>
      locations.filter((location) =>
        location.items.some(isExistingElevationItem)
      ),
    [locations]
  );
  const firstSelection = useMemo(
    () => getFirstAvailableSelection(selectableLocations),
    [selectableLocations]
  );
  const preferredSelection = useMemo(() => {
    if (!lastSelection) return firstSelection;

    const location = selectableLocations.find((entry) => entry.id === lastSelection.locationId);
    const item = location?.items.find((entry) => entry.id === lastSelection.itemId && isExistingElevationItem(entry));
    const checkpoint = item?.checkpoints.find(
      (entry) => entry.id === lastSelection.checkpointId && isExistingElevationCheckpoint(entry)
    );

    return location && item && checkpoint ? lastSelection : firstSelection;
  }, [firstSelection, lastSelection, selectableLocations]);
  const selectedLocation = picker
    ? selectableLocations.find((location) => location.id === picker.locationId) ?? null
    : null;
  const selectedItems =
    selectedLocation?.items.filter(isExistingElevationItem) ?? [];
  const selectedItem = picker
    ? selectedItems.find((item) => item.id === picker.itemId) ?? null
    : null;
  const selectedCheckpoints = selectedItem?.checkpoints.filter(isExistingElevationCheckpoint) ?? [];
  const isImage = drawing.mimeType.startsWith('image/');
  const isPdf = drawing.mimeType === 'application/pdf';

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  const getAnchoredOffset = useCallback((
    currentScale: number,
    nextScale: number,
    currentOffset: { x: number; y: number },
    anchor: { clientX: number; clientY: number }
  ) => {
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    if (!viewportRect) return currentOffset;

    const anchorX = anchor.clientX - (viewportRect.left + viewportRect.width / 2);
    const anchorY = anchor.clientY - (viewportRect.top + viewportRect.height / 2);
    const scaleRatio = nextScale / currentScale;

    return {
      x: anchorX - (anchorX - currentOffset.x) * scaleRatio,
      y: anchorY - (anchorY - currentOffset.y) * scaleRatio,
    };
  }, []);

  const updateZoom = useCallback((nextScale: number, anchor?: { clientX: number; clientY: number }) => {
    const currentScale = scaleRef.current;
    const currentOffset = offsetRef.current;
    const clampedScale = clampZoom(nextScale);
    setScale(clampedScale);
    if (clampedScale <= MIN_ZOOM) {
      setOffset({ x: 0, y: 0 });
    } else if (anchor && currentScale > 0) {
      setOffset(getAnchoredOffset(currentScale, clampedScale, currentOffset, anchor));
    }
  }, [getAnchoredOffset]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleNativeWheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      updateZoom(scaleRef.current - event.deltaY * 0.004, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };

    viewport.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', handleNativeWheel);
    };
  }, [updateZoom]);

  function resetZoom() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  function toggleCollapsed() {
    setIsCollapsed((current) => !current);
    setPicker(null);
    setPickerMode('existing');
    setCustomItemName('');
    setCustomCheckpointName('');
  }

  function getTapPoint(clientX: number, clientY: number): TapPoint | null {
    const rect = mediaRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;

    return {
      xPercent: clamp(((clientX - rect.left) / rect.width) * 100, 0, 100),
      yPercent: clamp(((clientY - rect.top) / rect.height) * 100, 0, 100),
    };
  }

  function openPickerAtPoint(clientX: number, clientY: number) {
    if (!preferredSelection) return;
    const tapPoint = getTapPoint(clientX, clientY);
    if (!tapPoint) return;

    setPicker({
      ...tapPoint,
      ...preferredSelection,
    });
    setPickerMode('existing');
    setCustomItemName('');
    setCustomCheckpointName('');
  }

  function handleViewerClick(event: MouseEvent<HTMLDivElement>) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    openPickerAtPoint(event.clientX, event.clientY);
  }

  function handleViewerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const rect = mediaRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    openPickerAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (scale <= 1) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const gesture = dragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (Math.hypot(deltaX, deltaY) > 6) {
      gesture.moved = true;
    }

    setOffset({
      x: gesture.originX + deltaX,
      y: gesture.originY + deltaY,
    });
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const gesture = dragRef.current;
    if (gesture?.pointerId === event.pointerId) {
      if (gesture.moved) {
        suppressNextClickRef.current = true;
        window.setTimeout(() => {
          suppressNextClickRef.current = false;
        }, 0);
      }
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    const center = getTouchCenter(event.touches[0], event.touches[1]);
    pinchRef.current = {
      distance: getTouchDistance(event.touches[0], event.touches[1]),
      scale,
      offsetX: offset.x,
      offsetY: offset.y,
      centerX: center.clientX,
      centerY: center.clientY,
    };
  }

  function handleTouchMove(event: TouchEvent<HTMLDivElement>) {
    const gesture = pinchRef.current;
    if (!gesture || event.touches.length !== 2) return;
    event.preventDefault();
    event.stopPropagation();

    if (gesture.distance === 0) return;
    const nextScale = clampZoom(
      gesture.scale * (getTouchDistance(event.touches[0], event.touches[1]) / gesture.distance)
    );
    setScale(nextScale);
    if (nextScale <= MIN_ZOOM) {
      setOffset({ x: 0, y: 0 });
    } else {
      const currentCenter = getTouchCenter(event.touches[0], event.touches[1]);
      const anchoredOffset = getAnchoredOffset(
        gesture.scale,
        nextScale,
        { x: gesture.offsetX, y: gesture.offsetY },
        { clientX: gesture.centerX, clientY: gesture.centerY }
      );

      setOffset({
        x: anchoredOffset.x + currentCenter.clientX - gesture.centerX,
        y: anchoredOffset.y + currentCenter.clientY - gesture.centerY,
      });
    }
  }

  function handleTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const hadPinchGesture = pinchRef.current !== null;
    if (event.touches.length < 2) {
      pinchRef.current = null;
      if (hadPinchGesture) {
        suppressNextClickRef.current = true;
        window.setTimeout(() => {
          suppressNextClickRef.current = false;
        }, 0);
      }
    }
  }

  function handleLocationChange(locationId: string) {
    const location = selectableLocations.find((entry) => entry.id === locationId);
    const item = location?.items.find(isExistingElevationItem);
    const checkpoint = item?.checkpoints.find(isExistingElevationCheckpoint);
    if (!picker || !location || !item || !checkpoint) return;

    setPicker({
      ...picker,
      locationId: location.id,
      itemId: item.id,
      checkpointId: checkpoint.id,
    });
  }

  function handleItemChange(itemId: string) {
    const item = selectedItems.find((entry) => entry.id === itemId);
    const checkpoint = item?.checkpoints.find(isExistingElevationCheckpoint);
    if (!picker || !item || !checkpoint) return;

    setPicker({
      ...picker,
      itemId: item.id,
      checkpointId: checkpoint.id,
    });
  }

  function handleCheckpointChange(checkpointId: string) {
    if (!picker) return;
    setPicker({
      ...picker,
      checkpointId,
    });
  }

  async function openSelection() {
    if (!picker || isOpeningSelection) return;
    const trimmedCustomItemName = customItemName.trim();
    const trimmedCustomCheckpointName = customCheckpointName.trim();
    if (pickerMode === 'custom' && (!trimmedCustomItemName || !trimmedCustomCheckpointName)) return;

    setIsOpeningSelection(true);
    try {
      await onOpenSelection({
        locationId: picker.locationId,
        itemId: picker.itemId,
        checkpointId: picker.checkpointId,
        xPercent: picker.xPercent,
        yPercent: picker.yPercent,
        customItemName: pickerMode === 'custom' ? trimmedCustomItemName : undefined,
        customCheckpointName: pickerMode === 'custom' ? trimmedCustomCheckpointName : undefined,
      });
      setLastSelection({
        locationId: picker.locationId,
        itemId: picker.itemId,
        checkpointId: picker.checkpointId,
      });
      setPicker(null);
      setPickerMode('existing');
      setCustomItemName('');
      setCustomCheckpointName('');
    } finally {
      setIsOpeningSelection(false);
    }
  }

  return (
    <section className="card-surface-subtle overflow-hidden rounded-[1.6rem]">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="section-eyebrow">Elevation Drawing</div>
          <div className="truncate text-sm font-semibold text-gray-900 dark:text-white">
            {drawing.name || drawing.fileName}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-[1rem] text-gray-400 transition hover:bg-black/[0.04] hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
          aria-label={isCollapsed ? 'Expand elevation drawing' : 'Collapse elevation drawing'}
          title={isCollapsed ? 'Expand elevation drawing' : 'Collapse elevation drawing'}
        >
          {isCollapsed ? <ChevronRight className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
        </button>
      </div>

      {!isCollapsed && (
        <>
          <div className="flex items-center justify-between gap-3 border-t border-black/[0.04] px-4 pb-3 pt-2 dark:border-white/[0.05]">
            <div className="min-w-0 text-xs font-semibold text-gray-500 dark:text-gray-400">
              {markers.length === 1 ? '1 marked issue' : `${markers.length} marked issues`}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => updateZoom(scale - ZOOM_STEP)}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-black/5 bg-white/75 text-gray-600 transition hover:bg-white disabled:opacity-40 dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                disabled={scale <= MIN_ZOOM}
                aria-label="Zoom out"
                title="Zoom out"
              >
                <Minus className="h-4 w-4" />
              </button>
              <div className="min-w-12 text-center text-xs font-semibold text-gray-500 dark:text-gray-400">
                {Math.round(scale * 100)}%
              </div>
              <button
                type="button"
                onClick={() => updateZoom(scale + ZOOM_STEP)}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-black/5 bg-white/75 text-gray-600 transition hover:bg-white disabled:opacity-40 dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                disabled={scale >= MAX_ZOOM}
                aria-label="Zoom in"
                title="Zoom in"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={resetZoom}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-black/5 bg-white/75 text-gray-600 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                aria-label="Reset zoom"
                title="Reset zoom"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div
            ref={viewportRef}
            className={`relative flex h-[min(68dvh,38rem)] min-h-[22rem] touch-none items-center justify-center overflow-hidden bg-zinc-950 sm:h-[min(70vh,42rem)] ${
              scale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'
            }`}
            onClick={handleViewerClick}
            onKeyDown={handleViewerKeyDown}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            role="button"
            tabIndex={0}
            aria-label="Select elevation point"
          >
            <div
              className="relative inline-block max-h-full max-w-full will-change-transform"
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                transformOrigin: 'center center',
              }}
            >
              {isImage ? (
                <img
                  ref={(node) => {
                    mediaRef.current = node;
                  }}
                  src={drawing.dataUrl}
                  alt={drawing.name || drawing.fileName}
                  draggable={false}
                  className="block max-h-[min(68dvh,38rem)] max-w-full select-none object-contain sm:max-h-[min(70vh,42rem)]"
                />
              ) : isPdf ? (
                <object
                  ref={(node) => {
                    mediaRef.current = node;
                  }}
                  data={drawing.dataUrl}
                  type={drawing.mimeType}
                  aria-label={drawing.name || drawing.fileName}
                  className="pointer-events-none block h-[min(68dvh,38rem)] w-[min(calc(100vw-2rem),64rem)] max-w-full bg-white sm:h-[min(70vh,42rem)]"
                />
              ) : (
                <div
                  ref={(node) => {
                    mediaRef.current = node;
                  }}
                  className="flex h-[22rem] w-[min(calc(100vw-2rem),42rem)] max-w-full items-center justify-center bg-white px-6 text-center text-sm text-gray-700"
                >
                  {drawing.fileName}
                </div>
              )}
              {markers.map((marker) => (
                <span
                  key={`${marker.checkpointId}-${marker.markerKey}`}
                  className="pointer-events-none absolute flex h-5 w-5 items-center justify-center rounded-full border border-white bg-[var(--accent)] text-[0.52rem] font-bold leading-none text-white shadow-md ring-1 ring-black/35"
                  style={{
                    left: `${marker.xPercent}%`,
                    top: `${marker.yPercent}%`,
                    transform: `translate(-50%, -50%) scale(${1 / scale})`,
                    transformOrigin: 'center center',
                  }}
                  title={`${marker.markerKey}: ${marker.sectionName} / ${marker.itemName} / ${marker.checkpointName}`}
                >
                  {marker.markerKey.replace(/^E/, '')}
                </span>
              ))}
              {picker && (
                <span
                  className="pointer-events-none absolute flex h-5 w-5 items-center justify-center rounded-full border border-white bg-[var(--accent)] text-white shadow-md ring-1 ring-black/35"
                  style={{
                    left: `${picker.xPercent}%`,
                    top: `${picker.yPercent}%`,
                    transform: `translate(-50%, -50%) scale(${1 / scale})`,
                    transformOrigin: 'center center',
                  }}
                >
                  <MapPin className="h-2.5 w-2.5" />
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {picker && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/45 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-4 sm:items-center sm:justify-center sm:p-4"
          role="presentation"
          onClick={() => {
            setPicker(null);
            setPickerMode('existing');
            setCustomItemName('');
            setCustomCheckpointName('');
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="elevation-picker-title"
            className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-[1.6rem] bg-white p-4 shadow-2xl dark:bg-zinc-900"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id="elevation-picker-title" className="text-base font-semibold text-gray-900 dark:text-white">
                Elevation Point
              </h2>
              <button
                type="button"
                onClick={() => {
                  setPicker(null);
                  setPickerMode('existing');
                  setCustomItemName('');
                  setCustomCheckpointName('');
                }}
                className="flex h-9 w-9 items-center justify-center rounded-full text-gray-500 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                aria-label="Close elevation picker"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 rounded-[1.1rem] bg-black/[0.04] p-1 dark:bg-white/[0.06]">
                <button
                  type="button"
                  onClick={() => setPickerMode('existing')}
                  className={`h-10 rounded-[0.85rem] text-sm font-semibold transition ${
                    pickerMode === 'existing'
                      ? 'bg-white text-gray-900 shadow-sm dark:bg-white/[0.12] dark:text-white'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  Existing
                </button>
                <button
                  type="button"
                  onClick={() => setPickerMode('custom')}
                  className={`h-10 rounded-[0.85rem] text-sm font-semibold transition ${
                    pickerMode === 'custom'
                      ? 'bg-white text-gray-900 shadow-sm dark:bg-white/[0.12] dark:text-white'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  Custom
                </button>
              </div>

              <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">
                Floor / Sub Area
                <select
                  value={picker.locationId}
                  onChange={(event) => handleLocationChange(event.target.value)}
                  className="field-shell mt-1.5 h-11 text-sm normal-case tracking-normal"
                >
                  {selectableLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {getLocationOptionLabel(location)}
                    </option>
                  ))}
                </select>
              </label>

              {pickerMode === 'existing' ? (
                <>
                  <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">
                    Item
                    <select
                      value={picker.itemId}
                      onChange={(event) => handleItemChange(event.target.value)}
                      className="field-shell mt-1.5 h-11 text-sm normal-case tracking-normal"
                    >
                      {selectedItems.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">
                    Sub Item
                    <select
                      value={picker.checkpointId}
                      onChange={(event) => handleCheckpointChange(event.target.value)}
                      className="field-shell mt-1.5 h-11 text-sm normal-case tracking-normal"
                    >
                      {selectedCheckpoints.map((checkpoint) => (
                        <option key={checkpoint.id} value={checkpoint.id}>
                          {checkpoint.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <>
                  <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">
                    Item
                    <input
                      value={customItemName}
                      onChange={(event) => setCustomItemName(event.target.value)}
                      className="field-shell mt-1.5 h-11 text-sm normal-case tracking-normal"
                    />
                  </label>

                  <label className="block text-xs font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400">
                    Sub Item
                    <input
                      value={customCheckpointName}
                      onChange={(event) => setCustomCheckpointName(event.target.value)}
                      className="field-shell mt-1.5 h-11 text-sm normal-case tracking-normal"
                    />
                  </label>
                </>
              )}
            </div>

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setPicker(null);
                  setPickerMode('existing');
                  setCustomItemName('');
                  setCustomCheckpointName('');
                }}
                className="flex h-11 flex-1 items-center justify-center rounded-full border border-black/5 bg-gray-100 text-sm font-semibold text-gray-700 transition hover:bg-gray-200 dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-200 dark:hover:bg-white/[0.1]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void openSelection();
                }}
                disabled={
                  isOpeningSelection ||
                  (pickerMode === 'custom' && (!customItemName.trim() || !customCheckpointName.trim()))
                }
                className="accent-tint accent-text hover:accent-tint-strong flex h-11 flex-1 items-center justify-center rounded-full text-sm font-semibold transition disabled:opacity-60"
              >
                Mark Issue
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
