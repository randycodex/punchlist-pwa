import { getActiveProjectCount, getProjectForArea, getProjectForAreaPreview, type UnreadableAttachment } from '@/lib/db';
import { getLocalMediaRecoveryMessage } from '@/lib/localMediaRecovery';

export class AreaUnavailableError extends Error {}

export async function loadInspectionArea(projectId: string, areaId: string) {
  const readArea = async () => {
    try { return { project: await getProjectForArea(projectId, areaId), unreadableAttachments: [] as UnreadableAttachment[], mediaError: undefined as Error | undefined }; }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('opening saved photos and files')) throw error;
      const preview = await getProjectForAreaPreview(projectId, areaId);
      const recovery = getLocalMediaRecoveryMessage(projectId, areaId);
      return { ...preview, mediaError: preview.unreadableAttachments.length
        ? new Error(`${error.message}${recovery ? ` ${recovery}` : ''}`, { cause: error }) : undefined };
    }
  };
  const [{ project, unreadableAttachments, mediaError }, returnToHome] = await Promise.all([
    readArea(),
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
  return { project, area, returnToHome, unreadableAttachments, mediaError };
}
