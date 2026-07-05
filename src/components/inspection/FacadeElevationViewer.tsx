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
};

type TouchPoint = {
  clientX: number;
  clientY: number;
};

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

function getFirstAvailableSelection(locations: Area['locations']): ChecklistSelection | null {
  for (const location of locations) {
    for (const item of location.items) {
      const checkpoint = item.checkpoints[0];
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
  const [isOpeningSelection, setIsOpeningSelection] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLImageElement | HTMLObjectElement | HTMLDivElement | null>(null);
  const dragRef = useRef<DragGesture | null>(null);
  const pinchRef = useRef<PinchGesture | null>(null);
  const suppressNextClickRef = useRef(false);

  const selectableLocations = useMemo(
    () => locations.filter((location) => location.items.some((item) => item.checkpoints.length > 0)),
    [locations]
  );
  const firstSelection = useMemo(
    () => getFirstAvailableSelection(selectableLocations),
    [selectableLocations]
  );
  const selectedLocation = picker
    ? selectableLocations.find((location) => location.id === picker.locationId) ?? null
    : null;
  const selectedItems = selectedLocation?.items.filter((item) => item.checkpoints.length > 0) ?? [];
  const selectedItem = picker
    ? selectedItems.find((item) => item.id === picker.itemId) ?? null
    : null;
  const selectedCheckpoints = selectedItem?.checkpoints ?? [];
  const isImage = drawing.mimeType.startsWith('image/');
  const isPdf = drawing.mimeType === 'application/pdf';

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleNativeWheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      setScale((currentScale) => {
        const nextScale = clampZoom(currentScale - event.deltaY * 0.004);
        if (nextScale <= MIN_ZOOM) {
          setOffset({ x: 0, y: 0 });
        }
        return nextScale;
      });
    };

    viewport.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', handleNativeWheel);
    };
  }, []);

  function updateZoom(nextScale: number) {
    const clampedScale = clampZoom(nextScale);
    setScale(clampedScale);
    if (clampedScale <= MIN_ZOOM) {
      setOffset({ x: 0, y: 0 });
    }
  }

  function resetZoom() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  function toggleCollapsed() {
    setIsCollapsed((current) => !current);
    setPicker(null);
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
    if (!firstSelection) return;
    const tapPoint = getTapPoint(clientX, clientY);
    if (!tapPoint) return;

    setPicker({
      ...tapPoint,
      ...firstSelection,
    });
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
    pinchRef.current = {
      distance: getTouchDistance(event.touches[0], event.touches[1]),
      scale,
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
    const item = location?.items.find((entry) => entry.checkpoints.length > 0);
    const checkpoint = item?.checkpoints[0];
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
    const checkpoint = item?.checkpoints[0];
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
    setIsOpeningSelection(true);
    try {
      await onOpenSelection({
        locationId: picker.locationId,
        itemId: picker.itemId,
        checkpointId: picker.checkpointId,
        xPercent: picker.xPercent,
        yPercent: picker.yPercent,
      });
      setPicker(null);
    } finally {
      setIsOpeningSelection(false);
    }
  }

  return (
    <section className="card-surface-subtle overflow-hidden rounded-[1.6rem]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="section-eyebrow">Elevation Drawing</div>
          <div className="truncate text-sm font-semibold text-gray-900 dark:text-white">
            {drawing.name || drawing.fileName}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-black/5 bg-white/75 text-gray-600 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
            aria-label={isCollapsed ? 'Expand elevation drawing' : 'Collapse elevation drawing'}
            title={isCollapsed ? 'Expand elevation drawing' : 'Collapse elevation drawing'}
          >
            {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {!isCollapsed && (
            <>
              <button
                type="button"
                onClick={() => updateZoom(scale - ZOOM_STEP)}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-black/5 bg-white/75 text-gray-600 transition hover:bg-white disabled:opacity-40 dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                disabled={scale <= MIN_ZOOM}
                aria-label="Zoom out"
                title="Zoom out"
              >
                <Minus className="h-4 w-4" />
              </button>
              <div className="min-w-14 text-center text-xs font-semibold text-gray-500 dark:text-gray-400">
                {Math.round(scale * 100)}%
              </div>
              <button
                type="button"
                onClick={() => updateZoom(scale + ZOOM_STEP)}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-black/5 bg-white/75 text-gray-600 transition hover:bg-white disabled:opacity-40 dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                disabled={scale >= MAX_ZOOM}
                aria-label="Zoom in"
                title="Zoom in"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={resetZoom}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-black/5 bg-white/75 text-gray-600 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                aria-label="Reset zoom"
                title="Reset zoom"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {!isCollapsed && (
        <div
          ref={viewportRef}
          className={`relative flex h-[min(62vh,34rem)] min-h-[19rem] touch-none items-center justify-center overflow-hidden bg-zinc-950 ${
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
                className="block max-h-[min(62vh,34rem)] max-w-full select-none object-contain"
              />
            ) : isPdf ? (
              <object
                ref={(node) => {
                  mediaRef.current = node;
                }}
                data={drawing.dataUrl}
                type={drawing.mimeType}
                aria-label={drawing.name || drawing.fileName}
                className="pointer-events-none block h-[min(62vh,34rem)] w-[min(calc(100vw-2rem),60rem)] max-w-full bg-white"
              />
            ) : (
              <div
                ref={(node) => {
                  mediaRef.current = node;
                }}
                className="flex h-[19rem] w-[min(calc(100vw-2rem),42rem)] max-w-full items-center justify-center bg-white px-6 text-center text-sm text-gray-700"
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
      )}

      {picker && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/45 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-4 sm:items-center sm:justify-center sm:p-4"
          role="presentation"
          onClick={() => setPicker(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="elevation-picker-title"
            className="w-full max-w-md rounded-[1.6rem] bg-white p-4 shadow-2xl dark:bg-zinc-900"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 id="elevation-picker-title" className="text-base font-semibold text-gray-900 dark:text-white">
                Elevation Point
              </h2>
              <button
                type="button"
                onClick={() => setPicker(null)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-gray-500 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                aria-label="Close elevation picker"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
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
            </div>

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setPicker(null);
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
                disabled={isOpeningSelection}
                className="accent-tint accent-text hover:accent-tint-strong flex h-11 flex-1 items-center justify-center rounded-full text-sm font-semibold transition disabled:opacity-60"
              >
                Open Item
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
