import { getProjectMetadata } from '@/lib/db';
import { checkpointHasIssue, type Project } from '@/types';
import { loadAreaWithRecoveredMedia } from '@/features/sync/loadAreaWithRecoveredMedia';

/** Read only the requested report scope; unrelated broken media cannot block it. */
export async function loadProjectForExport(projectId: string, mode: 'full' | 'issues', areaIds?: string[]): Promise<Project> {
  const metadata = await getProjectMetadata(projectId);
  if (!metadata || metadata.deletedAt) throw new Error('This project is not available for export on this device.');
  const selected = areaIds ? new Set(areaIds) : undefined;
  const areas = [];
  const drawings = new Map((metadata.facadeElevationDrawings ?? []).map((drawing) => [drawing.id, drawing]));
  for (const area of metadata.areas) {
    if (area.deletedAt || (selected && !selected.has(area.id))) continue;
    const checkpointIds = mode === 'issues' ? new Set(area.locations.flatMap((room) => room.items.flatMap((item) =>
      item.checkpoints.filter((checkpoint) => checkpoint.status === 'needsReview' && checkpointHasIssue(checkpoint)).map((checkpoint) => checkpoint.id)))) : undefined;
    if (checkpointIds && !checkpointIds.size) { areas.push(area); continue; }
    try {
      const loaded = await loadAreaWithRecoveredMedia(projectId, area.id, { checkpointIds, includeFileData: false });
      const currentArea = loaded?.areas.find((entry) => entry.id === area.id && !entry.deletedAt);
      if (!currentArea) throw new Error('The selected area changed while its photos were loading. Retry the export.');
      areas.push(currentArea);
      for (const drawing of loaded?.facadeElevationDrawings ?? []) {
        if (drawing.dataUrl) drawings.set(drawing.id, drawing);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The saved photos could not be read.';
      throw new Error(`Could not export ${area.name}. ${message} Your saved work was kept.`, { cause: error });
    }
  }
  return { ...metadata, areas, facadeElevationDrawings: [...drawings.values()] };
}
