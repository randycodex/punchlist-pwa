import { getProject, saveProjectMetadataOnly } from '@/lib/db';
import { isSharedProjectPublishConflictError, publishSharedProjectSnapshot } from '@/lib/collaboration';
import type { Project } from '@/types';

type PublishItem = {
  projectId: string;
  userId: string;
};

type PublishCandidate = Pick<Project, 'id' | 'sharedProjectId' | 'sharedSnapshotPublishedAt' | 'updatedAt' | 'deletedAt'>;

const INITIAL_PUBLISH_DELAY_MS = 1_200;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;
const SHARED_PUBLISH_CLOCK_SKEW_MS = 2_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingItems = new Map<string, PublishItem>();
const retryCounts = new Map<string, number>();

function clearProjectTimer(projectId: string) {
  const timer = timers.get(projectId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(projectId);
  }
}

function schedulePublish(projectId: string, delayMs: number) {
  clearProjectTimer(projectId);
  const timer = setTimeout(() => {
    timers.delete(projectId);
    void publishProject(projectId);
  }, delayMs);
  timers.set(projectId, timer);
}

function sharedProjectNeedsPublish(project: PublishCandidate) {
  if (!project.sharedProjectId || project.deletedAt) return false;

  const updatedMs = new Date(project.updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) return false;

  const publishedAt = project.sharedSnapshotPublishedAt;
  if (!publishedAt) return true;

  const publishedMs = new Date(publishedAt).getTime();
  if (!Number.isFinite(publishedMs)) return true;

  return updatedMs > publishedMs + SHARED_PUBLISH_CLOCK_SKEW_MS;
}

async function publishProject(projectId: string) {
  const item = pendingItems.get(projectId);
  if (!item) return;

  try {
    const project = await getProject(projectId);
    if (!project?.sharedProjectId) {
      pendingItems.delete(projectId);
      retryCounts.delete(projectId);
      return;
    }

    await publishSharedProjectSnapshot(project, item.userId);
    await saveProjectMetadataOnly(project, { touch: false });
    pendingItems.delete(projectId);
    retryCounts.delete(projectId);
  } catch (error) {
    if (isSharedProjectPublishConflictError(error)) {
      pendingItems.delete(projectId);
      retryCounts.delete(projectId);
      console.info('Shared publish skipped because newer shared data exists:', error);
      return;
    }

    const retryCount = (retryCounts.get(projectId) ?? 0) + 1;
    retryCounts.set(projectId, retryCount);
    const retryDelayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** (retryCount - 1), RETRY_MAX_DELAY_MS);
    console.info('Shared publish deferred; retrying in background:', error);
    schedulePublish(projectId, retryDelayMs);
  }
}

export function queueBackgroundSharedProjectPublish(options: {
  projectId: string;
  userId: string;
  delayMs?: number;
}) {
  pendingItems.set(options.projectId, {
    projectId: options.projectId,
    userId: options.userId,
  });
  retryCounts.delete(options.projectId);
  schedulePublish(options.projectId, options.delayMs ?? INITIAL_PUBLISH_DELAY_MS);
}

export function queueStaleBackgroundSharedProjectPublishes(options: {
  projects: PublishCandidate[];
  userId: string;
  delayMs?: number;
}) {
  for (const project of options.projects) {
    if (!sharedProjectNeedsPublish(project)) continue;
    queueBackgroundSharedProjectPublish({
      projectId: project.id,
      userId: options.userId,
      delayMs: options.delayMs,
    });
  }
}

export function resetBackgroundSharedProjectPublish() {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
  pendingItems.clear();
  retryCounts.clear();
}
