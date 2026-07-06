import { openDB, DBSchema, IDBPDatabase } from 'idb';
import {
  Project,
  Area,
  Location,
  Item,
  Checkpoint,
  PhotoAttachment,
  FileAttachment,
  FacadeElevationDrawing,
} from '@/types';
import type { AreaTypeKey, ApartmentUnitType, FacadeOrientation } from '@/lib/areas';
import { v4 as uuidv4 } from 'uuid';

interface CheckpointMediaRecord {
  checkpointId: string;
  projectId: string;
  photos: PhotoAttachment[];
  files: FileAttachment[];
}

interface ElevationDrawingRecord extends FacadeElevationDrawing {
  projectId: string;
}

interface PunchListDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { 'by-name': string; 'by-date': Date };
  };
  checkpointMedia: {
    key: string;
    value: CheckpointMediaRecord;
    indexes: { 'by-project': string };
  };
  elevationDrawings: {
    key: string;
    value: ElevationDrawingRecord;
    indexes: { 'by-project': string };
  };
}

let dbPromise: Promise<IDBPDatabase<PunchListDB>> | null = null;

function sanitizeOneDriveFolderNamePart(value: string | undefined, fallback: string) {
  const cleaned = (value ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

function stripPhotoPayload(photo: PhotoAttachment): PhotoAttachment {
  return {
    ...photo,
    imageData: '',
  };
}

function stripFilePayload(file: FileAttachment): FileAttachment {
  return {
    ...file,
    data: '',
  };
}

function stripElevationDrawingPayload(drawing: FacadeElevationDrawing): FacadeElevationDrawing {
  return {
    ...drawing,
    dataUrl: '',
  };
}

function cloneProjectWithoutMediaPayload(project: Project): Project {
  return {
    ...project,
    facadeElevationDrawings: project.facadeElevationDrawings?.map(stripElevationDrawingPayload),
    areas: project.areas.map((area) => ({
      ...area,
      locations: area.locations.map((location) => ({
        ...location,
        items: location.items.map((item) => ({
          ...item,
          checkpoints: item.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            photos: checkpoint.photos.map(stripPhotoPayload),
            files: (checkpoint.files ?? []).map(stripFilePayload),
          })),
        })),
      })),
    })),
  };
}

function serializeProjectForStorage(project: Project): {
  storedProject: Project;
  mediaRecords: CheckpointMediaRecord[];
  elevationDrawingRecords: ElevationDrawingRecord[];
} {
  const mediaRecords: CheckpointMediaRecord[] = [];
  const elevationDrawingRecords: ElevationDrawingRecord[] = (project.facadeElevationDrawings ?? [])
    .filter((drawing) => Boolean(drawing.dataUrl))
    .map((drawing) => ({
      ...drawing,
      projectId: project.id,
    }));

  const storedProject: Project = {
    ...project,
    facadeElevationDrawings: project.facadeElevationDrawings?.map(stripElevationDrawingPayload),
    areas: project.areas.map((area) => ({
      ...area,
      locations: area.locations.map((location) => ({
        ...location,
        items: location.items.map((item) => ({
          ...item,
          checkpoints: item.checkpoints.map((checkpoint) => {
            const photos = checkpoint.photos.map((photo) => ({
              ...photo,
              thumbnail: undefined,
            }));
            const files = checkpoint.files ?? [];

            if (photos.length > 0 || files.length > 0) {
              mediaRecords.push({
                checkpointId: checkpoint.id,
                projectId: project.id,
                photos,
                files,
              });
            }

            return {
              ...checkpoint,
              photos: checkpoint.photos.map(stripPhotoPayload),
              files: files.map(stripFilePayload),
            };
          }),
        })),
      })),
    })),
  };

  return { storedProject, mediaRecords, elevationDrawingRecords };
}

