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
  const photoCount = metric?.photoCount ?? 0;
  const blockedByClaim = claimStatus?.ownership === 'other';
  const blockedClaimMessage = claimStatus?.ownership === 'other'
    ? `${claimStatus.label} is working in this area. Try another area, or wait until they release it.`
    : 'This area is locked until the current person releases it.';
  // Main stays minimal: only surface locks that block this user.
  const showOtherClaim = claimStatus?.ownership === 'other';

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
      className={`main-card-surface area-card-surface card-surface-subtle select-none touch-manipulation [-webkit-touch-callout:none] rounded-[1.6rem] p-4 transition-all sm:p-5 ${
        isSelected
          ? '!bg-gray-100 dark:!bg-white/[0.1]'
          : blockedByClaim
            ? 'opacity-80'
            : 'hover:-translate-y-px dark:hover:bg-white/[0.06]'
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
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3
                className={`truncate text-[1.03rem] font-semibold tracking-[-0.02em] ${
                  claimStatus?.ownership === 'mine' ? 'accent-text' : 'text-gray-900 dark:text-white'
                }`}
              >
                {displayName}
              </h3>
              {showOtherClaim && (
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                  <CollaborationAvatar
                    name={claimStatus.label}
                    src={claimStatus.avatarUrl}
                    size="xs"
                  />
                  <span className="truncate">{claimStatus.label}</span>
                </span>
              )}
            </div>
            <MetadataLine className="mt-2" issues={areaStats.issues} photos={photoCount} issuesOnly={false} />
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
            className="mt-0.5 rounded-[1rem] p-1.5 text-gray-400 transition hover:bg-black/[0.05] hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200 [-webkit-touch-callout:none]"
            style={{ WebkitTapHighlightColor: 'transparent' }}
            aria-label={`Open ${displayName}`}
          >
            <ChevronRight className="w-5 h-5" />
          </Link>
        </div>
      </div>
    </div>
  );
});
