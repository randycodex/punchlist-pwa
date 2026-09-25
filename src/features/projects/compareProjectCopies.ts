import type { Area, Checkpoint, Item, Location, Project } from '@/types';

type ProjectContents = {
  areas: Map<string, Area>;
  locations: Map<string, Location>;
  items: Map<string, Item>;
  checkpoints: Map<string, Checkpoint>;
  photoIds: Set<string>;
  photoDataIds: Set<string>;
  fileIds: Set<string>;
  fileDataIds: Set<string>;
  photosWithoutData: number;
};

function contents(project: Project): ProjectContents {
  const areas = new Map<string, Area>();
  const locations = new Map<string, Location>();
  const items = new Map<string, Item>();
  const checkpoints = new Map<string, Checkpoint>();
  const photoIds = new Set<string>();
  const photoDataIds = new Set<string>();
  const fileIds = new Set<string>();
  const fileDataIds = new Set<string>();
  let photosWithoutData = 0;
  for (const area of project.areas) {
    if (area.deletedAt || area.purgedAt) continue;
    areas.set(area.id, area);
    for (const location of area.locations) {
      locations.set(location.id, location);
      for (const item of location.items) {
        items.set(item.id, item);
        for (const checkpoint of item.checkpoints) {
          checkpoints.set(checkpoint.id, checkpoint);
          for (const photo of checkpoint.photos) {
            photoIds.add(photo.id);
            if (photo.imageData) photoDataIds.add(photo.id);
            if (!photo.imageData) photosWithoutData += 1;
          }
          for (const file of checkpoint.files ?? []) {
            fileIds.add(file.id);
            if (file.data) fileDataIds.add(file.id);
          }
        }
      }
    }
  }
  return { areas, locations, items, checkpoints, photoIds, photoDataIds, fileIds, fileDataIds, photosWithoutData };
}

function onlyIn(left: Set<string>, right: Set<string>) {
  return [...left].filter((id) => !right.has(id));
}