function hydrateProjectMedia(project: Project, mediaRecords: CheckpointMediaRecord[]): Project {
  if (mediaRecords.length === 0) {
    return project;
  }

  const mediaByCheckpoint = new Map(mediaRecords.map((record) => [record.checkpointId, record]));

  return {
    ...project,
    areas: project.areas.map((area) => ({
      ...area,
      locations: area.locations.map((location) => ({
        ...location,
        items: location.items.map((item) => ({
          ...item,
          checkpoints: item.checkpoints.map((checkpoint) => {
            const media = mediaByCheckpoint.get(checkpoint.id);
            if (!media) return checkpoint;
            return {
              ...checkpoint,
              photos: media.photos,
              files: media.files,
            };
          }),
        })),
      })),
    })),
  };
}

function hydrateProjectElevationDrawings(
  project: Project,
  drawingRecords: ElevationDrawingRecord[]
): Project {
  if (drawingRecords.length === 0) {
    return project;
  }

  const recordsByDrawingId = new Map(drawingRecords.map((record) => [record.id, record]));

  return {
    ...project,
    facadeElevationDrawings: project.facadeElevationDrawings?.map((drawing) => {
      const record = recordsByDrawingId.get(drawing.id);
      if (!record) return drawing;
      return {
        ...drawing,
        id: record.id,
        orientation: record.orientation,
        name: record.name,
        fileName: record.fileName,
        mimeType: record.mimeType,
        size: record.size,
        dataUrl: record.dataUrl,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    }),
  };
}

function preserveExistingMediaPayloads(
  record: CheckpointMediaRecord,
  existingRecord?: CheckpointMediaRecord
): CheckpointMediaRecord {
  if (!existingRecord) return record;

  const existingPhotosById = new Map(existingRecord.photos.map((photo) => [photo.id, photo]));
  const existingFilesById = new Map(existingRecord.files.map((file) => [file.id, file]));

  return {
    ...record,
    photos: record.photos.map((photo) => {
      const existingPhoto = existingPhotosById.get(photo.id);
      if (!existingPhoto || photo.imageData) return photo;
      return {
        ...photo,
        imageData: existingPhoto.imageData,
        thumbnail: photo.thumbnail ?? existingPhoto.thumbnail,
      };
    }),
    files: record.files.map((file) => {
      const existingFile = existingFilesById.get(file.id);
      if (!existingFile || file.data) return file;
      return {
        ...file,
        data: existingFile.data,
      };
    }),
  };
}

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<PunchListDB>('punchlist-db', 3, {
      async upgrade(db, oldVersion, _newVersion, transaction) {
        if (!db.objectStoreNames.contains('projects')) {
          const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
          projectStore.createIndex('by-name', 'projectName');
          projectStore.createIndex('by-date', 'updatedAt');
        }

        if (!db.objectStoreNames.contains('checkpointMedia')) {
          const mediaStore = db.createObjectStore('checkpointMedia', { keyPath: 'checkpointId' });
          mediaStore.createIndex('by-project', 'projectId');
        }

        if (!db.objectStoreNames.contains('elevationDrawings')) {
          const drawingStore = db.createObjectStore('elevationDrawings', { keyPath: 'id' });
          drawingStore.createIndex('by-project', 'projectId');
        }

        if (oldVersion < 3 && db.objectStoreNames.contains('projects')) {
          const projectStore = transaction.objectStore('projects');
          const drawingStore = transaction.objectStore('elevationDrawings');
          let cursor = await projectStore.openCursor();

          while (cursor) {
            const project = cursor.value;
            const drawings = project.facadeElevationDrawings ?? [];
            if (drawings.some((drawing) => drawing.dataUrl)) {
              for (const drawing of drawings) {
                if (drawing.dataUrl) {
                  await drawingStore.put({
                    ...drawing,
                    projectId: project.id,
                  });
                }
              }
              await cursor.update({
                ...project,
                facadeElevationDrawings: drawings.map(stripElevationDrawingPayload),
              });
            }
            cursor = await cursor.continue();
          }
        }
      },
    });
  }
  return dbPromise;
}

