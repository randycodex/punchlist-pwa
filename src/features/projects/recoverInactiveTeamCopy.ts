import type { Project } from '@/types';

/** Keep an orphaned device copy under its own identity before restoring a personal backup. */
export function recoverInactiveTeamCopy(project: Project): Project {
  const id = crypto.randomUUID();
  const drawingIds = new Map(
    (project.facadeElevationDrawings ?? []).map((drawing) => [drawing.id, crypto.randomUUID()])
  );
  const recovered: Project = {
    ...project,
    id,
    projectName: `Recovered local copy - ${project.projectName}`,
    recoveredFromProjectId: project.id,
    updatedAt: new Date(),
    facadeElevationDrawings: project.facadeElevationDrawings?.map((drawing) => ({
      ...drawing,
      id: drawingIds.get(drawing.id) ?? drawing.id,
    })),
    areas: project.areas.map((area) => ({
      ...area,
      projectId: id,
      elevationDrawingId: area.elevationDrawingId
        ? drawingIds.get(area.elevationDrawingId) ?? area.elevationDrawingId
        : undefined,
      locations: area.locations.map((location) => ({
        ...location,
        items: location.items.map((item) => ({
          ...item,
          checkpoints: item.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            elevationMarker: checkpoint.elevationMarker
              ? {
                  ...checkpoint.elevationMarker,
                  drawingId: drawingIds.get(checkpoint.elevationMarker.drawingId)
                    ?? checkpoint.elevationMarker.drawingId,
                }
              : undefined,
          })),
        })),
      })),
    })),
  };
  delete recovered.sharedProjectId;
  delete recovered.sharedProjectLinkedAt;
  delete recovered.sharedSnapshotPublishedAt;
  delete recovered.sharedBaselinePublishedAt;
  delete recovered.sharedMetadataVersion;
  delete recovered.sharedMetadataPublishedAt;
  delete recovered.detachedSharedProjectId;
  delete recovered.detachedSharedProjectAt;
  delete recovered.detachedSharedSnapshotPublishedAt;
  delete recovered.oneDriveFolderName;
  delete recovered.deletedAt;
  for (const area of recovered.areas) {
    delete area.sharedVersion;
    delete area.sharedPublishedAt;
  }
  return recovered;
}
