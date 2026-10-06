import { getActiveProjectCount, getProjectForArea } from '@/lib/db';

export class AreaUnavailableError extends Error {}

export async function loadInspectionArea(projectId: string, areaId: string) {
  const [project, returnToHome] = await Promise.all([
    getProjectForArea(projectId, areaId),
    // A count affects only the Back button. Its failure must not prevent
    // opening an otherwise readable inspection.
    getActiveProjectCount().then((count) => count === 1).catch((error) => {
      console.info('Project count unavailable; Back will open the project:', error);
      return false;
    }),
  ]);
  if (!project) throw new AreaUnavailableError('This project is not saved in this browser. Open the project list and sync the project with the same account.');
  if (project.deletedAt) throw new AreaUnavailableError('This project is in Trash on this device. Restore it from the project list before opening its areas.');
  const area = project.areas.find((entry) => entry.id === areaId);
  if (!area || area.deletedAt) throw new AreaUnavailableError('This area is not available in this browser’s copy of the project. Check the project’s Trash or get the latest team updates.');
  return { project, area, returnToHome };
}
