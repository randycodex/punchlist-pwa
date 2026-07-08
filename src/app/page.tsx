'use client';

import { memo, useState, useEffect, useMemo, useRef, useCallback, type TouchEvent } from 'react';
import { Area, Project, checkpointHasIssue, getReviewMetrics } from '@/types';
import {
  getAllProjects,
  getProject,
  saveProject,
  saveProjectMetadataOnly,
  saveProjectPreserveTimestamps,
  deleteProject,
  createProject,
  createArea,
} from '@/lib/db';
import {
  SyncConflict,
  markProjectDeleted,
  unmarkProjectDeleted,
  hydrateProjectMediaFromOneDrive,
} from '@/lib/oneDriveSync';
import {
  formatSyncConflictReviewMessage,
  syncProjectsWithOneDriveRecovery,
} from '@/lib/oneDriveSyncRecovery';
import {
  clearPendingSyncState,
  hasPendingSyncState,
  loadPendingSyncState,
  pausePendingSyncAutoRetry,
  queuePendingSync,
  resumePendingSyncAutoRetry,
} from '@/lib/pendingSync';
import type { PdfExportMode } from '@/lib/pdfExport';
import { uploadPdfToOneDrive, getNextOneDriveExportFilename } from '@/lib/oneDrive';
import { queueBackgroundProjectMediaHydration, resetBackgroundMediaHydration } from '@/lib/backgroundMediaHydration';
import {
  queueBackgroundSharedProjectPublish,
  queueStaleBackgroundSharedProjectPublishes,
  resetBackgroundSharedProjectPublish,
} from '@/lib/backgroundSharedPublish';
import {
  formatMicrosoftManualRetryMessage,
  getMicrosoftErrorMessage,
  getMicrosoftRetryDelayMs,
} from '@/lib/microsoftErrors';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { useAppSettings } from '@/contexts/AppSettingsContext';
import {
  createSharedProjectFromLocalProject,
  captureSharedProjectBackup,
  claimSharedProjectArea,
  disconnectSharedProject,
  generateSharedProjectJoinCode,
  getActiveSharedProjectAreaClaimSummaries,
  getSharedProjectMembers,
  getSharedProjectBackupSnapshot,
  getSharedProjectPublishConflict,
  getSharedProjectSnapshot,
  getSharedProjectSnapshotMetadata,
  hasNewerLocalChangesThanSharedSnapshot,
  getCollaborationErrorMessage,
  isSharedProjectPublishConflictError,
  isSharedSnapshotNewer,
  joinSharedProjectByCode,
  listMySharedProjects,
  listSharedProjectBackups,
  publishSharedProjectSnapshot,
  runCollaborationHealthCheck,
  subscribeToSharedProjectAreaClaimChanges,
  subscribeToSharedProjectSnapshotChanges,
  transferSharedProjectOwnership,
} from '@/lib/collaboration';
import type { CollaborationHealthReport, CollaborationProjectMember, CollaborationSharedProjectDirectoryEntry, CollaborationSnapshotBackup } from '@/lib/collaboration';
import ProjectEditModal from '@/components/ProjectEditModal';
import AreaEditorModal from '@/components/AreaEditorModal';
import MetadataLine from '@/components/MetadataLine';
import AppMessageDialog from '@/components/AppMessageDialog';
import AppConfirmDialog from '@/components/AppConfirmDialog';
import AppPromptDialog from '@/components/AppPromptDialog';
import CollaborationHealthDialog from '@/components/CollaborationHealthDialog';
import { applyTemplateToArea } from '@/lib/template';
import {
  cacheProjectPreview,
  getCachedProjectPreviews,
  removeCachedProjectPreview,
  replaceProjectPreviewCache,
} from '@/lib/projectNavigationCache';
import {
  buildAreaName,
  buildFacadeLevelOptions,
  compareAreaNames,
  getAreaDisplayNameMap,
  getAreaCreationForms,
  getDefaultAreaFormValue,
  upsertFacadeElevationDrawing,
  type AreaTypeKey,
} from '@/lib/areas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronRight,
  Trash2,
  FileDown,
  Loader2,
  MoreVertical,
  Pencil,
  RotateCcw,
  Plus,
} from 'lucide-react';

type SortOption = 'alphabetical' | 'issues' | 'progress';
type ExportDestination = 'local' | 'onedrive';
type ExportScope = 'selected-projects' | 'selected-areas';

const SORT_STORAGE_KEY = 'punchlist-projects-sort';
const RECENT_AREA_TYPES_STORAGE_KEY = 'punchlist-recent-area-types';
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LONG_PRESS_MS = 500;
const AREA_CARD_LONG_PRESS_MOVE_THRESHOLD = 12;
const SHARED_AREA_CLAIM_REFRESH_MS = 15 * 1000;

