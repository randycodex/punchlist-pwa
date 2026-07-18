'use client';

import { memo } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import CollaborationAvatar from '@/components/CollaborationAvatar';
import MetadataLine from '@/components/MetadataLine';
import type { Project } from '@/types';

export type AreaCardMetrics = {
  stats: { total: number; ok: number; issues: number };
  pending: number;
  progress: number;
  okPercent: number;
  issuePercent: number;
  photoCount: number;
  commentCount: number;
};

export type AreaCardClaimDisplay = {
  ownership: 'mine' | 'other';
  label: string;
  avatarUrl?: string;
  expiresAt?: Date;
};

type AreaCardProps = {
  projectId: string;
  area: Project['areas'][number];
  displayName: string;
  metric?: AreaCardMetrics;
  claimStatus?: AreaCardClaimDisplay;
  deleteMode: boolean;
  isSelected: boolean;
  onToggleSelection: (areaId: string) => void;
  onBlockedByClaim: () => void;
  onPrimeOpen: (areaId: string) => void;
  onOpenArea: (areaId: string) => void;
};

export const AreaCard = memo(function AreaCard({
  projectId,
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
}: AreaCardProps) {
  const areaStats = metric?.stats ?? { total: 0, ok: 0, issues: 0 };
  const progress = metric?.progress ?? 0;
  const commentCount = metric?.commentCount ?? 0;
  const photoCount = metric?.photoCount ?? 0;
  const blockedByClaim = claimStatus?.ownership === 'other';

  return (
    <div
      onPointerDown={(event) => {
        if (deleteMode || blockedByClaim) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        onPrimeOpen(area.id);
      }}
      onMouseEnter={() => {
        if (!deleteMode && !blockedByClaim) onPrimeOpen(area.id);
      }}
      onContextMenu={(event) => {
        if (!deleteMode) {
          event.preventDefault();
        }
      }}
      onClick={() => {
        if (deleteMode) onToggleSelection(area.id);
      }}
      className={`main-card-surface card-surface block rounded-[1.65rem] p-4 transition-all sm:p-5 ${
        isSelected
          ? 'bg-gray-100 border-gray-400 dark:bg-white/[0.08] dark:border-gray-500'
          : 'hover:-translate-y-px hover:border-black/10 dark:hover:bg-white/[0.07] dark:hover:border-white/[0.08]'
      } ${deleteMode ? 'cursor-pointer' : ''}`}
    >
      <div className="flex items-start gap-3">
        <Link
          href={deleteMode || blockedByClaim ? '#' : `/project/${projectId}/area/${area.id}`}
          onClick={(event) => {
            if (deleteMode || blockedByClaim) {
              event.preventDefault();
              if (blockedByClaim) onBlockedByClaim();
              return;
            }
            onOpenArea(area.id);
          }}
          onContextMenu={(event) => {
            if (!deleteMode) event.preventDefault();
          }}
          className="flex-1 min-w-0"
        >
          <div className="min-w-0">
            <div className="min-w-0 flex items-center gap-2">
              <h3 className="truncate text-[1.05rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{displayName}</h3>
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
            href={deleteMode || blockedByClaim ? '#' : `/project/${projectId}/area/${area.id}`}
            onClick={(event) => {
              if (deleteMode || blockedByClaim) {
                event.preventDefault();
                if (blockedByClaim) onBlockedByClaim();
                return;
              }
              onOpenArea(area.id);
            }}
            onContextMenu={(event) => {
              if (!deleteMode) event.preventDefault();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (!deleteMode && !blockedByClaim) onPrimeOpen(area.id);
            }}
            onMouseEnter={() => {
              if (!deleteMode && !blockedByClaim) onPrimeOpen(area.id);
            }}
            className="mt-1 flex h-10 w-10 items-center justify-center rounded-[1rem] border border-black/5 bg-white/70 text-gray-500 transition hover:bg-white hover:text-gray-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.12] dark:hover:text-white"
            aria-label={`Open ${displayName}`}
          >
            <ChevronRight className="w-5 h-5 text-gray-400" />
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
