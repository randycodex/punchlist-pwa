import { checkpointHasIssue, type Area, type Checkpoint } from '@/types';

export const CUSTOM_ITEMS_LOCATION_NAME = 'Custom Items';
export const OTHER_LOCATION_NAME = 'Other';

const REQUIRED_FACADE_ITEM_NAMES = [
  'Doors',
  'Storefront',
  'Planting',
  'Light Fixture',
  'Security Camera',
  'Fence',
  'Signage',
  'Canopy',
  'Louvers',
];

export function locationHasRecordedActivity(location: Area['locations'][number]) {
  return location.items.some((item) =>
    item.checkpoints.some(
      (checkpoint) =>
        checkpoint.status !== 'pending' ||
        checkpoint.comments.trim().length > 0 ||
        Boolean(checkpoint.elevationMarker) ||
        checkpoint.photos.length > 0 ||
        (checkpoint.files?.length ?? 0) > 0
    )
  );
}

export function checkpointHasStoredMedia(checkpoint: Checkpoint) {
  return checkpoint.photos.length > 0 || (checkpoint.files?.length ?? 0) > 0;
}

export function itemHasStoredMedia(item: Area['locations'][number]['items'][number]) {
  return item.checkpoints.some(checkpointHasStoredMedia);
}

export function locationHasStoredMedia(location: Area['locations'][number]) {
  return location.items.some(itemHasStoredMedia);
}

export function checkpointHasFacadeListContent(checkpoint: Checkpoint, drawingId?: string) {
  const hasComments = checkpoint.comments.trim().length > 0;
  const hasMedia = checkpointHasStoredMedia(checkpoint);

  if (checkpoint.isElevationIssue) {
    const matchesDrawing = !drawingId || checkpoint.elevationMarker?.drawingId === drawingId;
    return matchesDrawing && (checkpointHasIssue(checkpoint) || hasComments || hasMedia);
  }

  return (
    checkpoint.status !== 'pending' ||
    checkpointHasIssue(checkpoint) ||
    hasComments ||
    hasMedia ||
    Boolean(checkpoint.elevationMarker)
  );
}

export function locationHasFacadeListContent(
  location: Area['locations'][number],
  drawingId?: string
) {
  return location.items.some((item) =>
    item.checkpoints.some((checkpoint) => checkpointHasFacadeListContent(checkpoint, drawingId))
  );
}

export function facadeAreaNeedsTemplateRefresh(area: Area) {
  if (area.areaTypeKey !== 'facade') return false;
  const standardLocations = area.locations.filter(
    (location) =>
      !location.isCustom &&
      location.name.trim().toLowerCase() !== CUSTOM_ITEMS_LOCATION_NAME.toLowerCase() &&
      location.name.trim().toLowerCase() !== OTHER_LOCATION_NAME.toLowerCase()
  );
  if (standardLocations.length === 0) return false;

  return standardLocations.some((location) => {
    const itemNames = new Set(location.items.map((item) => item.name));
    return REQUIRED_FACADE_ITEM_NAMES.some((itemName) => !itemNames.has(itemName));
  });
}
