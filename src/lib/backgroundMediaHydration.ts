import type { Project } from '@/types';
import { getProject } from '@/lib/db';
import { hydrateProjectMediaFromOneDrive } from '@/lib/oneDriveSync';

type HydrationCandidate = Pick<Project, 'id' | 'updatedAt' | 'deletedAt'>;

type QueueItem = {
  projectId: string;
  projectKey: string;
  getAccessToken: () => Promise<string | null>;
  onProjectHydrated?: (project: Project) => void;
};

const queuedProjectKeys = new Set<string>();
const completedProjectKeys = new Set<string>();
const queue: QueueItem[] = [];
let processing = false;

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

async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      queuedProjectKeys.delete(item.projectKey);

      try {
        const localProject = await getProject(item.projectId);
        if (!localProject || localProject.deletedAt || !projectNeedsPhotoHydration(localProject)) {
          completedProjectKeys.add(item.projectKey);
          continue;
        }

        const token = await item.getAccessToken();
        if (!token) {
          continue;
        }

        const hydratedProject = await hydrateProjectMediaFromOneDrive(token, item.projectId);
        if (hydratedProject) {
          completedProjectKeys.add(item.projectKey);
          item.onProjectHydrated?.(hydratedProject);
        }
      } catch (error) {
        console.info('Background photo hydration skipped:', error);
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
      getAccessToken: options.getAccessToken,
      onProjectHydrated: options.onProjectHydrated,
    });
  }

  void processQueue();
}

export function resetBackgroundMediaHydration() {
  queuedProjectKeys.clear();
  completedProjectKeys.clear();
  queue.length = 0;
}
