import type { Project } from '@/types';

const projectPreviewCache = new Map<string, Project>();

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
  projectPreviewCache.set(project.id, cloneProjectPreview(project));
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

export function getCachedProjectPreviews(): Project[] {
  return Array.from(projectPreviewCache.values()).map(cloneProjectPreview);
}
