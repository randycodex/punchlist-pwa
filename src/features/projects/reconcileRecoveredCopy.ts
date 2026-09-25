import type { Area, Checkpoint, FacadeElevationDrawing, FileAttachment, Item, Location, PhotoAttachment, Project } from '@/types';
import { isRecoveredCopyPair } from './compareProjectCopies';

export type RecoveryDifferenceKind =
  | 'projectDetails' | 'drawings'
  | 'missingAreas' | 'changedAreas'
  | 'missingRooms' | 'changedRooms'
  | 'missingItems' | 'changedItems'
  | 'missingCheckpoints' | 'changedCheckpoints'
  | 'missingPhotos' | 'changedPhotos'
  | 'missingFiles' | 'changedFiles';

type Result = {
  safeToArchive: boolean;
  differenceCount: number;
  differences: Record<RecoveryDifferenceKind, number>;
};

const emptyDifferences = (): Result['differences'] => ({
  projectDetails: 0, drawings: 0,
  missingAreas: 0, changedAreas: 0,
  missingRooms: 0, changedRooms: 0,
  missingItems: 0, changedItems: 0,
  missingCheckpoints: 0, changedCheckpoints: 0,
  missingPhotos: 0, changedPhotos: 0,
  missingFiles: 0, changedFiles: 0,
});

export function formatRecoveryDifferenceSummary(result: Result) {
  const d = result.differences;
  const missing = d.missingAreas + d.missingRooms + d.missingItems
    + d.missingCheckpoints + d.missingPhotos + d.missingFiles;
  const changed = d.changedAreas + d.changedRooms + d.changedItems
    + d.changedCheckpoints + d.changedPhotos + d.changedFiles + d.projectDetails + d.drawings;
  const detail = [
    d.changedCheckpoints ? `${d.changedCheckpoints} checkpoint outcomes/details` : '',
    d.changedRooms ? `${d.changedRooms} room details` : '',
    d.changedAreas ? `${d.changedAreas} area details` : '',
    d.changedPhotos || d.missingPhotos ? `${d.changedPhotos + d.missingPhotos} photos` : '',
    d.changedFiles || d.missingFiles ? `${d.changedFiles + d.missingFiles} files` : '',
    d.projectDetails ? 'project details' : '',
    d.drawings ? `${d.drawings} drawings` : '',
  ].filter(Boolean).join(', ');
  return `${missing} entries exist only in the recovered copy; ${changed} shared details differ${detail ? ` (${detail})` : ''}.`;
}

