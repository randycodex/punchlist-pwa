import type {
  Area,
  Checkpoint,
  FacadeElevationDrawing,
  FileAttachment,
  Item,
  Location,
  PhotoAttachment,
  Project,
} from '@/types';

export const CURRENT_PROJECT_PAYLOAD_VERSION = 1;

export class ProjectPayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectPayloadValidationError';
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectPayloadValidationError(`${path} must be an object.`);
  }
  return value as UnknownRecord;
}

function array(value: unknown, path: string) {
  if (!Array.isArray(value)) {
    throw new ProjectPayloadValidationError(`${path} must be an array.`);
  }
  return value;
}

function requiredString(value: unknown, path: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProjectPayloadValidationError(`${path} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, path: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ProjectPayloadValidationError(`${path} must be a string.`);
  }
  return value;
}

function stringWithDefault(value: unknown, path: string, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw new ProjectPayloadValidationError(`${path} must be a string.`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProjectPayloadValidationError(`${path} must be a finite number.`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, path: string) {
  if (value === undefined || value === null) return undefined;
  return finiteNumber(value, path);
}

function date(value: unknown, path: string) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value as string | number);
  if (Number.isNaN(parsed.getTime())) {
    throw new ProjectPayloadValidationError(`${path} must be a valid date.`);
  }
  return parsed;
}

function optionalDate(value: unknown, path: string) {
  if (value === undefined || value === null || value === '') return undefined;
  return date(value, path);
}

function booleanWithDefault(value: unknown, path: string, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new ProjectPayloadValidationError(`${path} must be a boolean.`);
  }
  return value;
}

function parsePhoto(value: unknown, path: string): PhotoAttachment {
  const input = record(value, path);
  return {
    id: requiredString(input.id, `${path}.id`),
    checkpointId: requiredString(input.checkpointId, `${path}.checkpointId`),
    imageData: stringWithDefault(input.imageData, `${path}.imageData`),
    thumbnail: optionalString(input.thumbnail, `${path}.thumbnail`),
    createdAt: date(input.createdAt, `${path}.createdAt`),
  };
}

function parseFile(value: unknown, path: string): FileAttachment {
  const input = record(value, path);
  return {
    id: requiredString(input.id, `${path}.id`),
    checkpointId: requiredString(input.checkpointId, `${path}.checkpointId`),
    name: requiredString(input.name, `${path}.name`),
    mimeType: stringWithDefault(input.mimeType, `${path}.mimeType`, 'application/octet-stream'),
    size: finiteNumber(input.size, `${path}.size`, 0),
    data: stringWithDefault(input.data, `${path}.data`),
    createdAt: date(input.createdAt, `${path}.createdAt`),
  };
}

function parseCheckpoint(value: unknown, path: string): Checkpoint {
  const input = record(value, path);
  const status = input.status;
  const fixStatus = input.fixStatus ?? 'pending';
  const issueState = input.issueState;
  if (status !== 'pending' && status !== 'ok' && status !== 'needsReview') {
    throw new ProjectPayloadValidationError(`${path}.status is not supported.`);
  }
  if (fixStatus !== 'pending' && fixStatus !== 'fixed' && fixStatus !== 'verified') {
    throw new ProjectPayloadValidationError(`${path}.fixStatus is not supported.`);
  }
  if (issueState !== undefined && issueState !== 'none' && issueState !== 'open' && issueState !== 'resolved' && issueState !== 'verified') {
    throw new ProjectPayloadValidationError(`${path}.issueState is not supported.`);
  }

  const marker = input.elevationMarker === undefined
    ? undefined
    : (() => {
        const markerInput = record(input.elevationMarker, `${path}.elevationMarker`);
        return {
          drawingId: requiredString(markerInput.drawingId, `${path}.elevationMarker.drawingId`),
          xPercent: finiteNumber(markerInput.xPercent, `${path}.elevationMarker.xPercent`),
          yPercent: finiteNumber(markerInput.yPercent, `${path}.elevationMarker.yPercent`),
        };
      })();

  return {
    id: requiredString(input.id, `${path}.id`),
    itemId: requiredString(input.itemId, `${path}.itemId`),
    name: requiredString(input.name, `${path}.name`),
    isCustom: input.isCustom === undefined ? undefined : booleanWithDefault(input.isCustom, `${path}.isCustom`),
    isElevationIssue: input.isElevationIssue === undefined
      ? undefined
      : booleanWithDefault(input.isElevationIssue, `${path}.isElevationIssue`),
    sourceCheckpointId: optionalString(input.sourceCheckpointId, `${path}.sourceCheckpointId`),
    status,
    fixStatus,
    issueState,
    comments: stringWithDefault(input.comments, `${path}.comments`),
    sortOrder: finiteNumber(input.sortOrder, `${path}.sortOrder`, 0),
    photos: array(input.photos ?? [], `${path}.photos`).map((photo, index) => parsePhoto(photo, `${path}.photos[${index}]`)),
    files: array(input.files ?? [], `${path}.files`).map((file, index) => parseFile(file, `${path}.files[${index}]`)),
    elevationMarker: marker,
    createdAt: date(input.createdAt, `${path}.createdAt`),
    updatedAt: date(input.updatedAt, `${path}.updatedAt`),
  };
}

function parseItem(value: unknown, path: string): Item {
  const input = record(value, path);
  return {
    id: requiredString(input.id, `${path}.id`),
    locationId: requiredString(input.locationId, `${path}.locationId`),
    name: requiredString(input.name, `${path}.name`),
    isCustom: input.isCustom === undefined ? undefined : booleanWithDefault(input.isCustom, `${path}.isCustom`),
    sortOrder: finiteNumber(input.sortOrder, `${path}.sortOrder`, 0),
    checkpoints: array(input.checkpoints ?? [], `${path}.checkpoints`).map((checkpoint, index) =>
      parseCheckpoint(checkpoint, `${path}.checkpoints[${index}]`)
    ),
    createdAt: date(input.createdAt, `${path}.createdAt`),
    updatedAt: date(input.updatedAt, `${path}.updatedAt`),
  };
}

function parseLocation(value: unknown, path: string): Location {
  const input = record(value, path);
  return {
    id: requiredString(input.id, `${path}.id`),
    areaId: requiredString(input.areaId, `${path}.areaId`),
    name: requiredString(input.name, `${path}.name`),
    isCustom: input.isCustom === undefined ? undefined : booleanWithDefault(input.isCustom, `${path}.isCustom`),
    sectionLabel: optionalString(input.sectionLabel, `${path}.sectionLabel`),
    reviewedAt: optionalDate(input.reviewedAt, `${path}.reviewedAt`)?.toISOString(),
    sortOrder: finiteNumber(input.sortOrder, `${path}.sortOrder`, 0),
    items: array(input.items ?? [], `${path}.items`).map((item, index) => parseItem(item, `${path}.items[${index}]`)),
    createdAt: date(input.createdAt, `${path}.createdAt`),
    updatedAt: date(input.updatedAt, `${path}.updatedAt`),
  };
}

function parseArea(value: unknown, path: string): Area {
  const input = record(value, path);
  return {
    id: requiredString(input.id, `${path}.id`),
    projectId: requiredString(input.projectId, `${path}.projectId`),
    sharedVersion: optionalFiniteNumber(input.sharedVersion, `${path}.sharedVersion`),
    sharedPublishedAt: optionalDate(input.sharedPublishedAt, `${path}.sharedPublishedAt`),
    name: requiredString(input.name, `${path}.name`),
    areaTypeKey: optionalString(input.areaTypeKey, `${path}.areaTypeKey`),
    unitType: optionalString(input.unitType, `${path}.unitType`) as Area['unitType'],
    customAreaName: optionalString(input.customAreaName, `${path}.customAreaName`),
    areaNumber: optionalString(input.areaNumber, `${path}.areaNumber`),
    facadeLevel: optionalString(input.facadeLevel, `${path}.facadeLevel`),
    elevationDrawingId: optionalString(input.elevationDrawingId, `${path}.elevationDrawingId`),
    sortOrder: finiteNumber(input.sortOrder, `${path}.sortOrder`, 0),
    isComplete: booleanWithDefault(input.isComplete, `${path}.isComplete`),
    notes: stringWithDefault(input.notes, `${path}.notes`),
    locations: array(input.locations ?? [], `${path}.locations`).map((location, index) =>
      parseLocation(location, `${path}.locations[${index}]`)
    ),
    deletedAt: optionalDate(input.deletedAt, `${path}.deletedAt`),
    purgedAt: optionalDate(input.purgedAt, `${path}.purgedAt`),
    createdAt: date(input.createdAt, `${path}.createdAt`),
    updatedAt: date(input.updatedAt, `${path}.updatedAt`),
  };
}

function parseElevationDrawing(value: unknown, path: string): FacadeElevationDrawing {
  const input = record(value, path);
  return {
    id: requiredString(input.id, `${path}.id`),
    orientation: requiredString(input.orientation, `${path}.orientation`),
    name: requiredString(input.name, `${path}.name`),
    fileName: requiredString(input.fileName, `${path}.fileName`),
    mimeType: stringWithDefault(input.mimeType, `${path}.mimeType`, 'application/octet-stream'),
    size: finiteNumber(input.size, `${path}.size`, 0),
    dataUrl: stringWithDefault(input.dataUrl, `${path}.dataUrl`),
    createdAt: date(input.createdAt, `${path}.createdAt`),
    updatedAt: date(input.updatedAt, `${path}.updatedAt`),
  };
}

export function parseProjectPayload(value: unknown, payloadVersion = CURRENT_PROJECT_PAYLOAD_VERSION): Project {
  if (payloadVersion !== CURRENT_PROJECT_PAYLOAD_VERSION) {
    throw new ProjectPayloadValidationError(`Project payload version ${payloadVersion} is not supported.`);
  }

  const envelope = record(value, 'project payload');
  const envelopeVersion = envelope.payloadVersion;
  const rawProject = envelope.project === undefined ? envelope : envelope.project;
  if (envelope.project !== undefined) {
    if (envelopeVersion !== CURRENT_PROJECT_PAYLOAD_VERSION) {
      throw new ProjectPayloadValidationError(`Project payload version ${String(envelopeVersion)} is not supported.`);
    }
  }

  const input = record(rawProject, 'project');
  return {
    id: requiredString(input.id, 'project.id'),
    sharedProjectId: optionalString(input.sharedProjectId, 'project.sharedProjectId'),
    sharedProjectLinkedAt: optionalDate(input.sharedProjectLinkedAt, 'project.sharedProjectLinkedAt'),
    sharedSnapshotPublishedAt: optionalDate(input.sharedSnapshotPublishedAt, 'project.sharedSnapshotPublishedAt'),
    sharedBaselinePublishedAt: optionalDate(input.sharedBaselinePublishedAt, 'project.sharedBaselinePublishedAt'),
    detachedSharedProjectId: optionalString(input.detachedSharedProjectId, 'project.detachedSharedProjectId'),
    detachedSharedProjectAt: optionalDate(input.detachedSharedProjectAt, 'project.detachedSharedProjectAt'),
    detachedSharedSnapshotPublishedAt: optionalDate(
      input.detachedSharedSnapshotPublishedAt,
      'project.detachedSharedSnapshotPublishedAt'
    ),
    projectName: requiredString(input.projectName, 'project.projectName'),
    oneDriveFolderName: optionalString(input.oneDriveFolderName, 'project.oneDriveFolderName'),
    address: stringWithDefault(input.address, 'project.address'),
    date: date(input.date, 'project.date'),
    inspector: stringWithDefault(input.inspector, 'project.inspector'),
    gcName: stringWithDefault(input.gcName, 'project.gcName'),
    gcSignoff: stringWithDefault(input.gcSignoff, 'project.gcSignoff'),
    facadeLevelStart: optionalFiniteNumber(input.facadeLevelStart, 'project.facadeLevelStart'),
    facadeLevelEnd: optionalFiniteNumber(input.facadeLevelEnd, 'project.facadeLevelEnd'),
    facadeElevationDrawings: input.facadeElevationDrawings === undefined
      ? undefined
      : array(input.facadeElevationDrawings, 'project.facadeElevationDrawings').map((drawing, index) =>
          parseElevationDrawing(drawing, `project.facadeElevationDrawings[${index}]`)
        ),
    deletedAt: optionalDate(input.deletedAt, 'project.deletedAt'),
    areas: array(input.areas ?? [], 'project.areas').map((area, index) => parseArea(area, `project.areas[${index}]`)),
    createdAt: date(input.createdAt, 'project.createdAt'),
    updatedAt: date(input.updatedAt, 'project.updatedAt'),
  };
}

export function serializeProjectPayload(project: Project) {
  return JSON.stringify({
    payloadVersion: CURRENT_PROJECT_PAYLOAD_VERSION,
    project,
  });
}
