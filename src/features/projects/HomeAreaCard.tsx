'use client';

import { memo, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import MetadataLine from '@/components/MetadataLine';
import type { Area, Project } from '@/types';

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_THRESHOLD = 12;

export type HomeAreaCardMetrics = {
  stats: { total: number; ok: number; issues: number; areas?: number };
  pending: number;
  progress: number;
  photoCount: number;
  commentCount: number;
};

export type HomeAreaClaimDisplay = {
  ownership: 'mine' | 'other';
  label: string;
  expiresAt?: Date;
};

type HomeAreaCardProps = {
  project: Project;
  area: Area;
  displayName: string;
  metric?: HomeAreaCardMetrics;
  claimStatus?: HomeAreaClaimDisplay;
  deleteMode: boolean;
  isSelected: boolean;
  onToggleSelection: (areaId: string) => void;
  onLongPressSelect: (areaId: string) => void;
  onBlockedByClaim: (message: string) => void;
  onPrimeOpen: (project: Project, areaId: string) => void;
  onOpenArea: (project: Project, areaId: string) => void;
};

export const HomeAreaCard = memo(function HomeAreaCard({
  project,
  area,
  displayName,
  metric,
  claimStatus,
  deleteMode,
  isSelected,
  onToggleSelection,
  onLongPressSelect,
  onBlockedByClaim,
  onPrimeOpen,
  onOpenArea,
}: HomeAreaCardProps) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const areaStats = metric?.stats ?? { total: 0, ok: 0, issues: 0 };
  const progress = metric?.progress ?? 0;
  const commentCount = metric?.commentCount ?? 0;
  const photoCount = metric?.photoCount ?? 0;
  const blockedByClaim = claimStatus?.ownership === 'other';
  const claimLabel = claimStatus
    ? claimStatus.ownership === 'mine'
      ? 'In use by you'
      : `In use by ${claimStatus.label}`
    : null;
  const blockedClaimMessage = claimStatus?.ownership === 'other'
    ? `${claimStatus.label} is working in this area. Try again when they leave.`
    : 'This shared area is currently in use.';

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, []);

  return (
    <div
      onPointerDown={(event) => {
        if (deleteMode || blockedByClaim) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        onPrimeOpen(project, area.id);
        clearLongPressTimer();
        longPressStartRef.current = { x: event.clientX, y: event.clientY };
        suppressClickRef.current = false;
        longPressTimerRef.current = setTimeout(() => {
          suppressClickRef.current = true;
          onLongPressSelect(area.id);
        }, LONG_PRESS_MS);
      }}
      onPointerMove={(event) => {
        const start = longPressStartRef.current;
        if (!start) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_MOVE_THRESHOLD) {
          clearLongPressTimer();
        }
      }}
      onPointerUp={clearLongPressTimer}
      onPointerCancel={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
      onMouseEnter={() => {
        if (!deleteMode && !blockedByClaim) onPrimeOpen(project, area.id);
      }}
      onContextMenu={(event) => {
        if (!deleteMode) {
          event.preventDefault();
          if (!blockedByClaim) onLongPressSelect(area.id);
        }
      }}
      onClickCapture={(event) => {
        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClickRef.current = false;
        }
      }}
      onClick={() => {
        if (deleteMode) onToggleSelection(area.id);
      }}
      className={`card-surface-subtle select-none touch-manipulation [-webkit-touch-callout:none] rounded-[1.6rem] p-4 transition-all sm:p-5 ${
        isSelected
          ? '!border-gray-400 !bg-gray-100 dark:!border-gray-500 dark:!bg-white/[0.08]'
          : 'hover:-translate-y-px hover:border-black/10 dark:hover:border-white/[0.08]'
      } ${deleteMode ? 'cursor-pointer' : ''}`}
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <div className="flex items-start gap-3">
        <Link
          href={deleteMode || blockedByClaim ? '#' : `/project/${project.id}/area/${area.id}`}
          onClick={(event) => {
            if (deleteMode || blockedByClaim) {
              event.preventDefault();
              if (blockedByClaim) onBlockedByClaim(blockedClaimMessage);
              return;
            }
            onOpenArea(project, area.id);
          }}
          onContextMenu={(event) => {
            if (!deleteMode) event.preventDefault();
          }}
          className="flex-1 min-w-0 [-webkit-touch-callout:none]"
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="truncate text-[1.03rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{displayName}</h3>
              {claimLabel && <span className="segmented-chip shrink-0 px-2.5 py-1 text-[11px]">{claimLabel}</span>}
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
          href={deleteMode || blockedByClaim ? '#' : `/project/${project.id}/area/${area.id}`}
          onClick={(event) => {
            if (deleteMode || blockedByClaim) {
              event.preventDefault();
              if (blockedByClaim) onBlockedByClaim(blockedClaimMessage);
              return;
            }
            onOpenArea(project, area.id);
          }}
          onContextMenu={(event) => {
            if (!deleteMode) event.preventDefault();
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (!deleteMode && !blockedByClaim) onPrimeOpen(project, area.id);
          }}
          onMouseEnter={() => {
            if (!deleteMode && !blockedByClaim) onPrimeOpen(project, area.id);
          }}
          className="mt-0.5 rounded-[1rem] border border-transparent p-1.5 text-gray-400 transition hover:border-black/5 hover:bg-white hover:text-gray-700 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-gray-200 [-webkit-touch-callout:none]"
          style={{ WebkitTapHighlightColor: 'transparent' }}
          aria-label={`Open ${displayName}`}
        >
          <ChevronRight className="w-5 h-5" />
        </Link>
      </div>
    </div>
  );
});
