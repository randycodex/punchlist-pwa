import type { Project } from '@/types';

type SharedProjectIdentity = {
  projectId: string;
  localProjectId?: string | null;
};

export function findPreferredLocalSharedProject(
  projects: readonly Project[],
  entry: SharedProjectIdentity
): Project | undefined {
  return projects.find((project) => !project.deletedAt && project.sharedProjectId === entry.projectId)
    ?? projects.find((project) => !project.deletedAt && project.id === entry.localProjectId)
    ?? projects.find((project) => project.sharedProjectId === entry.projectId)
    ?? projects.find((project) => project.id === entry.localProjectId);
}

export function getSharedProjectDirectoryLocalStatus(
  project: Project | undefined,
  entry: SharedProjectIdentity
) {
  const isLinkedOnDevice = project?.sharedProjectId === entry.projectId;
  const isInTrash = Boolean(project?.deletedAt);
  return {
    isLinkedOnDevice,
    isInTrash,
    needsReconnect: Boolean(project && !isInTrash && !isLinkedOnDevice),
  };
}

export function getInactiveLocalSharedProjects(
  projects: readonly Project[],
  activeEntries: readonly SharedProjectIdentity[]
): Project[] {
  const activeIds = new Set(activeEntries.map((entry) => entry.projectId));
  const inactive = new Map<string, Project>();
  for (const project of projects) {
    if (project.deletedAt || !project.sharedProjectId || activeIds.has(project.sharedProjectId)) continue;
    if (!inactive.has(project.sharedProjectId)) inactive.set(project.sharedProjectId, project);
  }
  return [...inactive.values()];
}
