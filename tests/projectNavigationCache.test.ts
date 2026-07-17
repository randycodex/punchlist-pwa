import { expect, it } from 'vitest';
import {
  cacheProjectPreview,
  getCachedProjectName,
  getCachedProjectPreview,
  removeCachedProjectPreview,
} from '@/lib/projectNavigationCache';
import { createArea, createProject } from '@/lib/db';

it('reuses an unchanged cached source without rebuilding its hierarchy', () => {
  const project = createProject('Cached project');
  const area = createArea(project.id, 'Area 1', 0);
  const locations = area.locations;
  let hierarchyReadCount = 0;

  Object.defineProperty(area, 'locations', {
    configurable: true,
    enumerable: true,
    get() {
      hierarchyReadCount += 1;
      return locations;
    },
  });
  project.areas.push(area);

  cacheProjectPreview(project);
  const readsAfterFirstCache = hierarchyReadCount;
  cacheProjectPreview(project);

  expect(hierarchyReadCount).toBe(readsAfterFirstCache);
  expect(getCachedProjectName(project.id)).toBe('Cached project');

  project.updatedAt = new Date(project.updatedAt.getTime() + 1_000);
  cacheProjectPreview(project);
  expect(hierarchyReadCount).toBeGreaterThan(readsAfterFirstCache);

  const preview = getCachedProjectPreview(project.id);
  expect(preview?.projectName).toBe('Cached project');
  removeCachedProjectPreview(project.id);
});