function equal(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function drawingKey(drawing: FacadeElevationDrawing) {
  return JSON.stringify([
    drawing.orientation, drawing.name, drawing.fileName, drawing.mimeType,
    drawing.size, drawing.dataUrl,
  ]);
}

/**
 * A recovery copy can disappear from the active list only if its saved work is
 * already in the personal project. Recovery changes drawing IDs, so compare
 * drawing contents and resolve references before comparing areas and markers.
 */
export function assessRecoveredCopy(recovery: Project, retained: Project): Result {
  if (!isRecoveredCopyPair(recovery, retained)
    || !recovery.projectName.startsWith('Recovered local copy - ')
    || recovery.sharedProjectId || retained.sharedProjectId
    || recovery.deletedAt || retained.deletedAt) {
    const differences = emptyDifferences();
    differences.projectDetails = 1;
    return { safeToArchive: false, differenceCount: 1, differences };
  }

  const differences = emptyDifferences();
  const check = (kind: RecoveryDifferenceKind, same: boolean) => { if (!same) differences[kind] += 1; };
  const drawingById = new Map((recovery.facadeElevationDrawings ?? []).map((drawing) => [drawing.id, drawingKey(drawing)]));
  const retainedDrawingKeys = new Set((retained.facadeElevationDrawings ?? []).map(drawingKey));
  const retainedDrawingById = new Map((retained.facadeElevationDrawings ?? []).map((drawing) => [drawing.id, drawingKey(drawing)]));
  const recoveredDrawingKey = (id?: string) => id ? drawingById.get(id) ?? null : null;
  const targetDrawingKey = (id?: string) => id ? retainedDrawingById.get(id) ?? null : null;

  check('projectDetails', equal([
    recovery.address, recovery.date, recovery.inspector, recovery.gcName, recovery.gcSignoff,
    recovery.unitFloorNumbering, recovery.checkpointRules, recovery.facadeLevelStart, recovery.facadeLevelEnd,
  ], [
    retained.address, retained.date, retained.inspector, retained.gcName, retained.gcSignoff,
    retained.unitFloorNumbering, retained.checkpointRules, retained.facadeLevelStart, retained.facadeLevelEnd,
  ]));
  for (const key of drawingById.values()) check('drawings', retainedDrawingKeys.has(key));

  function checkPhoto(photo: PhotoAttachment, target?: PhotoAttachment) {
    if (!target) { differences.missingPhotos += 1; return; }
    check('changedPhotos', photo.checkpointId === target.checkpointId
      && (!photo.imageData || photo.imageData === target.imageData));
  }

  function checkFile(file: FileAttachment, target?: FileAttachment) {
    if (!target) { differences.missingFiles += 1; return; }
    check('changedFiles', file.checkpointId === target.checkpointId
      && equal([file.name, file.mimeType, file.size], [target.name, target.mimeType, target.size])
      && (!file.data || file.data === target.data));
  }

  function checkCheckpoint(source: Checkpoint, target?: Checkpoint) {
    if (!target) { differences.missingCheckpoints += 1; return; }
    check('changedCheckpoints', equal([
      source.name, source.isCustom, source.isElevationIssue, source.sourceCheckpointId,
      source.status, source.fixStatus, source.issueState, source.comments, source.sortOrder,
      source.elevationMarker?.xPercent, source.elevationMarker?.yPercent,
      recoveredDrawingKey(source.elevationMarker?.drawingId),
    ], [
      target.name, target.isCustom, target.isElevationIssue, target.sourceCheckpointId,
      target.status, target.fixStatus, target.issueState, target.comments, target.sortOrder,
      target.elevationMarker?.xPercent, target.elevationMarker?.yPercent,
      targetDrawingKey(target.elevationMarker?.drawingId),
    ]));
    const photos = new Map(target.photos.map((photo) => [photo.id, photo]));
    const files = new Map((target.files ?? []).map((file) => [file.id, file]));
    for (const photo of source.photos) checkPhoto(photo, photos.get(photo.id));
    for (const file of source.files ?? []) checkFile(file, files.get(file.id));
  }

  function checkItem(source: Item, target?: Item) {
    if (!target) { differences.missingItems += 1; return; }
    check('changedItems', equal([source.name, source.isCustom, source.sortOrder], [target.name, target.isCustom, target.sortOrder]));
    const checkpoints = new Map(target.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    for (const checkpoint of source.checkpoints) checkCheckpoint(checkpoint, checkpoints.get(checkpoint.id));
  }

  function checkLocation(source: Location, target?: Location) {
    if (!target) { differences.missingRooms += 1; return; }
    check('changedRooms', equal([
      source.name, source.isCustom, source.sectionLabel, source.sortOrder, source.reviewedAt,
    ], [
      target.name, target.isCustom, target.sectionLabel, target.sortOrder, target.reviewedAt,
    ]));
    const items = new Map(target.items.map((item) => [item.id, item]));
    for (const item of source.items) checkItem(item, items.get(item.id));
  }

  function checkArea(source: Area, target?: Area) {
    if (!target) { differences.missingAreas += 1; return; }
    check('changedAreas', equal([
      source.name, source.areaTypeKey, source.unitType, source.customAreaName,
      source.areaNumber, source.unitFloor, source.facadeLevel,
      recoveredDrawingKey(source.elevationDrawingId), source.sortOrder,
      source.isComplete, source.notes, Boolean(source.deletedAt), Boolean(source.purgedAt),
    ], [
      target.name, target.areaTypeKey, target.unitType, target.customAreaName,
      target.areaNumber, target.unitFloor, target.facadeLevel,
      targetDrawingKey(target.elevationDrawingId), target.sortOrder,
      target.isComplete, target.notes, Boolean(target.deletedAt), Boolean(target.purgedAt),
    ]));
    const locations = new Map(target.locations.map((location) => [location.id, location]));
    for (const location of source.locations) checkLocation(location, locations.get(location.id));
  }

  const areas = new Map(retained.areas.map((area) => [area.id, area]));
  for (const area of recovery.areas) checkArea(area, areas.get(area.id));
  const differenceCount = Object.values(differences).reduce((sum, count) => sum + count, 0);
  return { safeToArchive: differenceCount === 0, differenceCount, differences };
}
