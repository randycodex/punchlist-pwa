import { getProjectForArea, getProjectForAreaPreview } from '@/lib/db';
import { getSharedAttachmentRecoveryCopies } from '@/lib/collaboration/sharedProjectSnapshots';

/** Read in memory for sync/export; never replace original local attachment records. */
export async function loadAreaWithRecoveredMedia(projectId: string, areaId: string, options: { checkpointIds?: ReadonlySet<string>; includeFileData?: boolean } = {}) {
  try { return await getProjectForArea(projectId, areaId); }
  catch (originalError) {
    if (!(originalError instanceof Error) || !originalError.message.includes('opening saved photos and files')) throw originalError;
    try {
      const preview = await getProjectForAreaPreview(projectId, areaId);
      const { project } = preview;
      const unreadableAttachments = preview.unreadableAttachments.filter((entry) =>
        (entry.kind !== 'file' || options.includeFileData !== false)
        && (!options.checkpointIds || options.checkpointIds.has(entry.checkpointId)));
      if (!project || !unreadableAttachments.length) return project;
      if (!project.sharedProjectId) throw originalError;
      const ids = [...new Set(unreadableAttachments.map((entry) => entry.id))];
      const copies = await getSharedAttachmentRecoveryCopies(project, ids, areaId, unreadableAttachments);
      const remoteByCheckpoint = new Map(copies.areas.flatMap((area) => area.locations.flatMap((room) =>
        room.items.flatMap((item) => item.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint] as const)))));
      const missing = new Set(unreadableAttachments.map((entry) => `${entry.kind}:${entry.id}`));
      const area = project.areas.find((entry) => entry.id === areaId);
      if (!area) return project;
      for (const room of area.locations) for (const item of room.items) for (const checkpoint of item.checkpoints) {
        const remote = remoteByCheckpoint.get(checkpoint.id);
        for (const photo of checkpoint.photos) {
          const saved = remote?.photos.find((entry) => entry.id === photo.id && entry.checkpointId === checkpoint.id
            && new Date(entry.createdAt).getTime() === new Date(photo.createdAt).getTime());
          if (missing.has(`photo:${photo.id}`) && saved?.imageData) {
            photo.imageData = saved.imageData; missing.delete(`photo:${photo.id}`);
          }
          if (missing.has(`thumbnail:${photo.id}`) && photo.imageData) {
            photo.thumbnail = saved?.thumbnail || photo.imageData; missing.delete(`thumbnail:${photo.id}`);
          }
        }
        for (const file of checkpoint.files ?? []) {
          const saved = remote?.files.find((entry) => entry.id === file.id && entry.checkpointId === checkpoint.id
            && entry.size === file.size && entry.mimeType === file.mimeType
            && new Date(entry.createdAt).getTime() === new Date(file.createdAt).getTime());
          if (missing.has(`file:${file.id}`) && saved?.data) {
            file.data = saved.data; missing.delete(`file:${file.id}`);
          }
        }
      }
      if (missing.size) throw new Error(`${missing.size} attachment(s) still need recovery. The original files and pending changes were kept.`);
      // Only attachment bytes above change in this temporary copy. The existing
      // versioned send and acknowledgement retain concurrent edits and queues.
      return project;
    } catch (error) {
      const detail = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message : 'The Team attachment copy could not be read.';
      throw new Error(`${originalError.message} Could not prepare this area's attachments. ${detail}`, { cause: error });
    }
  }
}
