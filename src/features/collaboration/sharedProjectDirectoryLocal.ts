import type { Project } from '@/types';
import { findDetachedSharedProject } from './detachedSharedProject';

type SharedProjectIdentity = {
  projectId: string;
  localProjectId?: string | null;
};

export function findPreferredLocalSharedProject(
  projects: readonly Project[],
  entry: SharedProjectIdentity
): Project | undefined {
  return projects.find((project) => !project.deletedAt && project.sharedProjectId === entry.projectId)
    ?? projects.find((project) => !project.deletedAt && project.detachedSharedProjectId === entry.projectId)
    ?? projects.find((project) => !project.deletedAt && project.id === entry.localProjectId && Boolean(project.sharedProjectId))
    ?? projects.find((project) => project.sharedProjectId === entry.projectId);
}

export function planSharedProjectJoin(
  projects: readonly Project[],
  sharedProjectId: string,
  localProjectId?: string,
  allowReconnect = false
) {
  const detachedProject = findDetachedSharedProject(projects, sharedProjectId);
  const requestedProject = localProjectId
    ? projects.find((project) => project.id === localProjectId)
    : undefined;
  const matchingLocalProject = requestedProject && !requestedProject.deletedAt
    ? requestedProject
    : undefined;
  const linkedElsewhere = Boolean(
    matchingLocalProject?.sharedProjectId
    && matchingLocalProject.sharedProjectId !== sharedProjectId
  );
  const reconnectProject = allowReconnect && linkedElsewhere ? matchingLocalProject : undefined;
  return {
    detachedProject,
    reusableProject: detachedProject ?? reconnectProject,
    isReconnecting: Boolean(reconnectProject && !detachedProject),
    needsExplicitReconnect: linkedElsewhere && !allowReconnect && !detachedProject,
    requestedIdAvailable: !requestedProject,
  };
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
