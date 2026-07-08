import { getProject, saveProjectMetadataOnly } from '@/lib/db';
import { publishSharedProjectSnapshot } from '@/lib/collaboration';

type PublishItem = {
  projectId: string;
  userId: string;
};

const INITIAL_PUBLISH_DELAY_MS = 1_200;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;

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

export function resetBackgroundSharedProjectPublish() {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
  pendingItems.clear();
  retryCounts.clear();
}
