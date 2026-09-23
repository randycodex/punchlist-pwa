import type { Checkpoint, Project } from '@/types';

type ProjectContents = {
  areaIds: Set<string>;
  checkpoints: Map<string, Checkpoint>;
  photoIds: Set<string>;
  photoDataIds: Set<string>;
  fileIds: Set<string>;
  fileDataIds: Set<string>;
  photosWithoutData: number;
};

function contents(project: Project): ProjectContents {
  const areaIds = new Set<string>();
  const checkpoints = new Map<string, Checkpoint>();
  const photoIds = new Set<string>();
  const photoDataIds = new Set<string>();
  const fileIds = new Set<string>();
  const fileDataIds = new Set<string>();
  let photosWithoutData = 0;
  for (const area of project.areas) {
    if (area.deletedAt || area.purgedAt) continue;
    areaIds.add(area.id);
    for (const location of area.locations) {
      for (const item of location.items) {
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
  return { areaIds, checkpoints, photoIds, photoDataIds, fileIds, fileDataIds, photosWithoutData };
}

function onlyIn(left: Set<string>, right: Set<string>) {
  return [...left].filter((id) => !right.has(id));
}

export function compareProjectCopies(first: Project, second: Project) {
  const left = contents(first);
  const right = contents(second);
  const firstCheckpointIds = new Set(left.checkpoints.keys());
  const secondCheckpointIds = new Set(right.checkpoints.keys());
  const differingCheckpointIds = [...firstCheckpointIds].filter((id) => {
    const a = left.checkpoints.get(id);
    const b = right.checkpoints.get(id);
    return b && a && (
      a.status !== b.status
      || a.fixStatus !== b.fixStatus
      || a.issueState !== b.issueState
      || a.comments !== b.comments
    );
  });
  return {
    sameTeamProject: Boolean(first.sharedProjectId && first.sharedProjectId === second.sharedProjectId),
    firstOnlyAreaIds: onlyIn(left.areaIds, right.areaIds),
    secondOnlyAreaIds: onlyIn(right.areaIds, left.areaIds),
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
    firstPhotosWithoutData: left.photosWithoutData,
    secondPhotosWithoutData: right.photosWithoutData,
  };
}