// Project operations
export async function getAllProjects(): Promise<Project[]> {
  const db = await getDB();
  const projects = await db.getAll('projects');
  return projects.map(cloneProjectWithoutMediaPayload);
}

export async function getProject(id: string): Promise<Project | undefined> {
  const db = await getDB();
  const project = await db.get('projects', id);
  if (!project) return undefined;
  const [mediaRecords, drawingRecords] = await Promise.all([
    db.getAllFromIndex('checkpointMedia', 'by-project', id),
    db.getAllFromIndex('elevationDrawings', 'by-project', id),
  ]);
  return hydrateProjectElevationDrawings(hydrateProjectMedia(project, mediaRecords), drawingRecords);
}

export async function getProjectMetadata(id: string): Promise<Project | undefined> {
  const db = await getDB();
  const project = await db.get('projects', id);
  return project ? cloneProjectWithoutMediaPayload(project) : undefined;
}

export async function getActiveProjectCount(): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('projects');
  let cursor = await tx.store.openCursor();
  let activeCount = 0;

  while (cursor) {
    if (!cursor.value.deletedAt) {
      activeCount += 1;
    }
    cursor = await cursor.continue();
  }

  await tx.done;
  return activeCount;
}

export async function saveProject(project: Project): Promise<void> {
  await saveProjectInternal(project, { touch: true });
}

export async function saveProjectMetadataOnly(
  project: Project,
  options: { touch?: boolean } = {}
): Promise<void> {
  const db = await getDB();
  if (options.touch ?? true) {
    project.updatedAt = new Date();
  }
  const { storedProject } = serializeProjectForStorage(project);
  await db.put('projects', storedProject);
}

export async function saveProjectPreserveTimestamps(project: Project): Promise<void> {
  await saveProjectInternal(project, { touch: false });
}

async function saveProjectInternal(project: Project, options: { touch: boolean }): Promise<void> {
  const db = await getDB();
  if (options.touch) {
    project.updatedAt = new Date();
  }
  const { storedProject, mediaRecords, elevationDrawingRecords } = serializeProjectForStorage(project);
  const tx = db.transaction(['projects', 'checkpointMedia', 'elevationDrawings'], 'readwrite');
  const projectStore = tx.objectStore('projects');
  const mediaStore = tx.objectStore('checkpointMedia');
  const drawingStore = tx.objectStore('elevationDrawings');

  await projectStore.put(storedProject);

  const existingMediaRecords = await mediaStore.index('by-project').getAll(project.id);
  const existingMediaByCheckpoint = new Map(
    existingMediaRecords.map((record) => [record.checkpointId, record])
  );
  const nextCheckpointIds = new Set(mediaRecords.map((record) => record.checkpointId));

  await Promise.all(
    existingMediaRecords
      .filter((record) => !nextCheckpointIds.has(record.checkpointId))
      .map((record) => mediaStore.delete(record.checkpointId))
  );

  await Promise.all(
    mediaRecords.map((record) =>
      mediaStore.put(preserveExistingMediaPayloads(record, existingMediaByCheckpoint.get(record.checkpointId)))
    )
  );

  const existingDrawingRecords = await drawingStore.index('by-project').getAll(project.id);
  const existingDrawingById = new Map(existingDrawingRecords.map((record) => [record.id, record]));
  const incomingDrawingPayloadById = new Map(
    elevationDrawingRecords.map((record) => [record.id, record.dataUrl])
  );
  const nextDrawingMetadata = storedProject.facadeElevationDrawings ?? [];
  const nextDrawingIds = new Set(nextDrawingMetadata.map((drawing) => drawing.id));

  await Promise.all(
    existingDrawingRecords
      .filter((record) => !nextDrawingIds.has(record.id))
      .map((record) => drawingStore.delete(record.id))
  );

  await Promise.all(
    nextDrawingMetadata
      .map((drawing) => {
        const dataUrl = incomingDrawingPayloadById.get(drawing.id) || existingDrawingById.get(drawing.id)?.dataUrl || '';
        if (!dataUrl) return null;
        return drawingStore.put({
          ...drawing,
          dataUrl,
          projectId: project.id,
        });
      })
      .filter((operation): operation is Promise<string> => operation !== null)
  );
  await tx.done;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['projects', 'checkpointMedia', 'elevationDrawings'], 'readwrite');
  await tx.objectStore('projects').delete(id);
  const mediaStore = tx.objectStore('checkpointMedia');
  const mediaRecords = await mediaStore.index('by-project').getAll(id);
  await Promise.all(mediaRecords.map((record) => mediaStore.delete(record.checkpointId)));
  const drawingStore = tx.objectStore('elevationDrawings');
  const drawingRecords = await drawingStore.index('by-project').getAll(id);
  await Promise.all(drawingRecords.map((record) => drawingStore.delete(record.id)));
  await tx.done;
}

