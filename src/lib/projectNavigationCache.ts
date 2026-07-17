import type { Project } from '@/types';

const projectPreviewCache = new Map<string, Project>();
const cachedSourceVersions = new WeakMap<Project, string>();

function dateValue(value: Date | undefined) {
  return value?.getTime() ?? null;
}

function getProjectCacheVersion(project: Project) {
  return JSON.stringify([
    project.projectName,
    project.sharedProjectId,
    dateValue(project.updatedAt),
    dateValue(project.deletedAt),
    dateValue(project.sharedSnapshotPublishedAt),
  ]);
}

function cloneProjectPreview(project: Project): Project {
  return {
    ...project,
    facadeElevationDrawings: project.facadeElevationDrawings?.map((drawing) => ({ ...drawing })),
    areas: project.areas.map((area) => ({
      ...area,
      locations: area.locations.map((location) => ({
        ...location,
        items: location.items.map((item) => ({
          ...item,
          checkpoints: item.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            photos: checkpoint.photos.map((photo) => ({
              ...photo,
              imageData: '',
              thumbnail: undefined,
            })),
            files: (checkpoint.files ?? []).map((file) => ({
              ...file,
              data: '',
            })),
          })),
        })),
      })),
    })),
  };
}

export function cacheProjectPreview(project: Project) {
  const version = getProjectCacheVersion(project);
  if (projectPreviewCache.has(project.id) && cachedSourceVersions.get(project) === version) {
    return;
  }
  projectPreviewCache.set(project.id, cloneProjectPreview(project));
  cachedSourceVersions.set(project, version);
}

export function cacheProjectPreviews(projects: Project[]) {
  projects.forEach(cacheProjectPreview);
}

export function replaceProjectPreviewCache(projects: Project[]) {
  projectPreviewCache.clear();
  cacheProjectPreviews(projects);
}

export function removeCachedProjectPreview(projectId: string) {
  projectPreviewCache.delete(projectId);
}

export function getCachedProjectPreview(projectId: string): Project | null {
  const project = projectPreviewCache.get(projectId);
  return project ? cloneProjectPreview(project) : null;
}

export function getCachedProjectName(projectId: string): string | null {
  return projectPreviewCache.get(projectId)?.projectName ?? null;
}

export function getCachedProjectPreviews(): Project[] {
  return Array.from(projectPreviewCache.values()).map(cloneProjectPreview);
}