function normalized(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function isLikelyPersonalProjectCopy(first: Project, second: Project) {
  if (first.id === second.id || first.sharedProjectId || second.sharedProjectId) return false;
  if (!normalized(first.projectName) || !normalized(first.address)) return false;
  if (normalized(first.projectName) !== normalized(second.projectName)
    || normalized(first.address) !== normalized(second.address)) return false;

  return sharesSavedCheckpoints(first, second);
}

function sharesSavedCheckpoints(first: Project, second: Project) {
  const firstAreas = new Map(first.areas.filter((area) => !area.deletedAt && !area.purgedAt)
    .map((area) => [area.id, area]));
  return second.areas.some((area) => {
    const match = firstAreas.get(area.id);
    if (!match || area.deletedAt || area.purgedAt) return false;
    const checkpointIds = new Set(match.locations.flatMap((location) =>
      location.items.flatMap((item) => item.checkpoints.map((checkpoint) => checkpoint.id))));
    return area.locations.some((location) => location.items.some((item) =>
      item.checkpoints.some((checkpoint) => checkpointIds.has(checkpoint.id))));
  });
}

export function isRecoveredCopyPair(first: Project, second: Project) {
  if (first.sharedProjectId || second.sharedProjectId) return false;
  if (
    first.recoveredFromProjectId === second.id
    || second.recoveredFromProjectId === first.id
  ) return true;

  // Older OneDrive restores discarded the provenance field. Match only the
  // app-created recovery name plus the same address and saved checkpoint IDs.
  const prefix = 'Recovered local copy - ';
  const recovery = first.projectName.startsWith(prefix) ? first
    : second.projectName.startsWith(prefix) ? second : null;
  if (!recovery) return false;
  const original = recovery === first ? second : first;
  const sourceName = normalized(recovery.projectName.slice(prefix.length));
  if (!sourceName || !normalized(original.projectName).startsWith(sourceName)) return false;
  if (!normalized(recovery.address) || normalized(recovery.address) !== normalized(original.address)) return false;
  return sharesSavedCheckpoints(recovery, original);
}

export function compareProjectCopies(first: Project, second: Project) {
  const left = contents(first);
  const right = contents(second);
  const firstAreaIds = new Set(left.areas.keys());
  const secondAreaIds = new Set(right.areas.keys());
  const firstLocationIds = new Set(left.locations.keys());
  const secondLocationIds = new Set(right.locations.keys());
  const firstItemIds = new Set(left.items.keys());
  const secondItemIds = new Set(right.items.keys());
  const firstCheckpointIds = new Set(left.checkpoints.keys());
  const secondCheckpointIds = new Set(right.checkpoints.keys());
  const differingAreaIds = [...firstAreaIds].filter((id) => {
    const a = left.areas.get(id);
    const b = right.areas.get(id);
    return b && a && JSON.stringify([
      a.name, a.areaTypeKey, a.unitType, a.customAreaName, a.areaNumber,
      a.unitFloor, a.facadeLevel, a.isComplete, a.notes,
    ]) !== JSON.stringify([
      b.name, b.areaTypeKey, b.unitType, b.customAreaName, b.areaNumber,
      b.unitFloor, b.facadeLevel, b.isComplete, b.notes,
    ]);
  });
  const differingLocationIds = [...firstLocationIds].filter((id) => {
    const a = left.locations.get(id);
    const b = right.locations.get(id);
    return b && a && JSON.stringify([a.name, a.sectionLabel, a.reviewedAt])
      !== JSON.stringify([b.name, b.sectionLabel, b.reviewedAt]);
  });
  const differingItemIds = [...firstItemIds].filter((id) => {
    const a = left.items.get(id);
    const b = right.items.get(id);
    return b && a && a.name !== b.name;
  });
  const differingCheckpointIds = [...firstCheckpointIds].filter((id) => {
    const a = left.checkpoints.get(id);
    const b = right.checkpoints.get(id);
    return b && a && (
      a.name !== b.name
      || a.status !== b.status
      || a.fixStatus !== b.fixStatus
      || a.issueState !== b.issueState
      || a.comments !== b.comments
    );
  });
  return {
    sameTeamProject: Boolean(first.sharedProjectId && first.sharedProjectId === second.sharedProjectId),
    firstOnlyAreaIds: onlyIn(firstAreaIds, secondAreaIds),
    secondOnlyAreaIds: onlyIn(secondAreaIds, firstAreaIds),
    firstOnlyLocationIds: onlyIn(firstLocationIds, secondLocationIds),
    secondOnlyLocationIds: onlyIn(secondLocationIds, firstLocationIds),
    firstOnlyItemIds: onlyIn(firstItemIds, secondItemIds),
    secondOnlyItemIds: onlyIn(secondItemIds, firstItemIds),
    firstOnlyCheckpointIds: onlyIn(firstCheckpointIds, secondCheckpointIds),
    secondOnlyCheckpointIds: onlyIn(secondCheckpointIds, firstCheckpointIds),
    firstOnlyPhotoIds: onlyIn(left.photoIds, right.photoIds),
    secondOnlyPhotoIds: onlyIn(right.photoIds, left.photoIds),
    firstOnlyPhotoDataIds: onlyIn(left.photoDataIds, right.photoDataIds),
    secondOnlyPhotoDataIds: onlyIn(right.photoDataIds, left.photoDataIds),
    firstOnlyFileIds: onlyIn(left.fileIds, right.fileIds),
    secondOnlyFileIds: onlyIn(right.fileIds, left.fileIds),
    firstOnlyFileDataIds: onlyIn(left.fileDataIds, right.fileDataIds),
    secondOnlyFileDataIds: onlyIn(right.fileDataIds, left.fileDataIds),
    differingCheckpointIds,
    differingAreaIds,
    differingLocationIds,
    differingItemIds,
    firstPhotosWithoutData: left.photosWithoutData,
    secondPhotosWithoutData: right.photosWithoutData,
  };
}