export function createProject(name: string, address: string = '', inspector: string = ''): Project {
  const now = new Date();
  return {
    id: uuidv4(),
    projectName: name,
    oneDriveFolderName: sanitizeOneDriveFolderNamePart(name, 'project'),
    address,
    date: now,
    inspector,
    gcName: '',
    gcSignoff: '',
    areas: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createArea(
  projectId: string,
  name: string,
  sortOrder: number,
  options?: {
    areaTypeKey?: AreaTypeKey;
    unitType?: ApartmentUnitType | FacadeOrientation | '';
    customAreaName?: string;
    areaNumber?: string;
    facadeLevel?: string;
    elevationDrawingId?: string;
  }
): Area {
  const now = new Date();
  return {
    id: uuidv4(),
    projectId,
    name,
    areaTypeKey: options?.areaTypeKey,
    unitType: options?.unitType || undefined,
    customAreaName: options?.customAreaName?.trim() || undefined,
    areaNumber: options?.areaNumber?.trim() || undefined,
    facadeLevel: options?.facadeLevel?.trim() || undefined,
    elevationDrawingId: options?.elevationDrawingId?.trim() || undefined,
    sortOrder,
    isComplete: false,
    notes: '',
    locations: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createLocation(
  areaId: string,
  name: string,
  sortOrder: number,
  options?: {
    isCustom?: boolean;
  }
): Location {
  const now = new Date();
  return {
    id: uuidv4(),
    areaId,
    name,
    isCustom: options?.isCustom,
    sortOrder,
    items: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createItem(
  locationId: string,
  name: string,
  sortOrder: number,
  options?: { isCustom?: boolean }
): Item {
  const now = new Date();
  return {
    id: uuidv4(),
    locationId,
    name,
    isCustom: options?.isCustom ?? false,
    sortOrder,
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createCheckpoint(
  itemId: string,
  name: string,
  sortOrder: number,
  options?: { isCustom?: boolean; isElevationIssue?: boolean; sourceCheckpointId?: string }
): Checkpoint {
  const now = new Date();
  return {
    id: uuidv4(),
    itemId,
    name,
    isCustom: options?.isCustom ?? false,
    isElevationIssue: options?.isElevationIssue,
    sourceCheckpointId: options?.sourceCheckpointId,
    status: 'pending',
    fixStatus: 'pending',
    issueState: 'none',
    comments: '',
    sortOrder,
    photos: [],
    files: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createPhotoAttachment(
  checkpointId: string,
  imageData: string,
  thumbnail?: string
): PhotoAttachment {
  return {
    id: uuidv4(),
    checkpointId,
    imageData,
    ...(thumbnail ? { thumbnail } : {}),
    createdAt: new Date(),
  };
}

export function createFileAttachment(
  checkpointId: string,
  data: string,
  name: string,
  mimeType: string,
  size: number
): FileAttachment {
  return {
    id: uuidv4(),
    checkpointId,
    data,
    name,
    mimeType,
    size,
    createdAt: new Date(),
  };
}
