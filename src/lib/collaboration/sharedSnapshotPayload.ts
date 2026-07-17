import type { Project } from '@/types';
import {
  ProjectPayloadValidationError,
  parseProjectPayload,
} from '@/lib/projectPayload';

export const COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION = 2;

export type SharedSnapshotAssetReference = {
  bucket: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
};

export type SharedSnapshotAssetManifest = {
  photos: Record<string, {
    image: SharedSnapshotAssetReference;
    thumbnail?: SharedSnapshotAssetReference;
  }>;
  files: Record<string, SharedSnapshotAssetReference>;
  drawings: Record<string, SharedSnapshotAssetReference>;
};

export type ParsedSharedSnapshotPayload = {
  project: Project;
  assets: SharedSnapshotAssetManifest;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectPayloadValidationError(`${path} must be an object.`);
  }
  return value as UnknownRecord;
}

function requiredString(value: unknown, path: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProjectPayloadValidationError(`${path} must be a non-empty string.`);
  }
  return value;
}

function parseAssetReference(value: unknown, path: string): SharedSnapshotAssetReference {
  const input = record(value, path);
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new ProjectPayloadValidationError(`${path}.sizeBytes must be a non-negative safe integer.`);
  }

  return {
    bucket: requiredString(input.bucket, `${path}.bucket`),
    path: requiredString(input.path, `${path}.path`),
    mimeType: requiredString(input.mimeType, `${path}.mimeType`),
    sizeBytes,
  };
}

function parseReferenceMap(
  value: unknown,
  path: string
): Record<string, SharedSnapshotAssetReference> {
  if (value === undefined) return {};
  const input = record(value, path);
  return Object.fromEntries(
    Object.entries(input).map(([id, reference]) => [
      id,
      parseAssetReference(reference, `${path}.${id}`),
    ])
  );
}

function parsePhotoReferenceMap(
  value: unknown,
  path: string
): SharedSnapshotAssetManifest['photos'] {
  if (value === undefined) return {};
  const input = record(value, path);
  return Object.fromEntries(
    Object.entries(input).map(([id, value]) => {
      const photo = record(value, `${path}.${id}`);
      return [
        id,
        {
          image: parseAssetReference(photo.image, `${path}.${id}.image`),
          thumbnail: photo.thumbnail === undefined
            ? undefined
            : parseAssetReference(photo.thumbnail, `${path}.${id}.thumbnail`),
        },
      ];
    })
  );
}

export function createEmptySharedSnapshotAssetManifest(): SharedSnapshotAssetManifest {
  return {
    photos: {},
    files: {},
    drawings: {},
  };
}

function cloneProjectWithoutBinaryPayloads(project: Project): Project {
  return {
    ...project,
    facadeElevationDrawings: project.facadeElevationDrawings?.map((drawing) => ({
      ...drawing,
      dataUrl: '',
    })),
    areas: project.areas.map((area) => ({
      ...area,
      locations: area.locations.map((location) => ({
        ...location,
        items: location.items.map((item) => ({
          ...item,
          checkpoints: item.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            photos: checkpoint.photos.map((photo) => ({
              ...photo,
              imageData: '',
              thumbnail: undefined,
            })),
            files: (checkpoint.files ?? []).map((file) => ({
              ...file,
              data: '',
            })),
          })),
        })),
      })),
    })),
  };
}

export function createCompactSharedSnapshotPayload(
  project: Project,
  assets: SharedSnapshotAssetManifest
) {
  return {
    payloadVersion: COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION,
    project: cloneProjectWithoutBinaryPayloads(project),
    assets,
  };
}

export function parseSharedSnapshotPayload(
  value: unknown,
  payloadVersion: number
): ParsedSharedSnapshotPayload {
  if (payloadVersion === 1) {
    return {
      project: parseProjectPayload(value, 1),
      assets: createEmptySharedSnapshotAssetManifest(),
    };
  }

  if (payloadVersion !== COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION) {
    throw new ProjectPayloadValidationError(`Shared snapshot payload version ${payloadVersion} is not supported.`);
  }

  const envelope = record(value, 'shared snapshot payload');
  if (envelope.payloadVersion !== COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION) {
    throw new ProjectPayloadValidationError(
      `Shared snapshot payload version ${String(envelope.payloadVersion)} is not supported.`
    );
  }

  const assets = envelope.assets === undefined
    ? createEmptySharedSnapshotAssetManifest()
    : (() => {
        const input = record(envelope.assets, 'shared snapshot payload.assets');
        return {
          photos: parsePhotoReferenceMap(input.photos, 'shared snapshot payload.assets.photos'),
          files: parseReferenceMap(input.files, 'shared snapshot payload.assets.files'),
          drawings: parseReferenceMap(input.drawings, 'shared snapshot payload.assets.drawings'),
        };
      })();

  return {
    project: parseProjectPayload(envelope.project, 1),
    assets,
  };
}

export function getSharedSnapshotProjectName(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Shared project backup';
  }

  const input = value as UnknownRecord;
  const nestedProject = input.project && typeof input.project === 'object' && !Array.isArray(input.project)
    ? input.project as UnknownRecord
    : null;
  const projectName = typeof input.projectName === 'string'
    ? input.projectName
    : typeof nestedProject?.projectName === 'string'
      ? nestedProject.projectName
      : '';
  return projectName.trim() || 'Shared project backup';
}
