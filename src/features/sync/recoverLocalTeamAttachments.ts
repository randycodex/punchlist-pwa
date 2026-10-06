import { getProjectMetadata, getUnreadableAttachmentIds, restoreUnreadableAttachments } from '@/lib/db';
import { getSharedAttachmentRecoveryCopies } from '@/lib/collaboration/sharedProjectSnapshots';

export async function recoverLocalTeamAttachments(projectId: string, canApply: () => boolean, areaId?: string) {
  const project = await getProjectMetadata(projectId);
  if (!project?.sharedProjectId || !canApply()) return false;
  const ids = await getUnreadableAttachmentIds(projectId, areaId);
  if (!ids.length || !canApply()) return false;
  const copies = await getSharedAttachmentRecoveryCopies(project, ids, areaId);
  if (!canApply()) return false;
  return await restoreUnreadableAttachments(projectId, copies, canApply, areaId) > 0;
}
