import type { Project } from '@/types';

export function findDetachedSharedProject(
  projects: Project[],
  sharedProjectId: string
): Project | undefined {
  return projects.find((project) =>
    !project.deletedAt
    && !project.sharedProjectId
    && project.detachedSharedProjectId === sharedProjectId
  );
}

export function clearDetachedSharedProjectMetadata(project: Project): Project {
  const nextProject: Project = { ...project, areas: [...project.areas] };
  delete nextProject.detachedSharedProjectId;
  delete nextProject.detachedSharedProjectAt;
  delete nextProject.detachedSharedSnapshotPublishedAt;
  return nextProject;
}

export function detachLocalSharedProject(
  project: Project,
  detachedAt = new Date()
): Project {
  const nextProject: Project = {
    ...project,
    areas: [...project.areas],
    detachedSharedProjectId: project.sharedProjectId ?? project.detachedSharedProjectId,
    detachedSharedProjectAt: detachedAt,
    detachedSharedSnapshotPublishedAt: project.sharedSnapshotPublishedAt,
  };
  delete nextProject.sharedProjectId;
  delete nextProject.sharedProjectLinkedAt;
  delete nextProject.sharedSnapshotPublishedAt;
  return nextProject;
}

export function relinkDetachedSharedProject(
  project: Project,
  sharedProjectId: string,
  linkedAt = new Date()
): Project {
  const nextProject = clearDetachedSharedProjectMetadata(project);
  nextProject.sharedProjectId = sharedProjectId;
  nextProject.sharedProjectLinkedAt = linkedAt;
  nextProject.sharedSnapshotPublishedAt = project.detachedSharedSnapshotPublishedAt;
  return nextProject;
}
