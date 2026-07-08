import type { Project } from '@/types';
import { getProject } from '@/lib/db';
import { hydrateProjectMediaFromOneDrive } from '@/lib/oneDriveSync';

type HydrationCandidate = Pick<Project, 'id' | 'updatedAt' | 'deletedAt'>;

type QueueItem = {
  projectId: string;
  projectKey: string;
  retryCount: number;
  generation: number;
  getAccessToken: () => Promise<string | null>;
  onProjectHydrated?: (project: Project) => void;
};

const HYDRATION_RETRY_BASE_DELAY_MS = 15_000;
const HYDRATION_RETRY_MAX_DELAY_MS = 120_000;
const HYDRATION_MAX_RETRY_COUNT = 8;

const queuedProjectKeys = new Set<string>();
const completedProjectKeys = new Set<string>();
const queue: QueueItem[] = [];
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let processing = false;
let queueGeneration = 0;

function getProjectKey(accountKey: string, project: HydrationCandidate) {
  const updatedAt = project.updatedAt instanceof Date
    ? project.updatedAt.getTime()
    : new Date(project.updatedAt).getTime();
  return `${accountKey}:${project.id}:${Number.isFinite(updatedAt) ? updatedAt : 0}`;
}

function projectNeedsPhotoHydration(project: Project) {
  for (const area of project.areas ?? []) {
    for (const location of area.locations ?? []) {
      for (const item of location.items ?? []) {
        for (const checkpoint of item.checkpoints ?? []) {
          if ((checkpoint.photos ?? []).some((photo) => !photo.imageData)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function isCurrentItem(item: QueueItem) {
  return item.generation === queueGeneration && queuedProjectKeys.has(item.projectKey);
}

function clearRetryTimer(projectKey: string) {
  const retryTimer = retryTimers.get(projectKey);
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimers.delete(projectKey);
}

function finishProject(item: QueueItem, completed: boolean) {
  if (item.generation !== queueGeneration) return;
  clearRetryTimer(item.projectKey);
  queuedProjectKeys.delete(item.projectKey);
  if (completed) {
    completedProjectKeys.add(item.projectKey);
  }
}

function getRetryDelayMs(retryCount: number) {
  return Math.min(
    HYDRATION_RETRY_BASE_DELAY_MS * (2 ** Math.max(retryCount - 1, 0)),
    HYDRATION_RETRY_MAX_DELAY_MS
  );
}

function scheduleRetry(item: QueueItem, reason: string, error?: unknown) {
  if (!isCurrentItem(item)) return;

  const retryCount = item.retryCount + 1;
  if (retryCount > HYDRATION_MAX_RETRY_COUNT) {
    finishProject(item, false);
    if (error === undefined) {
      console.info(`Background photo hydration deferred after retries: ${reason}`);
    } else {
      console.info(`Background photo hydration deferred after retries: ${reason}`, error);
    }
    return;
  }

  const retryItem: QueueItem = { ...item, retryCount };
  const retryDelayMs = getRetryDelayMs(retryCount);
  clearRetryTimer(item.projectKey);
  const retryTimer = setTimeout(() => {
    retryTimers.delete(retryItem.projectKey);
    if (!isCurrentItem(retryItem)) return;
    queue.push(retryItem);
    void processQueue();
  }, retryDelayMs);
  retryTimers.set(item.projectKey, retryTimer);
}

async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (!isCurrentItem(item)) continue;

      try {
        const localProject = await getProject(item.projectId);
        if (!isCurrentItem(item)) continue;
        if (!localProject || localProject.deletedAt || !projectNeedsPhotoHydration(localProject)) {
          finishProject(item, true);
          continue;
        }

        const token = await item.getAccessToken();
        if (!isCurrentItem(item)) continue;
        if (!token) {
          scheduleRetry(item, 'silent token unavailable');
          continue;
        }

        const hydratedProject = await hydrateProjectMediaFromOneDrive(token, item.projectId);
        if (!isCurrentItem(item)) continue;
        if (hydratedProject) {
          item.onProjectHydrated?.(hydratedProject);
        }
        finishProject(item, true);
      } catch (error) {
        scheduleRetry(item, 'OneDrive media fetch failed', error);
      }
    }
  } finally {
    processing = false;
  }
}

export function queueBackgroundProjectMediaHydration(options: {
  accountKey: string;
  projects: HydrationCandidate[];
  getAccessToken: () => Promise<string | null>;
  onProjectHydrated?: (project: Project) => void;
}) {
  for (const project of options.projects) {
    if (project.deletedAt) continue;

    const projectKey = getProjectKey(options.accountKey, project);
    if (completedProjectKeys.has(projectKey) || queuedProjectKeys.has(projectKey)) {
      continue;
    }

    queuedProjectKeys.add(projectKey);
    queue.push({
      projectId: project.id,
      projectKey,
      retryCount: 0,
      generation: queueGeneration,
      getAccessToken: options.getAccessToken,
      onProjectHydrated: options.onProjectHydrated,
    });
  }

  void processQueue();
}

export function resetBackgroundMediaHydration() {
  queueGeneration += 1;
  for (const retryTimer of retryTimers.values()) {
    clearTimeout(retryTimer);
  }
  retryTimers.clear();
  queuedProjectKeys.clear();
  completedProjectKeys.clear();
  queue.length = 0;
}
