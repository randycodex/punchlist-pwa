'use client';

import { memo } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import CollaborationAvatar from '@/components/CollaborationAvatar';
import MetadataLine from '@/components/MetadataLine';
import type { Area, Project } from '@/types';

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
  avatarUrl?: string;
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
  onBlockedByClaim,
  onPrimeOpen,
  onOpenArea,
}: HomeAreaCardProps) {
  const areaStats = metric?.stats ?? { total: 0, ok: 0, issues: 0 };
  const progress = metric?.progress ?? 0;
  const commentCount = metric?.commentCount ?? 0;
  const photoCount = metric?.photoCount ?? 0;
  const blockedByClaim = claimStatus?.ownership === 'other';
  const blockedClaimMessage = claimStatus?.ownership === 'other'
    ? `${claimStatus.label} is working in this area. Try again after they release it.`
    : 'This shared area is locked until its current user releases it.';

  return (
    <div
      onPointerDown={(event) => {
        if (deleteMode || blockedByClaim) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        onPrimeOpen(project, area.id);
      }}
      onMouseEnter={() => {
        if (!deleteMode && !blockedByClaim) onPrimeOpen(project, area.id);
      }}
      onContextMenu={(event) => {
        if (!deleteMode) {
          event.preventDefault();
        }
      }}
      onClick={() => {
        if (deleteMode) onToggleSelection(area.id);
      }}
      className={`main-card-surface card-surface-subtle select-none touch-manipulation [-webkit-touch-callout:none] rounded-[1.6rem] p-4 transition-all sm:p-5 ${
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
        <div className="flex shrink-0 self-stretch flex-col items-center">
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
          {claimStatus && (
            <CollaborationAvatar
              name={claimStatus.label}
              src={claimStatus.avatarUrl}
              size="sm"
              className="mt-auto"
            />
          )}
        </div>
      </div>
    </div>
  );
});
