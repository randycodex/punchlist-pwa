import {
  checkpointHasIssue,
  getCheckpointIssueState,
  type Area,
  type Checkpoint,
  type Item,
  type Location,
} from '@/types';

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

function normalizedInspectionName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function mergeComments(left: string, right: string) {
  const comments = [left.trim(), right.trim()].filter(Boolean);
  return [...new Set(comments)].join('\n\n');
}

function mergeCheckpoint(target: Checkpoint, duplicate: Checkpoint) {
  const issuePriority = { none: 0, verified: 1, resolved: 2, open: 3 } as const;
  const targetIssue = getCheckpointIssueState(target);
  const duplicateIssue = getCheckpointIssueState(duplicate);
  const issueState = issuePriority[duplicateIssue] > issuePriority[targetIssue] ? duplicateIssue : targetIssue;

  target.issueState = issueState;
  target.status = issueState !== 'none'
    ? 'needsReview'
    : target.status === 'ok' || duplicate.status === 'ok'
      ? 'ok'
      : 'pending';
  target.fixStatus = issueState === 'verified' ? 'verified' : issueState === 'resolved' ? 'fixed' : 'pending';
  target.comments = mergeComments(target.comments, duplicate.comments);
  target.elevationMarker ??= duplicate.elevationMarker;
  target.updatedAt = new Date(Math.max(target.updatedAt.getTime(), duplicate.updatedAt.getTime()));

  const photoIds = new Set(target.photos.map((photo) => photo.id));
  target.photos.push(
    ...duplicate.photos
      .filter((photo) => !photoIds.has(photo.id))
      .map((photo) => ({ ...photo, checkpointId: target.id }))
  );
  const fileIds = new Set((target.files ?? []).map((file) => file.id));
  target.files = [
    ...(target.files ?? []),
    ...(duplicate.files ?? [])
      .filter((file) => !fileIds.has(file.id))
      .map((file) => ({ ...file, checkpointId: target.id })),
  ];
}

function dedupeCheckpoints(item: Item) {
  let changed = false;
  const checkpoints: Checkpoint[] = [];

  for (const checkpoint of item.checkpoints) {
    const match = !checkpoint.isCustom && !checkpoint.isElevationIssue
      ? checkpoints.find(
          (candidate) =>
            !candidate.isCustom &&
            !candidate.isElevationIssue &&
            normalizedInspectionName(candidate.name) === normalizedInspectionName(checkpoint.name)
        )
      : undefined;
    if (match) {
      mergeCheckpoint(match, checkpoint);
      changed = true;
    } else {
      checkpoints.push(checkpoint);
    }
  }

  item.checkpoints = checkpoints.map((checkpoint, index) => ({
    ...checkpoint,
    itemId: item.id,
    sortOrder: index,
  }));
  return changed;
}

function mergeCheckpointLists(targetItem: Item, duplicateItems: Item[]) {
  let changed = false;
  const checkpoints = [...targetItem.checkpoints];

  for (const duplicateItem of duplicateItems) {
    for (const checkpoint of duplicateItem.checkpoints) {
      const match = checkpoints.find(
        (candidate) =>
          !candidate.isCustom &&
          !candidate.isElevationIssue &&
          !checkpoint.isCustom &&
          !checkpoint.isElevationIssue &&
          normalizedInspectionName(candidate.name) === normalizedInspectionName(checkpoint.name)
      );
      if (match) {
        mergeCheckpoint(match, checkpoint);
        changed = true;
      } else {
        checkpoints.push({ ...checkpoint, itemId: targetItem.id });
      }
    }
  }

  targetItem.checkpoints = checkpoints.map((checkpoint, index) => ({
    ...checkpoint,
    itemId: targetItem.id,
    sortOrder: index,
  }));
  return dedupeCheckpoints(targetItem) || changed || duplicateItems.length > 0;
}

function dedupeItems(location: Location) {
  let changed = false;
  const items: Item[] = [];

  for (const item of location.items) {
    const match = !item.isCustom
      ? items.find(
          (candidate) =>
            !candidate.isCustom &&
            normalizedInspectionName(candidate.name) === normalizedInspectionName(item.name)
        )
      : undefined;
    if (match) {
      mergeCheckpointLists(match, [item]);
      changed = true;
    } else {
      changed = dedupeCheckpoints(item) || changed;
      items.push(item);
    }
  }

  location.items = items.map((item, index) => ({
    ...item,
    locationId: location.id,
    sortOrder: index,
  }));
  return changed;
}

function mergeItemLists(targetLocation: Location, duplicateLocations: Location[]) {
  targetLocation.items.push(...duplicateLocations.flatMap((location) => location.items));
  return dedupeItems(targetLocation) || duplicateLocations.length > 0;
}

export function dedupeInspectionHierarchy(area: Area) {
  let changed = false;
  const locations: Location[] = [];

  for (const location of area.locations) {
    const match = !location.isCustom
      ? locations.find(
          (candidate) =>
            !candidate.isCustom &&
            normalizedInspectionName(candidate.name) === normalizedInspectionName(location.name)
        )
      : undefined;
    if (match) {
      mergeItemLists(match, [location]);
      changed = true;
      continue;
    }
    changed = dedupeItems(location) || changed;
    locations.push(location);
  }

  area.locations = locations.map((location, index) => ({
    ...location,
    areaId: area.id,
    sortOrder: index,
  }));
  return changed;
}

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
