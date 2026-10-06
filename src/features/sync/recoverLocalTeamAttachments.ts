import { getProjectMetadata, getUnreadableAttachments, restoreUnreadableAttachments } from '@/lib/db';
import { getSharedAttachmentRecoveryCopies } from '@/lib/collaboration/sharedProjectSnapshots';

export async function recoverLocalTeamAttachments(projectId: string, canApply: () => boolean, areaId?: string) {
  let stage = 'checking the local attachment records';
  try {
    const project = await getProjectMetadata(projectId);
    if (!project?.sharedProjectId || !canApply()) return false;
    const unreadable = await getUnreadableAttachments(projectId, areaId);
    const ids = [...new Set(unreadable.map((entry) => entry.id))];
    if (!ids.length || !canApply()) return false;
    stage = 'downloading matching Team attachments';
    const copies = await getSharedAttachmentRecoveryCopies(project, ids, areaId, unreadable);
    if (!canApply()) return false;
    stage = 'preserving the original records and saving recovered attachments';
    return await restoreUnreadableAttachments(projectId, copies, canApply, areaId) > 0;
  } catch (error) {
    const detail = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message : 'The request did not finish.';
    throw new Error(`Could not finish attachment recovery while ${stage}. ${detail}`, { cause: error });
  }
}
