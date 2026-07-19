'use client';

import { memo, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ChevronRight, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import MetadataLine from '@/components/MetadataLine';
import type { Project } from '@/types';

const LONG_PRESS_MS = 500;

export type ProjectCardMetrics = {
  stats: { total: number; ok: number; issues: number; areas: number };
  pending: number;
  progress: number;
  okPercent: number;
  issuePercent: number;
  photoCount: number;
  commentCount: number;
};

type ProjectCardProps = {
  project: Project;
  metric?: ProjectCardMetrics;
  selectionMode: boolean;
  isSelected: boolean;
  hasTeamUpdate?: boolean;
  menuOpen: boolean;
  onToggleSelection: (id: string) => void;
  onToggleMenu: (id: string) => void;
  onCloseMenu: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onLongPressSelect: (projectId: string) => void;
  onPrimeOpen: (project: Project) => void;
};

export const ProjectCard = memo(function ProjectCard({
  project,
  metric,
  selectionMode,
  isSelected,
  hasTeamUpdate = false,
  menuOpen,
  onToggleSelection,
  onToggleMenu,
  onCloseMenu,
  onEditProject,
  onDeleteProject,
  onLongPressSelect,
  onPrimeOpen,
}: ProjectCardProps) {
  const stats = metric?.stats ?? { total: 0, ok: 0, issues: 0, areas: project.areas.length };
  const photoCount = metric?.photoCount ?? 0;
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearLongPress() {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      if (longPressRef.current) clearTimeout(longPressRef.current);
    };
  }, []);

  return (
    <div
      onContextMenu={(event) => {
        if (!selectionMode) event.preventDefault();
      }}
      onClick={() => {
        if (selectionMode) onToggleSelection(project.id);
      }}
      onPointerDown={() => {
        if (!selectionMode) {
          onPrimeOpen(project);
          clearLongPress();
          longPressRef.current = setTimeout(() => {
            onLongPressSelect(project.id);
            longPressRef.current = null;
          }, LONG_PRESS_MS);
        }
      }}
      onMouseEnter={() => {
        if (!selectionMode) onPrimeOpen(project);
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      className={`main-card-surface card-surface select-none rounded-[1.7rem] p-4 transition-all sm:p-5 [-webkit-touch-callout:none] ${
        isSelected
          ? '!bg-gray-100 dark:!bg-white/[0.1]'
          : 'hover:-translate-y-px dark:hover:bg-white/[0.07]'
      } ${selectionMode ? 'cursor-pointer' : ''}`}
    >
      <div className="flex items-start gap-3">
        <Link
          href={selectionMode ? '#' : `/project/${project.id}`}
          onClick={(event) => {
            if (selectionMode) event.preventDefault();
          }}
          onContextMenu={(event) => {
            if (!selectionMode) event.preventDefault();
          }}
          className="flex-1 min-w-0 [-webkit-touch-callout:none]"
        >
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="truncate text-[1.05rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
                {project.projectName}
              </h3>
              {project.sharedProjectId && (
                <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300">
                  Team
                </span>
              )}
              {hasTeamUpdate && (
                <span className="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-sky-700 dark:text-sky-300">
                  Updates
                </span>
              )}
            </div>
            {project.address ? (
              <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-300">
                {project.address}
              </p>
            ) : null}
            <MetadataLine className="mt-3" issues={stats.issues} photos={photoCount} />
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={(event) => {
                event.stopPropagation();
                onToggleMenu(project.id);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className="soft-control rounded-[1rem] p-2 text-gray-400 transition hover:text-gray-700 dark:text-gray-300 dark:hover:text-white"
              aria-label={`Project actions for ${project.projectName}`}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={onCloseMenu} />
                <div className="menu-surface absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-[1.3rem] p-1.5" role="menu">
                  <button
                    onClick={() => {
                      onCloseMenu();
                      onEditProject(project);
                    }}
                    className="flex w-full items-center gap-2 rounded-[1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
                    role="menuitem"
                  >
                    <Pencil className="w-4 h-4" />
                    Edit Project
                  </button>
                  <button
                    onClick={() => {
                      onCloseMenu();
                      onDeleteProject(project);
                    }}
                    className="accent-text flex w-full items-center gap-2 rounded-[1rem] px-4 py-3 text-left text-sm transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                    role="menuitem"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
          <Link
            href={selectionMode ? '#' : `/project/${project.id}`}
            onClick={(event) => {
              event.stopPropagation();
              if (selectionMode) event.preventDefault();
            }}
            onContextMenu={(event) => {
              if (!selectionMode) event.preventDefault();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (!selectionMode) onPrimeOpen(project);
            }}
            onMouseEnter={() => {
              if (!selectionMode) onPrimeOpen(project);
            }}
            className="mt-0.5 rounded-[1rem] p-1.5 text-gray-400 transition hover:bg-black/[0.05] hover:text-gray-700 dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white [-webkit-touch-callout:none]"
            aria-label={`Open ${project.projectName}`}
          >
            <ChevronRight className="w-5 h-5" />
          </Link>
        </div>
      </div>
    </div>
  );
});
