import type { Area } from '@/types';
import { checkpointHasIssue } from '@/types';

export type ElevationMarkerReference = {
  checkpointId: string;
  markerKey: string;
  drawingId: string;
  xPercent: number;
  yPercent: number;
  sectionName: string;
  itemName: string;
  checkpointName: string;
};

type BuildElevationMarkerOptions = {
  drawingId?: string;
  issuesOnly?: boolean;
};

function checkpointShouldUseMarker(
  checkpoint: Area['locations'][number]['items'][number]['checkpoints'][number],
  issuesOnly: boolean
) {
  if (!checkpoint.elevationMarker) return false;
  if (!issuesOnly) return true;
  return checkpoint.status === 'needsReview' && checkpointHasIssue(checkpoint);
}

export function buildElevationMarkerReferences(
  area: Pick<Area, 'locations' | 'elevationDrawingId'>,
  options: BuildElevationMarkerOptions = {}
) {
  const drawingId = options.drawingId ?? area.elevationDrawingId;
  if (!drawingId) return [];

  const issuesOnly = options.issuesOnly ?? true;
  const seenCheckpointIds = new Set<string>();
  const references: ElevationMarkerReference[] = [];

  for (const location of area.locations) {
    for (const item of location.items) {
      for (const checkpoint of item.checkpoints) {
        if (seenCheckpointIds.has(checkpoint.id)) continue;
        seenCheckpointIds.add(checkpoint.id);
        if (!checkpointShouldUseMarker(checkpoint, issuesOnly)) continue;
        if (checkpoint.elevationMarker?.drawingId !== drawingId) continue;

        references.push({
          checkpointId: checkpoint.id,
          markerKey: `E${references.length + 1}`,
          drawingId,
          xPercent: checkpoint.elevationMarker.xPercent,
          yPercent: checkpoint.elevationMarker.yPercent,
          sectionName: location.name,
          itemName: item.name,
          checkpointName: checkpoint.name,
        });
      }
    }
  }

  return references;
}

export function buildElevationMarkerReferenceMap(
  area: Pick<Area, 'locations' | 'elevationDrawingId'>,
  options: BuildElevationMarkerOptions = {}
) {
  return new Map(
    buildElevationMarkerReferences(area, options).map((reference) => [
      reference.checkpointId,
      reference,
    ])
  );
}