function sanitizeOneDriveProjectFolderPart(value: string | undefined, fallback: string) {
  const cleaned = (value ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

function getOneDriveProjectFolderName(project: Pick<Project, 'projectName' | 'oneDriveFolderName'>) {
  return sanitizeOneDriveProjectFolderPart(
    project.oneDriveFolderName,
    sanitizeOneDriveProjectFolderPart(project.projectName, 'project')
  );
}

function sanitizeExportNamePart(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/gi, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'Project';
}

function formatDateForExport(now = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd}`;
}

function formatSharedBackupReason(reason: CollaborationSnapshotBackup['reason']) {
  if (reason === 'publish') return 'Published version';
  if (reason === 'before_publish') return 'Before publish';
  if (reason === 'before_pull') return 'Before pull';
  if (reason === 'restore') return 'Before restore';
  return 'Manual backup';
}

function formatMemberStatus(status: CollaborationProjectMember['accessState']) {
  if (status === 'active') return 'Active';
  if (status === 'invited') return 'Invited';
  return 'Removed';
}

function formatMemberJoinMethod(method: CollaborationProjectMember['joinedBy']) {
  return method === 'joinCode' ? 'Joined by code' : 'Email invite';
}

type ProjectMetrics = {
  stats: { total: number; ok: number; issues: number; areas: number };
  pending: number;
  progress: number;
  okPercent: number;
  issuePercent: number;
  photoCount: number;
  commentCount: number;
};

type MessageDialogState = {
  title: string;
  message: string;
};

type PendingPullState = {
  localProject: Project;
  sharedProject: Project;
  publishedAt: string;
  hasNewerLocalChanges: boolean;
  reason: 'manual-pull' | 'publish-conflict' | 'area-create-conflict';
};

async function getPendingSharedPullState(
  localProject: Project,
  reason: PendingPullState['reason']
): Promise<PendingPullState> {
  const result = await getSharedProjectSnapshot(localProject);
  return {
    localProject,
    sharedProject: result.project,
    publishedAt: result.publishedAt,
    hasNewerLocalChanges: hasNewerLocalChangesThanSharedSnapshot(localProject, result.publishedAt),
    reason,
  };
}

type BackupRestoreConfirmState = {
  backup: CollaborationSnapshotBackup;
  publishAfterRestore: boolean;
};

function unlinkLocalSharedProject(project: Project): Project {
  const nextProject: Project = { ...project, areas: [...project.areas] };
  delete nextProject.sharedProjectId;
  delete nextProject.sharedProjectLinkedAt;
  delete nextProject.sharedSnapshotPublishedAt;
  return nextProject;
}

type AreaMetrics = {
  stats: { total: number; ok: number; issues: number; areas?: number };
  pending: number;
  progress: number;
  photoCount: number;
  commentCount: number;
};

type AreaClaimDisplay = {
  ownership: 'mine' | 'other';
  label: string;
  expiresAt?: Date;
};

type TrashedAreaEntry = {
  project: Project;
  area: Area;
  deletedAt: Date;
};

type ProjectCardProps = {
  project: Project;
  metric?: ProjectMetrics;
  selectionMode: boolean;
  isSelected: boolean;
  menuOpen: boolean;
  onToggleSelection: (id: string) => void;
  onToggleMenu: (id: string) => void;
  onCloseMenu: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onLongPressSelect: (projectId: string) => void;
  onPrimeOpen: (project: Project) => void;
};

const ProjectCard = memo(function ProjectCard({
  project,
  metric,
  selectionMode,
  isSelected,
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
  const progress = metric?.progress ?? 0;
  const commentCount = metric?.commentCount ?? 0;
  const photoCount = metric?.photoCount ?? 0;
  const hasContent = stats.total > 0 || stats.areas > 0;

  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearLongPress() {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }

  return (
    <div
      onContextMenu={(event) => {
        if (!selectionMode) {
          event.preventDefault();
        }
      }}
      onClick={() => {
        if (selectionMode) {
          onToggleSelection(project.id);
        }
      }}
      onPointerDown={() => {
        if (!selectionMode) {
          onPrimeOpen(project);
          longPressRef.current = setTimeout(() => {
            onLongPressSelect(project.id);
            longPressRef.current = null;
          }, LONG_PRESS_MS);
        }
      }}
      onMouseEnter={() => {
        if (!selectionMode) {
          onPrimeOpen(project);
        }
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      className={`card-surface select-none rounded-[1.7rem] p-4 transition-all sm:p-5 [-webkit-touch-callout:none] ${
        isSelected
          ? '!border-gray-400 !bg-gray-100 dark:!border-gray-500 dark:!bg-white/[0.08]'
          : 'hover:-translate-y-px hover:border-black/10 dark:hover:border-white/[0.08] dark:hover:bg-white/[0.07]'
      } ${selectionMode ? 'cursor-pointer' : ''}`}
    >
      <div className="flex items-start gap-3">
        <Link
          href={selectionMode ? '#' : `/project/${project.id}`}
          onClick={(event) => {
            if (selectionMode) event.preventDefault();
          }}
          onContextMenu={(event) => {
            if (!selectionMode) {
              event.preventDefault();
            }
          }}
          className="flex-1 min-w-0 [-webkit-touch-callout:none]"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="truncate text-[1.05rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{project.projectName}</h3>
            </div>
            <p className={`mt-1 truncate text-sm ${project.address ? 'text-gray-500 dark:text-gray-300' : 'text-gray-400 dark:text-gray-400'}`}>
              {project.address || 'No address added'}
            </p>
            <MetadataLine className="mt-3" issues={stats.issues} notes={commentCount} photos={photoCount} />
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-white/[0.12]">
              <div
                className={`h-full rounded-full transition-all ${
                  stats.issues > 0 ? 'accent-bg' : 'bg-gray-900 dark:bg-white'
                } ${!hasContent ? 'opacity-40' : ''}`}
                style={{ width: `${hasContent ? Math.max(progress, 4) : 4}%` }}
              />
            </div>
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
              className="rounded-[1rem] border border-black/5 bg-white/60 p-2 text-gray-400 transition hover:bg-white hover:text-gray-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
              aria-label={`Project actions for ${project.projectName}`}
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={onCloseMenu} />
                <div className="menu-surface absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-[1.3rem] p-1.5">
                  <button
                    onClick={() => {
                      onCloseMenu();
                      onEditProject(project);
                    }}
                    className="flex w-full items-center gap-2 rounded-[1rem] px-4 py-3 text-left text-sm text-gray-700 transition hover:bg-black/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.05]"
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
              if (!selectionMode) {
                event.preventDefault();
              }
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (!selectionMode) {
                onPrimeOpen(project);
              }
            }}
            onMouseEnter={() => {
              if (!selectionMode) {
                onPrimeOpen(project);
              }
            }}
            className="mt-0.5 rounded-[1rem] border border-transparent p-1.5 text-gray-400 transition hover:border-black/5 hover:bg-white hover:text-gray-700 dark:text-gray-300 dark:hover:border-white/10 dark:hover:bg-white/[0.08] dark:hover:text-white [-webkit-touch-callout:none]"
            aria-label={`Open ${project.projectName}`}
          >
            <ChevronRight className="w-5 h-5" />
          </Link>
        </div>
      </div>
    </div>
  );
});

type HomeAreaCardProps = {
  project: Project;
  area: Project['areas'][number];
  displayName: string;
  metric?: AreaMetrics;
  claimStatus?: AreaClaimDisplay;
  deleteMode: boolean;
  isSelected: boolean;
  onToggleSelection: (areaId: string) => void;
  onLongPressSelect: (areaId: string) => void;
  onBlockedByClaim: (message: string) => void;
  onPrimeOpen: (project: Project, areaId: string) => void;
  onOpenArea: (project: Project, areaId: string) => void;
};

const HomeAreaCard = memo(function HomeAreaCard({
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
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
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
        const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (moved > AREA_CARD_LONG_PRESS_MOVE_THRESHOLD) {
          clearLongPressTimer();
        }
      }}
      onPointerUp={clearLongPressTimer}
      onPointerCancel={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
      onMouseEnter={() => {
        if (!deleteMode && !blockedByClaim) {
          onPrimeOpen(project, area.id);
        }
      }}
      onContextMenu={(event) => {
        if (!deleteMode) {
          event.preventDefault();
          if (!blockedByClaim) {
            onLongPressSelect(area.id);
          }
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
        if (deleteMode) {
          onToggleSelection(area.id);
        }
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
              if (blockedByClaim) {
                onBlockedByClaim(blockedClaimMessage);
              }
              return;
            }
            onOpenArea(project, area.id);
          }}
          onContextMenu={(event) => {
            if (!deleteMode) {
              event.preventDefault();
            }
          }}
          className="flex-1 min-w-0 [-webkit-touch-callout:none]"
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="truncate text-[1.03rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">{displayName}</h3>
              {claimLabel && (
                <span className="segmented-chip shrink-0 px-2.5 py-1 text-[11px]">
                  {claimLabel}
                </span>
              )}
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
              if (blockedByClaim) {
                onBlockedByClaim(blockedClaimMessage);
              }
              return;
            }
            onOpenArea(project, area.id);
          }}
          onContextMenu={(event) => {
            if (!deleteMode) {
              event.preventDefault();
            }
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (!deleteMode && !blockedByClaim) {
              onPrimeOpen(project, area.id);
            }
          }}
          onMouseEnter={() => {
            if (!deleteMode && !blockedByClaim) {
              onPrimeOpen(project, area.id);
            }
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

export default function ProjectsPage() {
  const router = useRouter();
  const cachedProjects = getCachedProjectPreviews();
  const [projects, setProjects] = useState<Project[]>(() => cachedProjects);
  const [loading, setLoading] = useState(() => cachedProjects.length === 0);
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectAddress, setNewProjectAddress] = useState('');
  const [newProjectInspector, setNewProjectInspector] = useState('');
  const [newProjectGcName, setNewProjectGcName] = useState('');
  const [newProjectLevelStart, setNewProjectLevelStart] = useState('');
  const [newProjectLevelEnd, setNewProjectLevelEnd] = useState('');
  const [joinProjectCode, setJoinProjectCode] = useState('');
  const [showJoinProject, setShowJoinProject] = useState(false);
  const [joiningProject, setJoiningProject] = useState(false);
  const [sharedProjectCode, setSharedProjectCode] = useState<{
    projectName: string;
    code: string;
    expiresAt: string;
  } | null>(null);
  const [creatingJoinCode, setCreatingJoinCode] = useState(false);
  const [loadingSharedMembers, setLoadingSharedMembers] = useState(false);
  const [sharedMembersProject, setSharedMembersProject] = useState<Project | null>(null);
  const [sharedMembers, setSharedMembers] = useState<CollaborationProjectMember[]>([]);
  const [publishingSharedProject, setPublishingSharedProject] = useState(false);
  const [pullingSharedProject, setPullingSharedProject] = useState(false);
  const [pendingPull, setPendingPull] = useState<PendingPullState | null>(null);
  const [disconnectSharedProjectConfirm, setDisconnectSharedProjectConfirm] = useState<Project | null>(null);
  const [disconnectingSharedProject, setDisconnectingSharedProject] = useState(false);
  const [transferringSharedProject, setTransferringSharedProject] = useState(false);
  const [showMySharedProjects, setShowMySharedProjects] = useState(false);
  const [loadingMySharedProjects, setLoadingMySharedProjects] = useState(false);
  const [mySharedProjects, setMySharedProjects] = useState<CollaborationSharedProjectDirectoryEntry[]>([]);
  const [addingSharedProjectId, setAddingSharedProjectId] = useState<string | null>(null);
  const [backupProject, setBackupProject] = useState<Project | null>(null);
  const [loadingSharedBackups, setLoadingSharedBackups] = useState(false);
  const [sharedBackups, setSharedBackups] = useState<CollaborationSnapshotBackup[]>([]);
  const [restoringBackupId, setRestoringBackupId] = useState<string | null>(null);
  const [backupRestoreConfirm, setBackupRestoreConfirm] = useState<BackupRestoreConfirmState | null>(null);
  const [ownershipTransferProject, setOwnershipTransferProject] = useState<Project | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<Project | null>(null);
  const [showCollaborationHealth, setShowCollaborationHealth] = useState(false);
  const [collaborationHealthReport, setCollaborationHealthReport] = useState<CollaborationHealthReport | null>(null);
  const [runningCollaborationHealth, setRunningCollaborationHealth] = useState(false);
  const [sortOption, setSortOption] = useState<SortOption>('issues');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);
  const [deleteMode, setDeleteMode] = useState(false);
  const [exportMode, setExportMode] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [exportingSelected, setExportingSelected] = useState(false);
  const [exportingSelectedToDrive, setExportingSelectedToDrive] = useState(false);
  const [exportingSelectedAreas, setExportingSelectedAreas] = useState(false);
  const [actionSheet, setActionSheet] = useState<'delete' | 'export' | 'export-scope' | null>(null);
  const [exportScope, setExportScope] = useState<ExportScope>('selected-projects');
  const [exportType] = useState<PdfExportMode>('issues');
  const [showProjectMenuId, setShowProjectMenuId] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showAddArea, setShowAddArea] = useState(false);
  const [showAreaProjectPicker, setShowAreaProjectPicker] = useState(false);
  const [areaTargetProjectId, setAreaTargetProjectId] = useState<string | null>(null);
  const [selectedAreaIds, setSelectedAreaIds] = useState<Set<string>>(new Set());
  const [newAreaForm, setNewAreaForm] = useState(getDefaultAreaFormValue());
  const [recentAreaTypeKeys, setRecentAreaTypeKeys] = useState<AreaTypeKey[]>([]);
  const [sharedAreaClaims, setSharedAreaClaims] = useState<Map<string, AreaClaimDisplay>>(new Map());
  const [messageDialog, setMessageDialog] = useState<MessageDialogState | null>(null);
  const backgroundAreaClaimKeysRef = useRef(new Set<string>());
  const liveSharedDashboardRefreshKeysRef = useRef(new Set<string>());
  const projectsRef = useRef<Project[]>(cachedProjects);
  const pullStartYRef = useRef<number | null>(null);
  const pullArmedRef = useRef(false);
  const listRef = useRef<HTMLElement | null>(null);
  const homeMenuActionHandlerRef = useRef<((event: Event) => void) | null>(null);
  const loadProjectsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const scheduleSyncRef = useRef<(projectId?: string, options?: { fullSync?: boolean }) => void>(() => {});
  const { signIn, signOut, isReady, isSignedIn, ensureAccessToken, accountEmail, accountName } = useMicrosoftAuth();
  const ensureAccessTokenRef = useRef(ensureAccessToken);
  const collaborationAuth = useCollaborationAuth();
  const { setRetryAt, setStatus: setSyncStatus } = useSyncStatus();
  const { quickSort, setQuickSort, markSyncedNow } = useAppSettings();
  const selectionMode = deleteMode || exportMode;
  loadProjectsRef.current = loadProjects;
  ensureAccessTokenRef.current = ensureAccessToken;

  const showMessage = useCallback((message: string, title = 'Punchlist') => {
    setMessageDialog({ title, message });
  }, []);

  const pauseAutoSyncRetry = useCallback(() => {
    pausePendingSyncAutoRetry();
    setRetryAt(null);
    setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
  }, [setRetryAt, setSyncStatus]);
  scheduleSyncRef.current = scheduleSync;

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    const savedSort = localStorage.getItem(SORT_STORAGE_KEY);
    if (savedSort === 'alphabetical' || savedSort === 'issues' || savedSort === 'progress') {
      setSortOption(savedSort);
    } else if (savedSort === 'name') {
      setSortOption('alphabetical');
    } else if (savedSort === 'recent') {
      setSortOption('issues');
    } else {
      setSortOption(quickSort);
    }
  }, [quickSort]);

  useEffect(() => {
    const savedRecentAreaTypes = localStorage.getItem(RECENT_AREA_TYPES_STORAGE_KEY);
    if (savedRecentAreaTypes) {
      try {
        setRecentAreaTypeKeys(JSON.parse(savedRecentAreaTypes) as AreaTypeKey[]);
      } catch (error) {
        console.error('Failed to parse recent area types:', error);
      }
    }
    void loadProjectsRef.current();
  }, []);

  useEffect(() => {
    if (!collaborationAuth.isSignedIn) {
      resetBackgroundSharedProjectPublish();
      return;
    }
    if (loading) return;
    void loadProjectsRef.current();
  }, [collaborationAuth.isSignedIn, loading]);

  useEffect(() => {
    if (!isReady || loading) return;
    if (!isSignedIn) {
      resetBackgroundMediaHydration();
      setRetryAt(null);
      setSyncStatus('idle');
      return;
    }

    setRetryAt(null);
    setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
  }, [isReady, isSignedIn, loading, setRetryAt, setSyncStatus]);

  useEffect(() => {
    if (!isReady || loading || !isSignedIn || projects.length === 0) return;
    const accountKey = accountEmail ?? accountName ?? 'signed-in';
    queueBackgroundProjectMediaHydration({
      accountKey,
      projects,
      getAccessToken: () => ensureAccessTokenRef.current({ interactive: false }),
      onProjectHydrated: cacheProjectPreview,
    });
  }, [accountEmail, accountName, isReady, isSignedIn, loading, projects]);

  function handleSortChange(option: SortOption) {
    setSortOption(option);
    localStorage.setItem(SORT_STORAGE_KEY, option);
  }

  const primeProjectOpen = useCallback(
    (project: Project) => {
      cacheProjectPreview(project);
      router.prefetch(`/project/${project.id}`);
    },
    [router]
  );

  const primeAreaOpen = useCallback(
    (project: Project, areaId: string) => {
      cacheProjectPreview(project);
      router.prefetch(`/project/${project.id}/area/${areaId}`);
    },
    [router]
  );

  const markAreaClaimedByCurrentUser = useCallback((areaId: string, expiresAt?: Date) => {
    setSharedAreaClaims((current) => {
      const existing = current.get(areaId);
      if (
        existing?.ownership === 'mine' &&
        existing.expiresAt?.getTime() === expiresAt?.getTime()
      ) {
        return current;
      }

      const next = new Map(current);
      next.set(areaId, {
        ownership: 'mine',
        label: 'you',
        expiresAt,
      });
      return next;
    });
  }, []);

  const clearOptimisticAreaClaim = useCallback((areaId: string) => {
    setSharedAreaClaims((current) => {
      const existing = current.get(areaId);
      if (existing?.ownership !== 'mine') return current;
      const next = new Map(current);
      next.delete(areaId);
      return next;
    });
  }, []);

  const claimAreaOpenInBackground = useCallback(
    (project: Project, areaId: string) => {
      const sharedProjectId = project.sharedProjectId;
      const userId = collaborationAuth.user?.id;
      if (!sharedProjectId || !collaborationAuth.isSignedIn || !userId) return;

      const claimKey = `${sharedProjectId}:${areaId}`;
      if (backgroundAreaClaimKeysRef.current.has(claimKey)) return;

      backgroundAreaClaimKeysRef.current.add(claimKey);
      markAreaClaimedByCurrentUser(areaId);

      void claimSharedProjectArea(sharedProjectId, areaId)
        .then((claim) => {
          markAreaClaimedByCurrentUser(areaId, claim.expiresAt);
        })
        .catch((error) => {
          clearOptimisticAreaClaim(areaId);
          console.info('Background shared area claim failed:', error);
        })
        .finally(() => {
          backgroundAreaClaimKeysRef.current.delete(claimKey);
        });
    },
    [
      clearOptimisticAreaClaim,
      collaborationAuth.isSignedIn,
      collaborationAuth.user?.id,
      markAreaClaimedByCurrentUser,
    ]
  );

  async function loadProjects() {
    try {
      const data = await getAllProjects();
      const now = Date.now();
      const expiredProjects = data.filter(
        (project) =>
          project.deletedAt &&
          now - project.deletedAt.getTime() >= TRASH_RETENTION_MS
      );

      if (expiredProjects.length > 0) {
        for (const project of expiredProjects) {
          markProjectDeleted(project.id);
          await deleteProject(project.id);
          removeCachedProjectPreview(project.id);
        }
        scheduleSync(undefined, { fullSync: true });
      }

      const expiredIds = new Set(expiredProjects.map((project) => project.id));
      const activeData = data.filter((project) => !expiredIds.has(project.id));
      const nextProjects = collaborationAuth.isSignedIn
        ? await pullNewerSharedSnapshots(activeData)
        : activeData;
      if (collaborationAuth.user?.id) {
        queueStaleBackgroundSharedProjectPublishes({
          projects: nextProjects,
          userId: collaborationAuth.user.id,
        });
      }
      replaceProjectPreviewCache(nextProjects);
      setProjects(nextProjects);
    } catch (error) {
      console.error('Failed to load projects:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSync(options: { quiet?: boolean; silentStatus?: boolean } = {}) {
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
      const token = await ensureAccessToken({ interactive: options.quiet ? false : true });
      if (!token) {
        if (options.quiet) {
          setSyncStatus(hasPendingSyncState() ? 'pending' : 'idle');
        } else {
          setSyncError('Please sign in to sync.');
          setSyncStatus('needs-auth');
          await signIn({ selectAccount: true });
        }
        return;
      }
      const pendingSyncState = loadPendingSyncState();
      const result = await syncProjectsWithOneDriveRecovery(token, {
        pushProjectIds: pendingSyncState.projectIds,
      });
      setSyncConflicts(result.conflicts);
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
      await loadProjects();
    } catch (error) {
      console.error('Sync failed:', error);
      const hasQueuedSync = hasPendingSyncState();
      const retryDelayMs = getMicrosoftRetryDelayMs(error);
      if (retryDelayMs) {
        if (!hasQueuedSync) {
          queuePendingSync(undefined, { fullSync: true });
        }
        setRetryAt(null);
        if (!options.quiet) {
          setSyncError(formatMicrosoftManualRetryMessage(Math.ceil(retryDelayMs / 1000)));
        }
        pauseAutoSyncRetry();
        return;
      }
      const message = getMicrosoftErrorMessage(error, 'Sync failed.');
      if (message.startsWith('Saved locally.')) {
        if (!hasQueuedSync) {
          queuePendingSync(undefined, { fullSync: true });
        }
        setRetryAt(null);
        if (!options.quiet) {
          setSyncError(formatMicrosoftManualRetryMessage());
        }
        pauseAutoSyncRetry();
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

  function scheduleSync(projectId?: string, options?: { fullSync?: boolean }) {
    queuePendingSync(projectId, options);
    setSyncStatus('pending');
    if (projectId) {
      scheduleSharedPublish(projectId);
    }
  }

  async function pullNewerSharedSnapshots(projectsToCheck: Project[]) {
    return Promise.all(projectsToCheck.map(async (project) => {
      if (!project.sharedProjectId) {
        return project;
      }

      try {
        const metadata = await getSharedProjectSnapshotMetadata(project.sharedProjectId);
        if (!metadata) {
          return project;
        }
        if (hasNewerLocalChangesThanSharedSnapshot(project, metadata.publishedAt)) {
          return project;
        }
        if (!isSharedSnapshotNewer(project, metadata.publishedAt)) {
          return project;
        }
        const snapshot = await getSharedProjectSnapshot(project);
        if (hasNewerLocalChangesThanSharedSnapshot(project, snapshot.publishedAt)) {
          return project;
        }
        if (!isSharedSnapshotNewer(project, snapshot.publishedAt)) {
          return project;
        }
        await saveProjectPreserveTimestamps(snapshot.project);
        return snapshot.project;
      } catch (error) {
        console.info('Shared snapshot pull skipped:', error);
        return project;
      }
    }));
  }

  function scheduleSharedPublish(projectId: string) {
    const userId = collaborationAuth.user?.id;
    if (!userId) return;
    queueBackgroundSharedProjectPublish({ projectId, userId });
  }

  const projectMetrics = useMemo(() => {
    const metrics = new Map<string, ProjectMetrics>();
    for (const project of projects) {
      let total = 0;
      let ok = 0;
      let issues = 0;
      let activeAreaCount = 0;
      let photoCount = 0;
      let commentCount = 0;

      for (const area of project.areas) {
        if (area.deletedAt) continue;
        activeAreaCount += 1;
        for (const location of area.locations) {
          for (const item of location.items) {
            for (const checkpoint of item.checkpoints) {
              total += 1;
              if (checkpoint.status === 'ok') ok += 1;
              else if (checkpointHasIssue(checkpoint)) issues += 1;
              photoCount += checkpoint.photos.length;
              if (checkpoint.comments.trim()) commentCount += 1;
            }
          }
        }
      }

      const stats = { total, ok, issues, areas: activeAreaCount };
      const reviewMetrics = getReviewMetrics(stats.total, stats.ok, stats.issues);
      metrics.set(project.id, {
        stats,
        pending: reviewMetrics.pending,
        progress: reviewMetrics.reviewedPercent,
        okPercent: reviewMetrics.okPercent,
        issuePercent: reviewMetrics.issuePercent,
        photoCount,
        commentCount,
      });
    }
    return metrics;
  }, [projects]);

  const activeProjects = useMemo(
    () => projects.filter((project) => !project.deletedAt),
    [projects]
  );

  const trashedProjects = useMemo(
    () =>
      projects
        .filter((project) => project.deletedAt)
        .sort(
          (a, b) =>
            (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0)
        ),
    [projects]
  );

  const trashedAreaEntries = useMemo<TrashedAreaEntry[]>(
    () =>
      projects
        .flatMap((project) => {
          if (project.deletedAt) return [];
          return project.areas
            .filter((area) => area.deletedAt)
            .map((area) => ({
              project,
              area,
              deletedAt: area.deletedAt ?? new Date(0),
            }));
        })
        .sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime()),
    [projects]
  );

  const sortedProjects = useMemo(() => {
    return [...activeProjects].sort((a, b) => {
      if (sortOption === 'alphabetical') {
        return a.projectName.localeCompare(b.projectName);
      }
      if (sortOption === 'issues') {
        const issuesA = projectMetrics.get(a.id)?.stats.issues ?? 0;
        const issuesB = projectMetrics.get(b.id)?.stats.issues ?? 0;
        if (issuesB !== issuesA) return issuesB - issuesA;
        return a.projectName.localeCompare(b.projectName);
      }
      const progressA = projectMetrics.get(a.id)?.progress ?? 0;
      const progressB = projectMetrics.get(b.id)?.progress ?? 0;
      return progressB - progressA;
    });
  }, [activeProjects, projectMetrics, sortOption]);

  const singleProject = useMemo(
    () => (activeProjects.length === 1 ? activeProjects[0] : null),
    [activeProjects]
  );
  const singleProjectMainView = !!singleProject && !showTrash;
  const multiProjectSharedProjectSubscriptionKey = useMemo(() => {
    if (activeProjects.length <= 1) return '';
    return activeProjects
      .flatMap((project) => (project.sharedProjectId ? [`${project.id}:${project.sharedProjectId}`] : []))
      .sort()
      .join('|');
  }, [activeProjects]);

  const refreshLiveSharedDashboardProject = useCallback(async (
    localProjectId: string,
    sharedProjectId: string,
    publishedAt?: string
  ) => {
    const refreshKey = `${localProjectId}:${sharedProjectId}`;
    if (liveSharedDashboardRefreshKeysRef.current.has(refreshKey)) return;
    liveSharedDashboardRefreshKeysRef.current.add(refreshKey);

    try {
      const visibleProject = projectsRef.current.find(
        (entry) => entry.id === localProjectId && entry.sharedProjectId === sharedProjectId
      );
      if (!visibleProject || visibleProject.deletedAt) return;

      let remotePublishedAt = publishedAt;
      if (!remotePublishedAt) {
        const metadata = await getSharedProjectSnapshotMetadata(sharedProjectId);
        remotePublishedAt = metadata?.publishedAt;
      }
      if (!remotePublishedAt) return;
      if (hasNewerLocalChangesThanSharedSnapshot(visibleProject, remotePublishedAt)) return;
      if (!isSharedSnapshotNewer(visibleProject, remotePublishedAt)) return;

      const localProject = await getProject(localProjectId);
      if (!localProject?.sharedProjectId || localProject.sharedProjectId !== sharedProjectId || localProject.deletedAt) {
        return;
      }
      if (hasNewerLocalChangesThanSharedSnapshot(localProject, remotePublishedAt)) return;
      if (!isSharedSnapshotNewer(localProject, remotePublishedAt)) return;

      const snapshot = await getSharedProjectSnapshot(localProject);
      if (hasNewerLocalChangesThanSharedSnapshot(localProject, snapshot.publishedAt)) return;
      if (!isSharedSnapshotNewer(localProject, snapshot.publishedAt)) return;

      await saveProjectPreserveTimestamps(snapshot.project);
      cacheProjectPreview(snapshot.project);
      setProjects((prev) => {
        let updated = false;
        const nextProjects = prev.map((entry) => {
          if (entry.id !== localProject.id) return entry;
          updated = true;
          return { ...snapshot.project, areas: [...snapshot.project.areas] };
        });
        return updated ? nextProjects : prev;
      });
    } catch (error) {
      console.info('Live shared dashboard refresh skipped:', error);
    } finally {
      liveSharedDashboardRefreshKeysRef.current.delete(refreshKey);
    }
  }, []);

  useEffect(() => {
    if (!collaborationAuth.isSignedIn || !multiProjectSharedProjectSubscriptionKey) return;

    const unsubscribeSnapshotChanges = multiProjectSharedProjectSubscriptionKey
      .split('|')
      .map((entry) => {
        const [localProjectId, sharedProjectId] = entry.split(':');
        if (!localProjectId || !sharedProjectId) return () => {};
        return subscribeToSharedProjectSnapshotChanges(sharedProjectId, (change) => {
          void refreshLiveSharedDashboardProject(localProjectId, sharedProjectId, change.publishedAt);
        });
      });

    return () => {
      unsubscribeSnapshotChanges.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    collaborationAuth.isSignedIn,
    multiProjectSharedProjectSubscriptionKey,
    refreshLiveSharedDashboardProject,
  ]);

  useEffect(() => {
    if (!collaborationAuth.isSignedIn || !singleProject?.sharedProjectId) return;

    const localProjectId = singleProject.id;
    const activeSharedProjectId = singleProject.sharedProjectId;
    let cancelled = false;
    let refreshing = false;

    async function pullSafeSharedSnapshot(publishedAt?: string) {
      if (refreshing) return;
      refreshing = true;
      try {
        const localProject = await getProject(localProjectId);
        if (cancelled || !localProject?.sharedProjectId) return;

        let remotePublishedAt = publishedAt;
        if (!remotePublishedAt) {
          const metadata = await getSharedProjectSnapshotMetadata(activeSharedProjectId);
          if (cancelled) return;
          remotePublishedAt = metadata?.publishedAt;
        }
        if (!remotePublishedAt) return;
        if (hasNewerLocalChangesThanSharedSnapshot(localProject, remotePublishedAt)) return;
        if (!isSharedSnapshotNewer(localProject, remotePublishedAt)) return;

        const snapshot = await getSharedProjectSnapshot(localProject);
        if (cancelled) return;
        if (hasNewerLocalChangesThanSharedSnapshot(localProject, snapshot.publishedAt)) return;
        if (!isSharedSnapshotNewer(localProject, snapshot.publishedAt)) return;

        await saveProjectPreserveTimestamps(snapshot.project);
        if (cancelled) return;
        cacheProjectPreview(snapshot.project);
        setProjects((prev) =>
          prev.map((entry) =>
            entry.id === localProject.id
              ? { ...snapshot.project, areas: [...snapshot.project.areas] }
              : entry
          )
        );
      } catch (error) {
        if (!cancelled) {
          console.info('Live shared snapshot refresh skipped:', error);
        }
      } finally {
        refreshing = false;
      }
    }

    const unsubscribeSnapshotChanges = subscribeToSharedProjectSnapshotChanges(
      activeSharedProjectId,
      (change) => {
        void pullSafeSharedSnapshot(change.publishedAt);
      }
    );

    return () => {
      cancelled = true;
      unsubscribeSnapshotChanges();
    };
  }, [collaborationAuth.isSignedIn, singleProject?.id, singleProject?.sharedProjectId]);

  const areaTargetProject =
    projects.find((project) => project.id === areaTargetProjectId && !project.deletedAt) ??
    singleProject;
  const facadeLevelOptions = buildFacadeLevelOptions(areaTargetProject);
  const activeAreas = useMemo(
    () => (singleProject ? singleProject.areas.filter((area) => !area.deletedAt) : []),
    [singleProject]
  );
  const areaDisplayNames = useMemo(
    () => getAreaDisplayNameMap(activeAreas),
    [activeAreas]
  );

  useEffect(() => {
    const sharedProjectId = singleProject?.sharedProjectId;
    const userId = collaborationAuth.user?.id;
    if (!sharedProjectId || !collaborationAuth.isSignedIn || !userId) {
      setSharedAreaClaims(new Map());
      return;
    }

    const activeSharedProjectId = sharedProjectId;
    const activeUserId = userId;
    let cancelled = false;

    async function refreshSharedAreaClaims() {
      try {
        const claims = await getActiveSharedProjectAreaClaimSummaries(activeSharedProjectId);
        if (cancelled) return;
        setSharedAreaClaims(
          new Map(
            claims.map((claim): [string, AreaClaimDisplay] => {
              const isMine = claim.claimedByUserId === activeUserId;
              return [
                claim.areaId,
                {
                  ownership: isMine ? 'mine' : 'other',
                  label: claim.claimedByDisplayName || claim.claimedByEmail || 'another user',
                  expiresAt: claim.expiresAt,
                },
              ];
            })
          )
        );
      } catch (error) {
        if (cancelled) return;
        console.info('Shared area claims unavailable:', error);
        setSharedAreaClaims(new Map());
      }
    }

    void refreshSharedAreaClaims();
    const unsubscribeAreaClaimChanges = subscribeToSharedProjectAreaClaimChanges(
      activeSharedProjectId,
      () => {
        void refreshSharedAreaClaims();
      }
    );
    const refreshTimer = setInterval(() => {
      void refreshSharedAreaClaims();
    }, SHARED_AREA_CLAIM_REFRESH_MS);

    return () => {
      cancelled = true;
      unsubscribeAreaClaimChanges();
      clearInterval(refreshTimer);
    };
  }, [collaborationAuth.isSignedIn, collaborationAuth.user?.id, singleProject?.sharedProjectId]);

  const areaMetrics = useMemo(() => {
    const metrics = new Map<string, AreaMetrics>();
    if (!singleProject) return metrics;

    for (const area of activeAreas) {
      let total = 0;
      let ok = 0;
      let issues = 0;
      let photoCount = 0;
      let commentCount = 0;
      for (const location of area.locations) {
        for (const item of location.items) {
          for (const checkpoint of item.checkpoints) {
            total += 1;
            if (checkpoint.status === 'ok') ok += 1;
            else if (checkpointHasIssue(checkpoint)) issues += 1;
            photoCount += checkpoint.photos.length;
            if (checkpoint.comments.trim()) commentCount += 1;
          }
        }
      }
      const stats = { total, ok, issues };
      const reviewMetrics = getReviewMetrics(stats.total, stats.ok, stats.issues);
      metrics.set(area.id, {
        stats,
        pending: reviewMetrics.pending,
        progress: reviewMetrics.reviewedPercent,
        photoCount,
        commentCount,
      });
    }

    return metrics;
  }, [singleProject, activeAreas]);

  const sortedAreas = useMemo(() => {
    return [...activeAreas].sort((a, b) => {
      if (sortOption === 'alphabetical') {
        return compareAreaNames(a, b);
      }
      if (sortOption === 'issues') {
        const issuesA = areaMetrics.get(a.id)?.stats.issues ?? 0;
        const issuesB = areaMetrics.get(b.id)?.stats.issues ?? 0;
        if (issuesB !== issuesA) return issuesB - issuesA;
        return compareAreaNames(a, b);
      }
      const progressA = areaMetrics.get(a.id)?.progress ?? 0;
      const progressB = areaMetrics.get(b.id)?.progress ?? 0;
      return progressB - progressA;
    });
  }, [activeAreas, areaMetrics, sortOption]);

  async function handleCreateProject() {
    if (!newProjectName.trim()) return;

    const project = createProject(newProjectName.trim(), newProjectAddress.trim(), newProjectInspector.trim());
    project.gcName = newProjectGcName.trim();
    const facadeLevelStart = Number.parseInt(newProjectLevelStart, 10);
    const facadeLevelEnd = Number.parseInt(newProjectLevelEnd, 10);
    project.facadeLevelStart = Number.isNaN(facadeLevelStart) ? undefined : facadeLevelStart;
    project.facadeLevelEnd = Number.isNaN(facadeLevelEnd) ? undefined : facadeLevelEnd;
    await saveProjectMetadataOnly(project);
    scheduleSync(project.id);
    setProjects((prev) => [...prev, project]);
    setNewProjectName('');
    setNewProjectAddress('');
    setNewProjectInspector('');
    setNewProjectGcName('');
    setNewProjectLevelStart('');
    setNewProjectLevelEnd('');
    setShowNewProject(false);
  }

  async function handleAddArea() {
    const targetProject =
      projects.find((project) => project.id === areaTargetProjectId && !project.deletedAt) ??
      singleProject;
    if (!targetProject) return;

    let projectForAreaCreation = targetProject;
    if (targetProject.sharedProjectId && collaborationAuth.isSignedIn) {
      try {
        const fullProject = await getProject(targetProject.id);
        if (!fullProject) {
          throw new Error('Could not load this project.');
        }
        fullProject.sharedProjectId = targetProject.sharedProjectId;
        fullProject.sharedProjectLinkedAt = targetProject.sharedProjectLinkedAt;

        const conflict = await getSharedProjectPublishConflict(fullProject);
        if (conflict) {
          setPendingPull(await getPendingSharedPullState(fullProject, 'area-create-conflict'));
          return;
        }

        projectForAreaCreation = fullProject;
      } catch (error) {
        console.error('Failed to verify shared project before adding area:', error);
        showMessage(getCollaborationErrorMessage(error, 'Could not verify the latest shared data before adding this area.'));
        return;
      }
    }

    const areaForms = getAreaCreationForms(newAreaForm, buildFacadeLevelOptions(projectForAreaCreation));
    if (areaForms.length === 0) return;
    upsertFacadeElevationDrawing(projectForAreaCreation, newAreaForm.pendingElevationDrawing);

    const createdAreas = areaForms.map(
      (areaForm, index) => {
        const areaName = buildAreaName(areaForm);
        if (!areaName) return null;

        const area = createArea(projectForAreaCreation.id, areaName, projectForAreaCreation.areas.length + index, {
          areaTypeKey: areaForm.areaTypeKey,
          unitType: areaForm.unitType,
          customAreaName: areaForm.customAreaName,
          areaNumber: areaForm.areaNumber,
          facadeLevel: areaForm.facadeLevel,
          elevationDrawingId: areaForm.areaTypeKey === 'facade' ? areaForm.elevationDrawingId : '',
        });
        area.areaTypeKey = areaForm.areaTypeKey;
        area.unitType = areaForm.unitType || undefined;
        area.customAreaName = areaForm.customAreaName.trim() || undefined;
        area.areaNumber = areaForm.areaNumber.trim() || undefined;
        area.facadeLevel = areaForm.facadeLevel.trim() || undefined;
        area.elevationDrawingId =
          areaForm.areaTypeKey === 'facade' ? areaForm.elevationDrawingId || undefined : undefined;
        applyTemplateToArea(area);
        return area;
      }
    ).filter((area): area is Area => area !== null);
    if (createdAreas.length === 0) return;

    projectForAreaCreation.areas.push(...createdAreas);
    if (newAreaForm.pendingElevationDrawing) {
      await saveProject(projectForAreaCreation);
    } else {
      await saveProjectMetadataOnly(projectForAreaCreation);
    }
    if (projectForAreaCreation.sharedProjectId && collaborationAuth.isSignedIn && collaborationAuth.user?.id) {
      for (const area of createdAreas) {
        claimAreaOpenInBackground(projectForAreaCreation, area.id);
      }
    }
    scheduleSync(projectForAreaCreation.id);
    const nextRecentAreaTypeKeys = [
      newAreaForm.areaTypeKey,
      ...recentAreaTypeKeys.filter((key) => key !== newAreaForm.areaTypeKey),
    ].slice(0, 8);
    setRecentAreaTypeKeys(nextRecentAreaTypeKeys);
    localStorage.setItem(RECENT_AREA_TYPES_STORAGE_KEY, JSON.stringify(nextRecentAreaTypeKeys));
    setNewAreaForm(getDefaultAreaFormValue());
    setAreaTargetProjectId(null);
    setShowAddArea(false);
    setProjects((prev) =>
      prev.map((project) =>
        project.id === projectForAreaCreation.id
          ? { ...projectForAreaCreation, areas: [...projectForAreaCreation.areas] }
          : project
      )
    );
  }

  const toggleProjectSelection = useCallback((id: string) => {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleToggleProjectMenu = useCallback((id: string) => {
    setShowProjectMenuId((prev) => (prev === id ? null : id));
  }, []);

  const handleCloseProjectMenu = useCallback(() => {
    setShowProjectMenuId(null);
  }, []);

  const handleOpenProjectEditor = useCallback((project: Project) => {
    setEditingProject(project);
  }, []);

  const handleProjectCardLongPress = useCallback((projectId: string) => {
    setShowTrash(false);
    setDeleteMode(false);
    setExportMode(true);
    setSelectedAreaIds(new Set());
    setSelectedProjectIds(new Set([projectId]));
  }, []);

  const handleTrashedProjectLongPress = useCallback((projectId: string) => {
    setShowTrash(true);
    setDeleteMode(true);
    setExportMode(false);
    setSelectedAreaIds(new Set());
    setSelectedProjectIds(new Set([projectId]));
  }, []);

  const toggleAreaSelection = useCallback((id: string) => {
    setSelectedAreaIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const enterAreaSelectionMode = useCallback((areaId: string) => {
    setShowTrash(false);
    setDeleteMode(true);
    setExportMode(false);
    setExportScope('selected-projects');
    setSelectedProjectIds(new Set());
    setSelectedAreaIds(new Set([areaId]));
  }, []);

  async function handleDeleteSelectedProjects() {
    if (selectedProjectIds.size === 0) return;
    if (showTrash) {
      const projectsToDelete = trashedProjects.filter((project) => selectedProjectIds.has(project.id));
      if (projectsToDelete.length === 0) return;

      for (const project of projectsToDelete) {
        markProjectDeleted(project.id);
        await deleteProject(project.id);
        removeCachedProjectPreview(project.id);
      }
      scheduleSync(undefined, { fullSync: true });
      setProjects((prev) => prev.filter((project) => !selectedProjectIds.has(project.id)));
    } else {
      const projectsToTrash = activeProjects.filter((project) => selectedProjectIds.has(project.id));
      if (projectsToTrash.length === 0) return;

      for (const project of projectsToTrash) {
        project.deletedAt = new Date();
        await saveProjectMetadataOnly(project);
        queuePendingSync(project.id);
      }
      scheduleSync();
      setProjects((prev) =>
        prev.map((project) =>
          selectedProjectIds.has(project.id) ? { ...project, deletedAt: project.deletedAt } : project
        )
      );
    }

    setSelectedProjectIds(new Set());
    setDeleteMode(false);
    setExportMode(false);
    setActionSheet(null);
  }

  const handleTrashProject = useCallback(async (project: Project) => {
    project.deletedAt = new Date();
    await saveProjectMetadataOnly(project);
    scheduleSyncRef.current(project.id);
    setShowProjectMenuId(null);
    setProjects((prev) =>
      prev.map((entry) => (entry.id === project.id ? { ...project, areas: [...project.areas] } : entry))
    );
  }, []);

  async function handleDeleteSelectedAreas() {
    if (!singleProject) return;
    if (selectedAreaIds.size === 0) {
      setDeleteMode(false);
      setExportScope('selected-projects');
      return;
    }
    const now = new Date();
    singleProject.areas.forEach((area) => {
      if (selectedAreaIds.has(area.id)) {
        area.deletedAt = now;
        area.updatedAt = now;
      }
    });
    await saveProjectMetadataOnly(singleProject);
    scheduleSync(singleProject.id);
    setSelectedAreaIds(new Set());
    setDeleteMode(false);
    setExportScope('selected-projects');
    setActionSheet(null);
    await loadProjects();
  }

  async function handleExportSelectedAreas(destination: ExportDestination) {
    if (!singleProject || exportingSelectedAreas || selectedAreaIds.size === 0) return;
    setExportingSelectedAreas(true);
    setActionSheet(null);
    try {
      const selectedIds = new Set(selectedAreaIds);
      const selectedSortedAreaIds = sortedAreas
        .filter((area) => selectedIds.has(area.id))
        .map((area) => area.id);
      const shouldSaveToDrive = destination === 'onedrive';
      const token = shouldSaveToDrive ? await ensureAccessToken() : null;
      if (shouldSaveToDrive && !token) {
        signIn();
        return;
      }
      const fullProject = token
        ? await hydrateProjectMediaFromOneDrive(token, singleProject.id)
        : await getProject(singleProject.id);
      const projectForExport = fullProject ?? singleProject;
      const { generateProjectPDF, downloadPDF } = await import('@/lib/pdfExport');
      const blob = await generateProjectPDF(projectForExport, 'issues', { areaIds: selectedSortedAreaIds });
      if (destination === 'local') {
        const filename = `${sanitizeExportNamePart(singleProject.projectName)}_Selected_Areas_${formatDateForExport()}.pdf`;
        downloadPDF(blob, filename);
      }
      if (token && shouldSaveToDrive) {
        const projectFolderName = getOneDriveProjectFolderName(singleProject);
        const filename = await getNextOneDriveExportFilename(
          token,
          [`${singleProject.projectName}_Selected_Areas_Issues`],
          new Date(),
          projectFolderName
        );
        await uploadPdfToOneDrive(token, filename, blob, projectFolderName);
      }
      setSelectedAreaIds(new Set());
      setDeleteMode(false);
      setExportMode(false);
    } catch (error) {
      console.error('Failed to export selected areas:', error);
      showMessage('Failed to export selected areas. Please try again.');
    } finally {
      setExportingSelectedAreas(false);
    }
  }

  async function handleRestoreProject(projectId: string) {
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) return;
    delete project.deletedAt;
    unmarkProjectDeleted(project.id);
    await saveProjectMetadataOnly(project);
    scheduleSync(project.id, { fullSync: true });
    setProjects((prev) =>
      prev.map((entry) => (entry.id === project.id ? { ...project, areas: [...project.areas] } : entry))
    );
  }

  async function handleRestoreArea(projectId: string, areaId: string) {
    const project = projects.find((entry) => entry.id === projectId);
    const area = project?.areas.find((entry) => entry.id === areaId);
    if (!project || !area) return;

    delete area.deletedAt;
    area.updatedAt = new Date();
    await saveProjectMetadataOnly(project);
    scheduleSync(project.id);
    setProjects((prev) =>
      prev.map((entry) => (entry.id === project.id ? { ...project, areas: [...project.areas] } : entry))
    );
  }

  function handleExportSelectedConfirm() {
    if (exportingSelected || exportingSelectedToDrive || selectedProjectIds.size === 0) return;
    if (singleProjectMainView && selectedAreaIds.size === 0) return;
    setExportScope('selected-projects');
    setActionSheet('export');
  }

  async function loadProjectsForExport(token?: string | null) {
    const selectedAreas = new Set(selectedAreaIds);
    const shouldFilterAreas = singleProjectMainView && exportScope === 'selected-areas';
    const selectedProjects = [...sortedProjects]
      .filter((project) => selectedProjectIds.has(project.id))
      .sort((a, b) => a.projectName.localeCompare(b.projectName));

    const hydratedProjects = await Promise.all(
      selectedProjects.map(async (project) => {
        const fullProject = token
          ? await hydrateProjectMediaFromOneDrive(token, project.id)
          : await getProject(project.id);
        return fullProject ?? project;
      })
    );

    return hydratedProjects.map((project) => ({
      ...project,
      areas: [...project.areas]
        .filter((area) => !shouldFilterAreas || selectedAreas.has(area.id))
        .sort(compareAreaNames),
    }));
  }

  async function handleExportSelected(destination: ExportDestination) {
    if (exportingSelected || exportingSelectedToDrive || selectedProjectIds.size === 0) return;
    setActionSheet(null);
    const shouldSaveLocal = destination === 'local';
    const shouldSaveToDrive = destination === 'onedrive';
    setExportingSelected(shouldSaveLocal);
    setExportingSelectedToDrive(shouldSaveToDrive);
    try {
      const token = shouldSaveToDrive
        ? await ensureAccessToken()
        : isSignedIn
          ? await ensureAccessToken().catch(() => null)
          : null;
      if (shouldSaveToDrive && !token) {
        signIn();
        return;
      }
      const projectsToExport = [...sortedProjects]
        .filter((project) => selectedProjectIds.has(project.id))
        .sort((a, b) => a.projectName.localeCompare(b.projectName));
      const projectsForExport = await loadProjectsForExport(token);
      const { generateMultiProjectPDF, downloadPDF } = await import('@/lib/pdfExport');
      const blob = await generateMultiProjectPDF(projectsForExport, exportType);
      if (shouldSaveLocal) {
        const filename = exportType === 'issues' ? 'UAI_PUNCHLIST_APP_Issues_Report.pdf' : 'UAI_PUNCHLIST_APP_Full_Report.pdf';
        downloadPDF(blob, filename);
      }
      if (token && shouldSaveToDrive) {
        const exportProject =
          projectsToExport.length === 1 ? projectsToExport[0] : null;
        const exportProjectFolderName = exportProject
          ? getOneDriveProjectFolderName(exportProject)
          : undefined;
        const filename = await getNextOneDriveExportFilename(
          token,
          projectsToExport.map((project) => `${project.projectName}_${exportType === 'issues' ? 'Issues' : 'Full'}`),
          new Date(),
          exportProjectFolderName
        );
        await uploadPdfToOneDrive(token, filename, blob, exportProjectFolderName);
      }
    } catch (error) {
      console.error('Failed to export selected projects:', error);
      showMessage('Failed to export selected projects. Please try again.');
    } finally {
      setExportingSelected(false);
      setExportingSelectedToDrive(false);
      setExportMode(false);
      setSelectedProjectIds(new Set());
    }
  }

  async function handleEditProject(updates: Partial<Project>) {
    if (!editingProject) return;
    Object.assign(editingProject, updates);
    await saveProjectMetadataOnly(editingProject);
    scheduleSync(editingProject.id);
    setProjects((prev) =>
      prev.map((project) =>
        project.id === editingProject.id ? { ...editingProject, areas: [...editingProject.areas] } : project
      )
    );
    setEditingProject(null);
  }

  const handleShareProject = useCallback(async (project: Project) => {
    if (!collaborationAuth.isSignedIn || !collaborationAuth.user) {
      showMessage('Enable shared projects before sharing this project.');
      return;
    }

    if (!accountEmail) {
      showMessage('Sign in with an allowed Microsoft account before sharing this project.');
      return;
    }

    try {
      const sharedProjectId = await createSharedProjectFromLocalProject(
        project,
        accountEmail,
        accountName
      );
      const linkedAt = new Date();
      project.sharedProjectId = sharedProjectId;
      project.sharedProjectLinkedAt = linkedAt;
      await saveProject(project);
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === project.id
            ? { ...project, sharedProjectId, sharedProjectLinkedAt: linkedAt, areas: [...project.areas] }
            : entry
        )
      );
      showMessage('Project sharing is enabled. You are the owner of this shared project.');
    } catch (error) {
      console.error('Failed to share project:', error);
      showMessage(getCollaborationErrorMessage(error));
    }
  }, [accountEmail, accountName, collaborationAuth.isSignedIn, collaborationAuth.user, showMessage]);

  const handleCreateJoinCode = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share this project before creating an invite code.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before creating an invite code.');
      return;
    }

    setCreatingJoinCode(true);
    try {
      const result = await generateSharedProjectJoinCode(project.sharedProjectId);
      setSharedProjectCode({
        projectName: project.projectName,
        code: result.joinCode,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      console.error('Failed to create shared project code:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to create invite code. Please try again.'));
    } finally {
      setCreatingJoinCode(false);
    }
  }, [collaborationAuth.isSignedIn, showMessage]);

  const handleShowSharedMembers = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share this project before viewing shared members.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before viewing shared members.');
      return;
    }

    setLoadingSharedMembers(true);
    setSharedMembersProject(project);
    setSharedMembers([]);
    try {
      const members = await getSharedProjectMembers(project.sharedProjectId);
      if (members.length === 0) {
        setSharedMembers([]);
        return;
      }

      setSharedMembers(members);
    } catch (error) {
      console.error('Failed to load shared project members:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to load shared project members. Please try again.'));
      setSharedMembersProject(null);
    } finally {
      setLoadingSharedMembers(false);
    }
  }, [collaborationAuth.isSignedIn, showMessage]);

  async function addSharedProjectToDevice(sharedProjectId: string, projectName: string) {
    const existingProject = projects.find((project) => project.sharedProjectId === sharedProjectId);
    if (existingProject) {
      return { project: existingProject, alreadyLocal: true };
    }

    const project = createProject(projectName);
    project.sharedProjectId = sharedProjectId;
    project.sharedProjectLinkedAt = new Date();

    let projectToSave = project;
    let pulledSnapshot = false;
    try {
      const snapshot = await getSharedProjectSnapshot(project);
      projectToSave = snapshot.project;
      pulledSnapshot = true;
    } catch (error) {
      console.info('Joined shared project before shared data was published:', error);
    }

    await saveProject(projectToSave);
    setProjects((prev) => [...prev, projectToSave]);
    return { project: projectToSave, alreadyLocal: false, pulledSnapshot };
  }

  async function handleJoinSharedProject() {
    const code = joinProjectCode.trim();
    if (!code || joiningProject) return;

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before joining a project.');
      return;
    }

    if (!accountEmail) {
      showMessage('Sign in with an allowed Microsoft account before joining a shared project.');
      return;
    }

    setJoiningProject(true);
    try {
      const result = await joinSharedProjectByCode(code, accountEmail, accountName);
      const { alreadyLocal, pulledSnapshot } = await addSharedProjectToDevice(result.sharedProjectId, result.projectName);
      setShowJoinProject(false);
      setJoinProjectCode('');
      if (alreadyLocal) {
        showMessage(`You already joined "${result.projectName}".`);
      } else if (pulledSnapshot) {
        showMessage(`Joined "${result.projectName}" and pulled the latest shared data.`);
      } else {
        showMessage(`Joined "${result.projectName}". No shared data has been published yet.`);
      }
    } catch (error) {
      console.error('Failed to join shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to join shared project. Please try again.'));
    } finally {
      setJoiningProject(false);
    }
  }

  async function handleShowMySharedProjects() {
    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before viewing your shared projects.');
      return;
    }

    setShowMySharedProjects(true);
    setLoadingMySharedProjects(true);
    try {
      const entries = await listMySharedProjects();
      setMySharedProjects(entries);
    } catch (error) {
      console.error('Failed to load shared projects:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to load your shared projects. Please try again.'));
      setShowMySharedProjects(false);
    } finally {
      setLoadingMySharedProjects(false);
    }
  }

  async function handleRunCollaborationHealthCheck() {
    setShowCollaborationHealth(true);
    setRunningCollaborationHealth(true);
    try {
      const report = await runCollaborationHealthCheck();
      setCollaborationHealthReport(report);
    } catch (error) {
      console.error('Failed to run collaboration health check:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to run collaboration health check.'));
    } finally {
      setRunningCollaborationHealth(false);
    }
  }

  async function handleAddSharedProjectFromDirectory(entry: CollaborationSharedProjectDirectoryEntry) {
    if (addingSharedProjectId) return;

    setAddingSharedProjectId(entry.projectId);
    try {
      const { alreadyLocal, pulledSnapshot } = await addSharedProjectToDevice(entry.projectId, entry.projectName);
      if (alreadyLocal) {
        showMessage(`"${entry.projectName}" is already on this device.`);
      } else if (pulledSnapshot) {
        showMessage(`"${entry.projectName}" was added to this device with the latest shared data.`);
      } else {
        showMessage(`"${entry.projectName}" was added to this device. No shared data has been published yet.`);
      }
    } catch (error) {
      console.error('Failed to add shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to add this shared project. Please try again.'));
    } finally {
      setAddingSharedProjectId(null);
    }
  }

  const handlePublishSharedProject = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share this project before publishing shared data.');
      return;
    }

    if (!collaborationAuth.isSignedIn || !collaborationAuth.user) {
      showMessage('Enable shared projects before publishing shared data.');
      return;
    }

    setPublishingSharedProject(true);
    let fullProject: Project | undefined;
    try {
      fullProject = await getProject(project.id);
      if (!fullProject) {
        throw new Error('Could not load this project.');
      }

      const loadedProject = fullProject;
      loadedProject.sharedProjectId = project.sharedProjectId;
      loadedProject.sharedProjectLinkedAt = project.sharedProjectLinkedAt;
      const result = await publishSharedProjectSnapshot(loadedProject, collaborationAuth.user.id);
      await saveProjectMetadataOnly(loadedProject, { touch: false });
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === loadedProject.id
            ? { ...entry, sharedSnapshotPublishedAt: loadedProject.sharedSnapshotPublishedAt }
            : entry
        )
      );
      showMessage(`Shared data published at ${new Date(result.publishedAt).toLocaleTimeString()}.`);
    } catch (error) {
      if (fullProject && isSharedProjectPublishConflictError(error)) {
        console.info('Publish blocked because shared data is newer:', error);
        try {
          setPendingPull(await getPendingSharedPullState(fullProject, 'publish-conflict'));
        } catch (reviewError) {
          console.error('Failed to load shared data for publish conflict review:', reviewError);
          showMessage('Shared data changed before publishing. Pull shared data before publishing again.');
        }
        return;
      }

      console.error('Failed to publish shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to publish shared data. Please try again.'));
    } finally {
      setPublishingSharedProject(false);
    }
  }, [collaborationAuth.isSignedIn, collaborationAuth.user, showMessage]);

  const handlePullSharedProject = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share or join this project before pulling shared data.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before pulling shared data.');
      return;
    }

    setPullingSharedProject(true);
    try {
      const fullProject = await getProject(project.id);
      if (!fullProject) {
        throw new Error('Could not load this project.');
      }

      fullProject.sharedProjectId = project.sharedProjectId;
      fullProject.sharedProjectLinkedAt = project.sharedProjectLinkedAt;
      const result = await getSharedProjectSnapshot(fullProject);
      const hasNewerLocalChanges = hasNewerLocalChangesThanSharedSnapshot(fullProject, result.publishedAt);
      if (hasNewerLocalChanges) {
        setPendingPull({
          localProject: fullProject,
          sharedProject: result.project,
          publishedAt: result.publishedAt,
          hasNewerLocalChanges,
          reason: 'manual-pull',
        });
        return;
      }

      if (!isSharedSnapshotNewer(fullProject, result.publishedAt)) {
        showMessage('Shared data is already up to date.');
        return;
      }

      await saveProjectPreserveTimestamps(result.project);
      cacheProjectPreview(result.project);
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === fullProject.id
            ? { ...result.project, areas: [...result.project.areas] }
            : entry
        )
      );
      showMessage(`Shared data pulled from ${new Date(result.publishedAt).toLocaleString()}.`);
    } catch (error) {
      console.error('Failed to pull shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to pull shared data. Please try again.'));
    } finally {
      setPullingSharedProject(false);
    }
  }, [collaborationAuth.isSignedIn, showMessage]);

  async function confirmPullSharedProject() {
    if (!pendingPull) return;

    const pullState = pendingPull;
    setPendingPull(null);
    setPullingSharedProject(true);
    try {
      await captureSharedProjectBackup(
        pullState.localProject,
        'before_pull',
        'Local data before pulling shared data.'
      );

      await saveProjectPreserveTimestamps(pullState.sharedProject);
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === pullState.localProject.id
            ? { ...pullState.sharedProject, areas: [...pullState.sharedProject.areas] }
            : entry
        )
      );
      showMessage(`Shared data pulled from ${new Date(pullState.publishedAt).toLocaleString()}.`);
    } catch (error) {
      console.error('Failed to pull shared project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to pull shared data. Please try again.'));
    } finally {
      setPullingSharedProject(false);
    }
  }

  const handleShowSharedBackups = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share this project before viewing shared backups.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before viewing shared backups.');
      return;
    }

    setBackupProject(project);
    setLoadingSharedBackups(true);
    setSharedBackups([]);
    try {
      const backups = await listSharedProjectBackups(project.sharedProjectId);
      setSharedBackups(backups);
    } catch (error) {
      console.error('Failed to load shared backups:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to load shared backups. Please try again.'));
      setBackupProject(null);
    } finally {
      setLoadingSharedBackups(false);
    }
  }, [collaborationAuth.isSignedIn, showMessage]);

  async function handleRestoreSharedBackup(backup: CollaborationSnapshotBackup, publishAfterRestore = false) {
    setBackupRestoreConfirm({ backup, publishAfterRestore });
  }

  async function confirmRestoreSharedBackup(backup: CollaborationSnapshotBackup, publishAfterRestore: boolean) {
    if (!backupProject || restoringBackupId) return;
    if (publishAfterRestore && !collaborationAuth.user) {
      showMessage('Enable shared projects before restoring and publishing a backup.');
      return;
    }

    setBackupRestoreConfirm(null);
    setRestoringBackupId(backup.id);
    try {
      const fullProject = await getProject(backupProject.id);
      if (!fullProject) {
        throw new Error('Could not load this project.');
      }

      fullProject.sharedProjectId = backupProject.sharedProjectId;
      fullProject.sharedProjectLinkedAt = backupProject.sharedProjectLinkedAt;
      await captureSharedProjectBackup(
        fullProject,
        'restore',
        'Local data before restoring a shared backup.'
      );

      const result = await getSharedProjectBackupSnapshot(fullProject, backup.id);
      await saveProjectPreserveTimestamps(result.project);
      let publishedAt: string | null = null;
      if (publishAfterRestore && collaborationAuth.user) {
        const publishResult = await publishSharedProjectSnapshot(result.project, collaborationAuth.user.id);
        publishedAt = publishResult.publishedAt;
        await saveProjectMetadataOnly(result.project, { touch: false });
      }
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === backupProject.id
            ? { ...result.project, areas: [...result.project.areas] }
            : entry
        )
      );
      setBackupProject({ ...result.project, areas: [...result.project.areas] });
      showMessage(
        publishedAt
          ? `Backup restored and published as the team version at ${new Date(publishedAt).toLocaleTimeString()}.`
          : 'Backup restored on this device. Publish shared data if you want this restored version to become the team version.'
      );
    } catch (error) {
      console.error('Failed to restore shared backup:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to restore this backup. Please try again.'));
    } finally {
      setRestoringBackupId(null);
    }
  }

  function handleDisconnectSharedProject(project: Project) {
    if (!project.sharedProjectId) {
      showMessage('This project is not currently shared.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before stopping sharing for this project.');
      return;
    }

    setDisconnectSharedProjectConfirm(project);
  }

  async function confirmDisconnectSharedProject() {
    const targetProject = disconnectSharedProjectConfirm;
    const sharedProjectId = targetProject?.sharedProjectId;
    if (!targetProject || !sharedProjectId || disconnectingSharedProject) return;

    setDisconnectingSharedProject(true);
    try {
      const fullProject = await getProject(targetProject.id);
      if (!fullProject) {
        throw new Error('Could not load this project.');
      }

      fullProject.sharedProjectId = targetProject.sharedProjectId;
      fullProject.sharedProjectLinkedAt = targetProject.sharedProjectLinkedAt;
      await captureSharedProjectBackup(
        fullProject,
        'manual',
        'Local data before stopping shared project access.'
      );

      const result = await disconnectSharedProject(sharedProjectId);
      const localProject = unlinkLocalSharedProject(fullProject);
      await saveProject(localProject);
      scheduleSync(localProject.id);
      setProjects((prev) =>
        prev.map((entry) =>
          entry.id === localProject.id ? { ...localProject, areas: [...localProject.areas] } : entry
        )
      );
      setDisconnectSharedProjectConfirm(null);
      showMessage(
        result.action === 'archived'
          ? 'Sharing has stopped for this project. Your local project data is still on this device.'
          : 'You left this shared project. Your local project data is still on this device.'
      );
    } catch (error) {
      console.error('Failed to stop sharing project:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to stop sharing this project. Please try again.'));
    } finally {
      setDisconnectingSharedProject(false);
    }
  }

  const handleTransferSharedProjectOwnership = useCallback(async (project: Project) => {
    if (!project.sharedProjectId) {
      showMessage('Share this project before transferring ownership.');
      return;
    }

    if (!collaborationAuth.isSignedIn) {
      showMessage('Enable shared projects before transferring ownership.');
      return;
    }

    setOwnershipTransferProject(project);
  }, [collaborationAuth.isSignedIn, showMessage]);

  async function confirmTransferSharedProjectOwnership(newOwnerEmailValue: string) {
    const project = ownershipTransferProject;
    if (!project?.sharedProjectId) return;

    const newOwnerEmail = newOwnerEmailValue.trim().toLowerCase();
    if (!newOwnerEmail) return;

    setOwnershipTransferProject(null);
    setTransferringSharedProject(true);
    try {
      const result = await transferSharedProjectOwnership(project.sharedProjectId, newOwnerEmail);
      showMessage(`Ownership transferred to ${result.ownerEmail}.`);
    } catch (error) {
      console.error('Failed to transfer shared project ownership:', error);
      showMessage(getCollaborationErrorMessage(error, 'Failed to transfer ownership. Please try again.'));
    } finally {
      setTransferringSharedProject(false);
    }
  }

  async function handleDeleteEditingProject() {
    if (!editingProject) return;
    const projectToDelete = editingProject;
    setDeleteProjectConfirm(projectToDelete);
  }

  async function confirmDeleteEditingProject(projectToDelete: Project) {
    setEditingProject(null);
    setDeleteProjectConfirm(null);
    await handleTrashProject(projectToDelete);
  }

  function cancelSelectionMode() {
    setDeleteMode(false);
    setExportMode(false);
    setActionSheet(null);
    setExportScope('selected-projects');
    setSelectedProjectIds(new Set());
    setSelectedAreaIds(new Set());
  }

  homeMenuActionHandlerRef.current = (event: Event) => {
    const customEvent = event as CustomEvent<{ action: string; sort?: SortOption }>;
    const detail = customEvent.detail;
    if (!detail) return;

    if (detail.action === 'sort' && detail.sort) {
      handleSortChange(detail.sort);
      return;
    }

    if (detail.action === 'sync-now') {
      void handleSync();
      return;
    }

    if (detail.action.startsWith('quick-sort:')) {
      const nextQuickSort = detail.action.replace('quick-sort:', '');
      if (nextQuickSort === 'issues' || nextQuickSort === 'alphabetical' || nextQuickSort === 'progress') {
        setQuickSort(nextQuickSort);
        handleSortChange(nextQuickSort);
      }
      return;
    }

    if (detail.action === 'new-project') {
      setShowNewProject(true);
      return;
    }

    if (detail.action === 'new-area') {
      if (singleProject) {
        setAreaTargetProjectId(singleProject.id);
        setShowAddArea(true);
      }
      return;
    }

    if (detail.action === 'toggle-trash') {
      toggleTrashView();
      return;
    }

    if (detail.action === 'clear-trash') {
      setShowTrash(false);
      setDeleteMode(false);
      setExportMode(false);
      setSelectedProjectIds(new Set());
      setSelectedAreaIds(new Set());
      return;
    }

    if (detail.action === 'edit-project' && singleProject) {
      handleOpenProjectEditor(singleProject);
      return;
    }

    if (detail.action === 'toggle-selection' && singleProject) {
      setShowTrash(false);
      setExportMode(false);
      setExportScope('selected-projects');
      setSelectedProjectIds(new Set());
      setActionSheet(null);
      if (deleteMode) {
        setDeleteMode(false);
        setSelectedAreaIds(new Set());
      } else {
        setDeleteMode(true);
        setSelectedAreaIds(new Set());
      }
      return;
    }

    if (detail.action === 'export-project' && singleProject) {
      setShowTrash(false);
      setDeleteMode(false);
      setExportMode(false);
      setSelectedAreaIds(new Set());
      setSelectedProjectIds(new Set([singleProject.id]));
      setExportScope('selected-projects');
      setActionSheet('export-scope');
      return;
    }

    if (detail.action === 'share-project' && singleProject) {
      void handleShareProject(singleProject);
      return;
    }

    if (detail.action === 'invite-code' && singleProject) {
      void handleCreateJoinCode(singleProject);
      return;
    }

    if (detail.action === 'shared-members' && singleProject) {
      void handleShowSharedMembers(singleProject);
      return;
    }

    if (detail.action === 'my-shared-projects') {
      void handleShowMySharedProjects();
      return;
    }

    if (detail.action === 'collaboration-health') {
      void handleRunCollaborationHealthCheck();
      return;
    }

    if (detail.action === 'join-shared-project') {
      setShowJoinProject(true);
      return;
    }

    if (detail.action === 'publish-shared-project' && singleProject) {
      void handlePublishSharedProject(singleProject);
      return;
    }

    if (detail.action === 'pull-shared-project' && singleProject) {
      void handlePullSharedProject(singleProject);
      return;
    }

    if (detail.action === 'shared-backups' && singleProject) {
      void handleShowSharedBackups(singleProject);
      return;
    }

    if (detail.action === 'disconnect-shared-project' && singleProject) {
      handleDisconnectSharedProject(singleProject);
      return;
    }

    if (detail.action === 'transfer-shared-project' && singleProject) {
      void handleTransferSharedProjectOwnership(singleProject);
      return;
    }

    if (detail.action === 'auth') {
      if (isSignedIn) signOut();
      else signIn();
    }
  };

  useEffect(() => {
    function handleHomeMenuAction(event: Event) {
      homeMenuActionHandlerRef.current?.(event);
    }

    window.addEventListener('punchlist-home-menu-action', handleHomeMenuAction as EventListener);
    return () => {
      window.removeEventListener('punchlist-home-menu-action', handleHomeMenuAction as EventListener);
    };
  }, []);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('punchlist-home-menu-state', {
        detail: {
          context: 'home',
          sortOption,
          showTrash,
          canAddArea: !!singleProject,
          isSingleProject: !!singleProject,
          singleProjectName: singleProject?.projectName ?? '',
          selectionMode: deleteMode,
          isSharedProject: !!singleProject?.sharedProjectId,
          isCreatingJoinCode: creatingJoinCode,
          isLoadingSharedMembers: loadingSharedMembers,
          isPublishingSharedProject: publishingSharedProject,
          isPullingSharedProject: pullingSharedProject,
          isDisconnectingSharedProject: disconnectingSharedProject,
          isTransferringSharedProject: transferringSharedProject,
        },
      })
    );
  }, [
    creatingJoinCode,
    deleteMode,
    disconnectingSharedProject,
    loadingSharedMembers,
    publishingSharedProject,
    pullingSharedProject,
    sortOption,
    showTrash,
    singleProject,
    transferringSharedProject,
  ]);

  function toggleTrashView() {
    setShowTrash((current) => {
      const next = !current;
      if (next || current) {
        cancelSelectionMode();
      }
      return next;
    });
  }

  function handlePullStart(e: TouchEvent<HTMLElement>) {
    const atTop = (listRef.current?.scrollTop ?? 0) <= 0;
    if (!atTop || syncing) {
      pullStartYRef.current = null;
      return;
    }
    pullStartYRef.current = e.touches[0]?.clientY ?? null;
  }

  function handlePullMove(e: TouchEvent<HTMLElement>) {
    const atTop = (listRef.current?.scrollTop ?? 0) <= 0;
    if (pullStartYRef.current === null || !atTop || syncing) return;
    const currentY = e.touches[0]?.clientY ?? pullStartYRef.current;
    const delta = currentY - pullStartYRef.current;
    const armed = delta >= 90;
    if (armed !== pullArmedRef.current) {
      pullArmedRef.current = armed;
    }
  }

  function handlePullEnd() {
    pullStartYRef.current = null;
    if (pullArmedRef.current && !syncing) {
      void handleSync();
    }
    pullArmedRef.current = false;
  }

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--background)]">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-black/10 border-t-[var(--accent)] dark:border-white/10 dark:border-t-[var(--accent)]" />
      </div>
    );
  }

  return (
    <div className="app-page h-[calc(100dvh-env(safe-area-inset-top)-3.5rem)] flex flex-col overflow-hidden">
      {(singleProjectMainView || showTrash || selectionMode) && (
        <header className="header-stable shrink-0 border-b z-20">
          {(singleProjectMainView || showTrash) && (
            <div className="page-header-surface mx-auto flex min-h-[4.9rem] w-full max-w-6xl items-center px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                {singleProjectMainView ? (
                  <>
                    <h1 className="truncate text-[1.2rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
                      {singleProject.projectName}
                    </h1>
                    <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
                      {singleProject.address || 'Project dashboard'}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="section-eyebrow">Archive</div>
                    <h1 className="mt-1 text-[1.2rem] font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
                      Trash
                    </h1>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      Recently removed projects stay here for 30 days.
                    </p>
                  </>
                )}
              </div>
              {singleProjectMainView && selectionMode && (
                <div className="ml-3 flex items-center gap-3">
                  <button
                    onClick={cancelSelectionMode}
                    className="rounded-full px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-black/[0.04] hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setExportScope('selected-areas');
                      setActionSheet('export');
                    }}
                    disabled={exportingSelectedAreas || selectedAreaIds.size === 0}
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-black/5 bg-white/70 text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08] disabled:opacity-40"
                    aria-label="Export selected areas"
                  >
                    {exportingSelectedAreas ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FileDown className="w-4 h-4" />
                    )}
                  </button>
                  {exportScope !== 'selected-areas' && (
                    <button
                      onClick={() => {
                        if (selectedAreaIds.size === 0) return;
                        void handleDeleteSelectedAreas();
                      }}
                      className="accent-text accent-tint hover:accent-tint-strong flex h-10 w-10 items-center justify-center rounded-full transition disabled:opacity-40"
                      aria-label="Delete selected areas"
                      disabled={selectedAreaIds.size === 0}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {selectionMode && !singleProjectMainView && (
          <div className="mx-auto flex w-full max-w-6xl items-center gap-3 border-t border-gray-200/80 px-4 py-3 dark:border-gray-800 sm:px-5">
            <button
              onClick={cancelSelectionMode}
              className="rounded-full px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-black/[0.04] hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
            >
              Cancel
            </button>
            {!singleProjectMainView && !showTrash && (
              <button
                onClick={() => void handleExportSelectedConfirm()}
                disabled={exportingSelected || exportingSelectedToDrive || selectedProjectIds.size === 0}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-black/5 bg-white/70 text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08] disabled:opacity-40"
                aria-label="Export selected projects"
              >
                {exportingSelected || exportingSelectedToDrive ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FileDown className="w-4 h-4" />
                )}
              </button>
            )}
            <button
              onClick={() => {
                if (singleProjectMainView) {
                  if (selectedAreaIds.size === 0) return;
                  void handleDeleteSelectedAreas();
                  return;
                } else if (selectedProjectIds.size === 0) {
                  return;
                }
                if (showTrash) {
                  setActionSheet('delete');
                  return;
                }
                void handleDeleteSelectedProjects();
              }}
              className="accent-text accent-tint hover:accent-tint-strong flex h-10 w-10 items-center justify-center rounded-full transition disabled:opacity-40"
              aria-label={singleProjectMainView ? 'Delete selected areas' : 'Delete selected projects'}
              disabled={singleProjectMainView ? selectedAreaIds.size === 0 : selectedProjectIds.size === 0}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          )}
        </header>
      )}
      {syncError && (
        <div className="shrink-0 border-b border-gray-200/80 bg-white/70 px-4 py-2 text-sm text-gray-700 dark:border-zinc-700 dark:bg-white/[0.03] dark:text-gray-200">
          {syncError}
        </div>
      )}
      {syncConflicts.length > 0 && (
        <div className="shrink-0 border-b border-gray-200/80 bg-white/70 px-4 py-3 text-sm dark:border-zinc-700 dark:bg-white/[0.03]">
          <div className="text-gray-700 dark:text-gray-200">Sync needs review:</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {syncConflicts.map((conflict) => (
              <span
                key={conflict.id}
                className="segmented-chip px-3 py-1 text-xs"
              >
                {conflict.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <main
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+6.5rem)] sm:px-5"
        onTouchStart={handlePullStart}
        onTouchMove={handlePullMove}
        onTouchEnd={handlePullEnd}
        onTouchCancel={handlePullEnd}
      >
        {showTrash ? (
          trashedProjects.length === 0 && trashedAreaEntries.length === 0 ? (
            <div className="empty-state-card mx-auto max-w-md rounded-[2rem] p-10 text-center">
              <Trash2 className="mx-auto mb-4 h-14 w-14 text-gray-300 dark:text-gray-600" />
              <h2 className="mb-2 text-lg font-medium text-gray-900 dark:text-white">Trash Is Empty</h2>
              <p className="text-gray-500 dark:text-gray-400">Deleted projects and areas stay here so they can be restored.</p>
            </div>
          ) : (
            <div className="list-stack mx-auto w-full max-w-6xl">
              {trashedProjects.length > 0 && (
                <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
                  Deleted Projects
                </div>
              )}
              {trashedProjects.map((project) => {
                const deletedAt = project.deletedAt ?? new Date();
                const expiresAt = new Date(deletedAt.getTime() + TRASH_RETENTION_MS);
                const isSelected = selectedProjectIds.has(project.id);
                const longPressRef = { current: null as ReturnType<typeof setTimeout> | null };

                function clearLongPress() {
                  if (longPressRef.current) {
                    clearTimeout(longPressRef.current);
                    longPressRef.current = null;
                  }
                }

                return (
                  <div
                    key={project.id}
                    onContextMenu={(event) => {
                      if (!deleteMode) {
                        event.preventDefault();
                      }
                    }}
                    onClick={() => {
                      if (deleteMode) {
                        toggleProjectSelection(project.id);
                      }
                    }}
                    onPointerDown={() => {
                      if (!deleteMode) {
                        longPressRef.current = setTimeout(() => {
                          handleTrashedProjectLongPress(project.id);
                          longPressRef.current = null;
                        }, LONG_PRESS_MS);
                      }
                    }}
                    onPointerUp={clearLongPress}
                    onPointerCancel={clearLongPress}
                    onPointerLeave={clearLongPress}
                    className={`card-surface-subtle rounded-[1.5rem] p-4 transition-all ${
                      isSelected
                        ? '!border-gray-400 !bg-gray-100 dark:!border-gray-500 dark:!bg-white/[0.08]'
                        : 'hover:-translate-y-px hover:border-black/10 dark:hover:border-white/[0.08]'
                    } ${deleteMode ? 'cursor-pointer' : ''} select-none touch-manipulation [-webkit-touch-callout:none]`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="font-medium text-gray-900 dark:text-white truncate">{project.projectName}</div>
                        </div>
                        <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                          Deleted {deletedAt.toLocaleDateString()}
                        </div>
                        <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                          Permanently removed after {expiresAt.toLocaleDateString()}
                        </div>
                      </div>
                      {!deleteMode && (
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => void handleRestoreProject(project.id)}
                            onContextMenu={(event) => event.preventDefault()}
                            onPointerDown={(event) => event.stopPropagation()}
                            className="segmented-chip px-3 py-2 text-sm"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Restore
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {trashedAreaEntries.length > 0 && (
                <div className={`${trashedProjects.length > 0 ? 'pt-2' : ''} px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400`}>
                  Deleted Areas
                </div>
              )}
              {trashedAreaEntries.map(({ project, area, deletedAt }) => (
                <div
                  key={`${project.id}:${area.id}`}
                  className="card-surface-subtle rounded-[1.5rem] p-4 transition-all sm:p-5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="truncate font-medium text-gray-900 dark:text-white">{area.name}</div>
                        <span className="shrink-0 rounded-full bg-black/[0.04] px-2.5 py-1 text-[11px] font-semibold text-gray-500 dark:bg-white/[0.08] dark:text-gray-400">
                          Area
                        </span>
                      </div>
                      <div className="mt-1 truncate text-sm font-medium text-gray-700 dark:text-gray-200">
                        Project: {project.projectName}
                      </div>
                      {project.address && (
                        <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                          {project.address}
                        </div>
                      )}
                      <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                        Deleted {deletedAt.toLocaleDateString()}
                      </div>
                    </div>
                    {!deleteMode && (
                      <button
                        onClick={() => void handleRestoreArea(project.id, area.id)}
                        onContextMenu={(event) => event.preventDefault()}
                        onPointerDown={(event) => event.stopPropagation()}
                        className="segmented-chip shrink-0 px-3 py-2 text-sm"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Restore
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : singleProjectMainView ? (
          <div className="list-stack mx-auto min-h-[calc(100%+1px)] w-full max-w-6xl">
            {sortedAreas.length === 0 ? (
              <div className="flex min-h-[50vh] items-center justify-center py-12">
                <div className="empty-state-card w-full max-w-sm rounded-[1.9rem] p-8 text-center">
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">No areas yet</h2>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    Add the first area to turn this project into an active inspection dashboard.
                  </p>
                </div>
              </div>
            ) : (
              sortedAreas.map((area) => {
                const metric = areaMetrics.get(area.id);
                const isSelected = selectedAreaIds.has(area.id);
                return (
                  <HomeAreaCard
                    key={area.id}
                    project={singleProject}
                    area={area}
                    displayName={areaDisplayNames.get(area.id) ?? area.name}
                    metric={metric}
                    claimStatus={sharedAreaClaims.get(area.id)}
                    deleteMode={deleteMode}
                    isSelected={isSelected}
                    onToggleSelection={toggleAreaSelection}
                    onLongPressSelect={enterAreaSelectionMode}
                    onBlockedByClaim={(message) => showMessage(message, 'Area in use')}
                    onPrimeOpen={primeAreaOpen}
                    onOpenArea={claimAreaOpenInBackground}
                  />
                );
              })
            )}
          </div>
        ) : (
          <div className="list-stack mx-auto min-h-[calc(100%+1px)] w-full max-w-6xl">
            {sortedProjects.length === 0 ? (
              <div className="flex min-h-[50vh] items-center justify-center py-12">
                <div className="empty-state-card w-full max-w-sm rounded-[1.9rem] p-8 text-center">
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">No projects yet</h2>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    Create a project to start tracking units, issues, and inspection progress.
                  </p>
                </div>
              </div>
            ) : (
              sortedProjects.map((project) => {
                const metric = projectMetrics.get(project.id);
                const isSelected = selectedProjectIds.has(project.id);
                return (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    metric={metric}
                    selectionMode={selectionMode}
                    isSelected={isSelected}
                    menuOpen={showProjectMenuId === project.id}
                    onToggleSelection={toggleProjectSelection}
                    onToggleMenu={handleToggleProjectMenu}
                    onCloseMenu={handleCloseProjectMenu}
                    onEditProject={handleOpenProjectEditor}
                    onDeleteProject={handleTrashProject}
                    onLongPressSelect={handleProjectCardLongPress}
                    onPrimeOpen={primeProjectOpen}
                  />
                );
              })
            )}
          </div>
        )}
      </main>

      {!showTrash && !selectionMode && (
        <div className="floating-action-rail pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+1.25rem)] z-20">
          {singleProjectMainView ? (
            <button
              onClick={() => {
                setAreaTargetProjectId(singleProject.id);
                setShowAddArea(true);
              }}
              className="floating-action pointer-events-auto inline-flex h-14 w-[7.5rem] items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition hover:translate-y-[-1px]"
              aria-label="Add area"
              title="Add area"
            >
              <Plus className="h-4 w-4" />
              Area
            </button>
          ) : (
            <button
              onClick={() => setShowNewProject(true)}
            className="floating-action pointer-events-auto inline-flex h-14 w-[11.25rem] items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold transition hover:translate-y-[-1px]"
            >
              <Plus className="h-4 w-4" />
              Add Project
            </button>
          )}
        </div>
      )}

      {messageDialog && (
        <AppMessageDialog
          title={messageDialog.title}
          message={messageDialog.message}
          onClose={() => setMessageDialog(null)}
        />
      )}

      {backupRestoreConfirm && (
        <AppConfirmDialog
          title={backupRestoreConfirm.publishAfterRestore ? 'Restore and Publish' : 'Restore Backup'}
          message={
            backupRestoreConfirm.publishAfterRestore
              ? `Restore backup from ${backupRestoreConfirm.backup.capturedAt.toLocaleString()}, then publish it as the current team version?\n\nThis will replace the shared version after first saving a backup of your current local data.`
              : `Restore backup from ${backupRestoreConfirm.backup.capturedAt.toLocaleString()} to this device?\n\nPublish shared data after restoring if this should become the team version.`
          }
          confirmLabel={backupRestoreConfirm.publishAfterRestore ? 'Restore + Publish' : 'Restore'}
          danger={backupRestoreConfirm.publishAfterRestore}
          onCancel={() => setBackupRestoreConfirm(null)}
          onConfirm={() => void confirmRestoreSharedBackup(backupRestoreConfirm.backup, backupRestoreConfirm.publishAfterRestore)}
        />
      )}

      {pendingPull && (
        <AppConfirmDialog
          title={pendingPull.reason === 'manual-pull' ? 'Pull Shared Data' : 'Review Shared Changes'}
          message={
            pendingPull.reason === 'publish-conflict'
              ? `Publishing now would overwrite newer shared data from ${new Date(pendingPull.publishedAt).toLocaleString()}.\n\nThis will save a backup of your current local project, then replace this device's project data with the newer shared version.`
              : pendingPull.reason === 'area-create-conflict'
                ? `Shared data changed before this area could be added. Adding it now could recreate old project structure or duplicate work.\n\nThis will save a backup of your current local project, then replace this device's project data with the newer shared version from ${new Date(pendingPull.publishedAt).toLocaleString()}.`
              : `${pendingPull.hasNewerLocalChanges ? 'Your local project has changes newer than the shared version.\n\n' : ''}This will save a backup of your current local project, then replace this device's project data with the shared version from ${new Date(pendingPull.publishedAt).toLocaleString()}.`
          }
          confirmLabel={pendingPull.reason === 'manual-pull' ? 'Pull' : 'Back Up + Pull'}
          danger={pendingPull.hasNewerLocalChanges || pendingPull.reason !== 'manual-pull'}
          onCancel={() => setPendingPull(null)}
          onConfirm={() => void confirmPullSharedProject()}
        />
      )}

      {ownershipTransferProject && (
        <AppPromptDialog
          title="Transfer Ownership"
          message={ownershipTransferProject.projectName}
          label="New owner email"
          placeholder="name@example.com"
          inputMode="email"
          confirmLabel="Transfer"
          onCancel={() => setOwnershipTransferProject(null)}
          onConfirm={(value) => void confirmTransferSharedProjectOwnership(value)}
        />
      )}

      {disconnectSharedProjectConfirm && (
        <AppConfirmDialog
          title="Stop Sharing"
          message={`Stop sharing "${disconnectSharedProjectConfirm.projectName}"?\n\nThis will save a shared backup first, then disconnect this device's local copy from the shared project. If you are the owner, the shared project will be archived for everyone. Your local inspection data will stay on this device.`}
          confirmLabel={disconnectingSharedProject ? 'Stopping...' : 'Stop Sharing'}
          danger
          onCancel={() => {
            if (!disconnectingSharedProject) {
              setDisconnectSharedProjectConfirm(null);
            }
          }}
          onConfirm={() => void confirmDisconnectSharedProject()}
        />
      )}

      {deleteProjectConfirm && (
        <AppConfirmDialog
          title="Delete Project"
          message={`Delete "${deleteProjectConfirm.projectName}"?\n\nYou can restore it later from Trash.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleteProjectConfirm(null)}
          onConfirm={() => void confirmDeleteEditingProject(deleteProjectConfirm)}
        />
      )}

      {showCollaborationHealth && (
        <CollaborationHealthDialog
          report={collaborationHealthReport}
          loading={runningCollaborationHealth}
          onClose={() => setShowCollaborationHealth(false)}
          onRefresh={() => void handleRunCollaborationHealthCheck()}
        />
      )}

      {sharedMembersProject && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Shared Members</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
              {sharedMembersProject.projectName}
            </p>
            {loadingSharedMembers ? (
              <div className="flex items-center gap-3 rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading members...
              </div>
            ) : sharedMembers.length === 0 ? (
              <div className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                No shared project members found.
              </div>
            ) : (
              <div className="space-y-3">
                {sharedMembers.map((member) => (
                  <div key={`${member.projectId}:${member.email}`} className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 p-4 dark:bg-white/[0.04]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-gray-900 dark:text-white">
                          {member.displayName || member.email}
                        </div>
                        <div className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                          {member.email}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {member.isOwner && (
                          <span className="rounded-full bg-black/[0.06] px-2.5 py-1 text-[11px] font-semibold text-gray-700 dark:bg-white/[0.08] dark:text-gray-300">
                            Owner
                          </span>
                        )}
                        <span className="rounded-full bg-green-500/10 px-2.5 py-1 text-[11px] font-semibold text-green-700 dark:bg-green-400/10 dark:text-green-300">
                          {formatMemberStatus(member.accessState)}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-gray-500 dark:text-gray-400">
                      <div>{formatMemberJoinMethod(member.joinedBy)}</div>
                      <div>
                        {member.joinedAt
                          ? `Joined ${member.joinedAt.toLocaleString()}`
                          : `Invited ${member.invitedAt.toLocaleString()}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setSharedMembersProject(null);
                  setSharedMembers([]);
                }}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Done
              </button>
              <button
                onClick={() => void handleShowSharedMembers(sharedMembersProject)}
                disabled={loadingSharedMembers}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}

      <AreaEditorModal
        open={showAddArea}
        title="Add Area"
        value={newAreaForm}
        recentAreaTypeKeys={recentAreaTypeKeys}
        facadeLevelOptions={facadeLevelOptions}
        facadeElevationDrawings={areaTargetProject?.facadeElevationDrawings ?? []}
        enableFacadeLevelBatch
        onChange={setNewAreaForm}
        onClose={() => {
          setShowAddArea(false);
          setAreaTargetProjectId(null);
          setNewAreaForm(getDefaultAreaFormValue());
        }}
        onSubmit={() => void handleAddArea()}
        submitLabel="Add"
      />

      {showAreaProjectPicker && !singleProjectMainView && (
        <div className="modal-overlay fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
          <div className="w-full max-w-md pointer-events-auto">
            <div className="modal-panel rounded-[1.8rem] p-5">
              <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Choose Project</h2>
              <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">Pick the project that should receive the new area.</p>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Project
              </label>
              <select
                value={areaTargetProjectId ?? ''}
                onChange={(e) => setAreaTargetProjectId(e.target.value)}
                className="field-shell"
              >
                <option value="">Select project</option>
                {sortedProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.projectName}
                  </option>
                ))}
              </select>
              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => {
                    setShowAreaProjectPicker(false);
                    setAreaTargetProjectId(null);
                  }}
                  className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (!areaTargetProjectId) return;
                    setShowAreaProjectPicker(false);
                    setShowAddArea(true);
                  }}
                  disabled={!areaTargetProjectId}
                  className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200 disabled:opacity-50"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* New Project Modal */}
      {showNewProject && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel w-full max-w-md rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">New Project</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">Create a polished inspection workspace with the basics filled in.</p>
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Project Name *
                </label>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  className="field-shell"
                  placeholder="Enter project name"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Address
                </label>
                <input
                  type="text"
                  value={newProjectAddress}
                  onChange={(e) => setNewProjectAddress(e.target.value)}
                  className="field-shell"
                  placeholder="Enter address"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Inspected By
                </label>
                <input
                  type="text"
                  value={newProjectInspector}
                  onChange={(e) => setNewProjectInspector(e.target.value)}
                  className="field-shell"
                  placeholder="Enter inspector name"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  GC Name
                </label>
                <input
                  type="text"
                  value={newProjectGcName}
                  onChange={(e) => setNewProjectGcName(e.target.value)}
                  className="field-shell"
                  placeholder="Enter GC name"
                />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Level Range
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="number"
                    value={newProjectLevelStart}
                    onChange={(e) => setNewProjectLevelStart(e.target.value)}
                    className="field-shell"
                    placeholder="From"
                  />
                  <input
                    type="number"
                    value={newProjectLevelEnd}
                    onChange={(e) => setNewProjectLevelEnd(e.target.value)}
                    className="field-shell"
                    placeholder="To"
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowNewProject(false);
                  setNewProjectName('');
                  setNewProjectAddress('');
                  setNewProjectInspector('');
                  setNewProjectGcName('');
                  setNewProjectLevelStart('');
                  setNewProjectLevelEnd('');
                }}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim()}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {sharedProjectCode && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel w-full max-w-md rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Invite Code</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
              {sharedProjectCode.projectName}
            </p>
            <div className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-center dark:bg-white/[0.04]">
              <div className="select-all font-mono text-3xl font-semibold tracking-[0.18em] text-gray-900 dark:text-white">
                {sharedProjectCode.code}
              </div>
              <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                Expires {new Date(sharedProjectCode.expiresAt).toLocaleString()}
              </div>
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setSharedProjectCode(null)}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Done
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(sharedProjectCode.code);
                }}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}

      {showMySharedProjects && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">My Shared Projects</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
              Projects linked to your shared-project account.
            </p>
            {loadingMySharedProjects ? (
              <div className="flex items-center gap-3 rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading shared projects...
              </div>
            ) : mySharedProjects.length === 0 ? (
              <div className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                No shared projects are attached to this account yet.
              </div>
            ) : (
              <div className="space-y-3">
                {mySharedProjects.map((entry) => {
                  const localProject = projects.find((project) => project.sharedProjectId === entry.projectId);
                  const isAdding = addingSharedProjectId === entry.projectId;
                  return (
                    <div key={entry.projectId} className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 p-4 dark:bg-white/[0.04]">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-gray-900 dark:text-white">{entry.projectName}</div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {entry.ownerEmail ? `Owner: ${entry.ownerEmail}` : 'Shared project'}
                        </div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {entry.publishedAt ? `Latest shared data: ${entry.publishedAt.toLocaleString()}` : 'No shared data published yet'}
                        </div>
                      </div>
                      <button
                        onClick={() => void handleAddSharedProjectFromDirectory(entry)}
                        disabled={!!localProject || !!addingSharedProjectId}
                        className="mt-4 w-full rounded-2xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                      >
                        {localProject ? 'On this device' : isAdding ? 'Adding...' : 'Add to this device'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setShowMySharedProjects(false);
                  setMySharedProjects([]);
                }}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Done
              </button>
              <button
                onClick={() => void handleShowMySharedProjects()}
                disabled={loadingMySharedProjects}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}

      {backupProject && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel max-h-[82dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Shared Backups</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
              {backupProject.projectName}
            </p>
            {loadingSharedBackups ? (
              <div className="flex items-center gap-3 rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading backups...
              </div>
            ) : sharedBackups.length === 0 ? (
              <div className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
                No shared backups yet. Backups are created when shared data is published, pulled, or restored.
              </div>
            ) : (
              <div className="space-y-3">
                {sharedBackups.map((backup) => {
                  const isRestoring = restoringBackupId === backup.id;
                  return (
                    <div key={backup.id} className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 p-4 dark:bg-white/[0.04]">
                      <div className="text-sm font-semibold text-gray-900 dark:text-white">
                        {formatSharedBackupReason(backup.reason)}
                      </div>
                      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {backup.capturedAt.toLocaleString()}
                      </div>
                      {backup.note && (
                        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                          {backup.note}
                        </div>
                      )}
                      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <button
                          onClick={() => void handleRestoreSharedBackup(backup)}
                          disabled={!!restoringBackupId}
                          className="rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                        >
                          {isRestoring ? 'Restoring...' : 'Restore'}
                        </button>
                        <button
                          onClick={() => void handleRestoreSharedBackup(backup, true)}
                          disabled={!!restoringBackupId}
                          className="rounded-2xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                        >
                          Restore + publish
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setBackupProject(null);
                  setSharedBackups([]);
                }}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Done
              </button>
              <button
                onClick={() => backupProject && void handleShowSharedBackups(backupProject)}
                disabled={loadingSharedBackups}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}

      {showJoinProject && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="modal-panel w-full max-w-md rounded-[1.9rem] p-6">
            <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Join Shared Project</h2>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">Enter the code from the project owner.</p>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Code
            </label>
            <input
              type="text"
              value={joinProjectCode}
              onChange={(event) => setJoinProjectCode(event.target.value.toUpperCase())}
              className="field-shell font-mono tracking-[0.12em]"
              placeholder="ABC123"
              autoFocus
            />
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => {
                  setShowJoinProject(false);
                  setJoinProjectCode('');
                }}
                className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleJoinSharedProject()}
                disabled={!joinProjectCode.trim() || joiningProject}
                className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {joiningProject ? 'Joining...' : 'Join'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingProject && (
        <ProjectEditModal
          project={editingProject}
          onSave={handleEditProject}
          onDelete={singleProjectMainView ? () => void handleDeleteEditingProject() : undefined}
          onClose={() => setEditingProject(null)}
        />
      )}

      {actionSheet && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <div className="modal-panel overflow-hidden rounded-[1.8rem] p-2">
              {actionSheet === 'export-scope' ? (
                <>
                  <div className="px-4 pb-2 pt-3 text-center">
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">Export Project</div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      Choose specific areas or export every issue area in this project.
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setActionSheet(null);
                      setExportScope('selected-areas');
                      setSelectedAreaIds(new Set());
                      setSelectedProjectIds(new Set());
                      setExportMode(false);
                      setDeleteMode(true);
                    }}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] font-medium text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Select Areas
                  </button>
                  <button
                    onClick={() => {
                      if (!singleProject) return;
                      setExportScope('selected-projects');
                      setSelectedAreaIds(new Set());
                      setSelectedProjectIds(new Set([singleProject.id]));
                      setActionSheet('export');
                    }}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Export All
                  </button>
                  <button
                    onClick={() => setActionSheet(null)}
                    className="mt-1 w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Cancel
                  </button>
                </>
              ) : actionSheet === 'export' ? (
                <>
                  <div className="px-4 pb-2 pt-3 text-center">
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">Export PDF</div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {exportScope === 'selected-areas'
                        ? 'Save selected issue areas locally or to OneDrive.'
                        : 'Save this report locally or to OneDrive.'}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      if (exportScope === 'selected-areas') {
                        void handleExportSelectedAreas('onedrive');
                        return;
                      }
                      void handleExportSelected('onedrive');
                    }}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    OneDrive
                  </button>
                  <button
                    onClick={() => {
                      if (exportScope === 'selected-areas') {
                        void handleExportSelectedAreas('local');
                        return;
                      }
                      void handleExportSelected('local');
                    }}
                    className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Local
                  </button>
                  <button
                    onClick={() => setActionSheet('export-scope')}
                    className="mt-1 w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Back
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      if (singleProjectMainView) {
                        void handleDeleteSelectedAreas();
                        return;
                      }
                      void handleDeleteSelectedProjects();
                    }}
                    className="accent-text w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setActionSheet(null)}
                    className="mt-1 w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
