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

type StoredPhotoAttachment = Omit<PhotoAttachment, 'imageData' | 'thumbnail'> & {
  imageData: string | Blob;
  thumbnail?: string | Blob;
};

type StoredFileAttachment = Omit<FileAttachment, 'data'> & {
  data: string | Blob;
};

interface CheckpointMediaRecord {
  checkpointId: string;
  projectId: string;
  areaId: string;
  photos: StoredPhotoAttachment[];
  files: StoredFileAttachment[];
}

interface ElevationDrawingRecord extends FacadeElevationDrawing {
  projectId: string;
}

interface SyncMetadataRecord {
  key: 'pending';
  projectIds: string[];
  fullSyncNeeded: boolean;
  updatedAt: Date;
}

type SyncMetadataStore = {
  get(key: 'pending'): Promise<SyncMetadataRecord | undefined>;
  put(value: SyncMetadataRecord): Promise<'pending'>;
};

interface PunchListDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { 'by-name': string; 'by-date': Date };
  };
  checkpointMedia: {
    key: string;
    value: CheckpointMediaRecord;
    indexes: { 'by-project': string; 'by-project-area': [string, string] };
  };
  elevationDrawings: {
    key: string;
    value: ElevationDrawingRecord;
    indexes: { 'by-project': string };
  };
  syncMetadata: {
    key: 'pending';
    value: SyncMetadataRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<PunchListDB>> | null = null;

type LocalSaveStatusDetail = {
  status: 'saving' | 'saved' | 'error';
  message?: string;
};

function reportLocalSaveStatus(detail: LocalSaveStatusDetail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('punchlist-local-save-status', { detail }));
}

async function runLocalPersistence<T>(operation: () => Promise<T>): Promise<T> {
  reportLocalSaveStatus({ status: 'saving' });
  try {
    const result = await operation();
    reportLocalSaveStatus({ status: 'saved' });
    return result;
  } catch (error) {
    reportLocalSaveStatus({
      status: 'error',
      message: error instanceof Error ? error.message : 'This device could not save the latest change.',
    });
    throw error;
  }
}

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
    thumbnail: undefined,
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
    areas: project.areas.map(cloneAreaWithoutMediaPayload),
  };
}

function cloneAreaWithoutMediaPayload(area: Area): Area {
  return {
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
            const photos = checkpoint.photos;
            const files = checkpoint.files ?? [];

            if (photos.length > 0 || files.length > 0) {
              mediaRecords.push({
                checkpointId: checkpoint.id,
                projectId: project.id,
                areaId: area.id,
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

async function storedPayloadToDataUrl(payload: string | Blob | undefined) {
  if (payload === undefined || typeof payload === 'string') return payload;
  const bytes = new Uint8Array(await payload.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${payload.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function dataUrlToStoredPayload(payload: string) {
  const match = payload.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return payload;
  try {
    const mimeType = match[1] || 'application/octet-stream';
    const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return payload;
  }
}

async function compactMediaRecord(record: CheckpointMediaRecord): Promise<CheckpointMediaRecord> {
  return {
    ...record,
    photos: record.photos.map((photo) => ({
      ...photo,
      imageData: typeof photo.imageData === 'string' ? dataUrlToStoredPayload(photo.imageData) : photo.imageData,
      thumbnail: typeof photo.thumbnail === 'string' ? dataUrlToStoredPayload(photo.thumbnail) : photo.thumbnail,
    })),
    files: record.files.map((file) => ({
      ...file,
      data: typeof file.data === 'string' ? dataUrlToStoredPayload(file.data) : file.data,
    })),
  };
}

async function hydrateMediaRecord(record: CheckpointMediaRecord) {
  return {
    photos: await Promise.all(record.photos.map(async (photo): Promise<PhotoAttachment> => ({
      ...photo,
      imageData: (await storedPayloadToDataUrl(photo.imageData)) ?? '',
      thumbnail: await storedPayloadToDataUrl(photo.thumbnail),
    }))),
    files: await Promise.all(record.files.map(async (file): Promise<FileAttachment> => ({
      ...file,
      data: (await storedPayloadToDataUrl(file.data)) ?? '',
    }))),
  };
}

async function hydrateProjectMedia(project: Project, mediaRecords: CheckpointMediaRecord[]): Promise<Project> {
  if (mediaRecords.length === 0) {
    return project;
  }

  const hydratedMediaRecords = await Promise.all(
    mediaRecords.map(async (record) => [record.checkpointId, await hydrateMediaRecord(record)] as const)
  );
  const mediaByCheckpoint = new Map(hydratedMediaRecords);

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
    dbPromise = openDB<PunchListDB>('punchlist-db', 5, {
      async upgrade(db, oldVersion, _newVersion, transaction) {
        if (!db.objectStoreNames.contains('projects')) {
          const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
          projectStore.createIndex('by-name', 'projectName');
          projectStore.createIndex('by-date', 'updatedAt');
        }

        if (!db.objectStoreNames.contains('checkpointMedia')) {
          const mediaStore = db.createObjectStore('checkpointMedia', { keyPath: 'checkpointId' });
          mediaStore.createIndex('by-project', 'projectId');
          mediaStore.createIndex('by-project-area', ['projectId', 'areaId']);
        }

        if (!db.objectStoreNames.contains('elevationDrawings')) {
          const drawingStore = db.createObjectStore('elevationDrawings', { keyPath: 'id' });
          drawingStore.createIndex('by-project', 'projectId');
        }

        if (!db.objectStoreNames.contains('syncMetadata')) {
          db.createObjectStore('syncMetadata', { keyPath: 'key' });
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

        if (oldVersion < 5 && db.objectStoreNames.contains('checkpointMedia')) {
          const projectStore = transaction.objectStore('projects');
          const mediaStore = transaction.objectStore('checkpointMedia');
          if (!mediaStore.indexNames.contains('by-project-area')) {
            mediaStore.createIndex('by-project-area', ['projectId', 'areaId']);
          }

          const areaIdByCheckpointId = new Map<string, string>();
          for (const project of await projectStore.getAll()) {
            for (const area of project.areas ?? []) {
              for (const location of area.locations ?? []) {
                for (const item of location.items ?? []) {
                  for (const checkpoint of item.checkpoints ?? []) {
                    areaIdByCheckpointId.set(checkpoint.id, area.id);
                  }
                }
              }
            }
          }

          let mediaCursor = await mediaStore.openCursor();
          while (mediaCursor) {
            const areaId = areaIdByCheckpointId.get(mediaCursor.value.checkpointId);
            if (areaId && mediaCursor.value.areaId !== areaId) {
              await mediaCursor.update({ ...mediaCursor.value, areaId });
            }
            mediaCursor = await mediaCursor.continue();
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
  const projectWithMedia = await hydrateProjectMedia(project, mediaRecords);
  return hydrateProjectElevationDrawings(projectWithMedia, drawingRecords);
}

export async function getProjectForArea(id: string, areaId: string): Promise<Project | undefined> {
  const db = await getDB();
  const project = await db.get('projects', id);
  if (!project) return undefined;
  const [mediaRecords, drawingRecords] = await Promise.all([
    db.getAllFromIndex('checkpointMedia', 'by-project-area', [id, areaId]),
    db.getAllFromIndex('elevationDrawings', 'by-project', id),
  ]);
  const projectWithAreaMedia = await hydrateProjectMedia(project, mediaRecords);
  return hydrateProjectElevationDrawings(projectWithAreaMedia, drawingRecords);
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
  await runLocalPersistence(() => saveProjectInternal(project, { touch: true }));
}

export async function saveProjectMetadataOnly(
  project: Project,
  options: { touch?: boolean } = {}
): Promise<void> {
  await runLocalPersistence(async () => {
    const db = await getDB();
    const shouldMarkPending = options.touch ?? true;
    if (shouldMarkPending) {
      project.updatedAt = new Date();
    }
    const { storedProject } = serializeProjectForStorage(project);
    const tx = db.transaction(['projects', 'syncMetadata'], 'readwrite');
    await tx.objectStore('projects').put(storedProject);
    if (shouldMarkPending) {
      await markPendingProjectInStore(tx.objectStore('syncMetadata'), project.id);
    }
    await tx.done;
  });
}

export async function saveProjectAreaMetadataOnly(
  project: Project,
  areaId: string,
  options: { touch?: boolean } = {}
): Promise<void> {
  await runLocalPersistence(async () => {
    const area = project.areas.find((entry) => entry.id === areaId);
    if (!area) {
      throw new Error(`Could not save missing project area ${areaId}.`);
    }

    const db = await getDB();
    const shouldMarkPending = options.touch ?? true;
    if (shouldMarkPending) {
      project.updatedAt = new Date();
    }

    const tx = db.transaction(['projects', 'syncMetadata'], 'readwrite');
    const projectStore = tx.objectStore('projects');
    const existingProject = await projectStore.get(project.id);
    const storedArea = cloneAreaWithoutMediaPayload(area);

    if (!existingProject) {
      const { storedProject } = serializeProjectForStorage(project);
      await projectStore.put(storedProject);
    } else {
      const existingIndex = existingProject.areas.findIndex((entry) => entry.id === areaId);
      const nextAreas = [...existingProject.areas];
      if (existingIndex === -1) {
        nextAreas.push(storedArea);
      } else {
        nextAreas[existingIndex] = storedArea;
      }
      await projectStore.put({
        ...existingProject,
        updatedAt: project.updatedAt,
        areas: nextAreas,
      });
    }

    if (shouldMarkPending) {
      await markPendingProjectInStore(tx.objectStore('syncMetadata'), project.id);
    }
    await tx.done;
  });
}

export async function saveProjectPreserveTimestamps(project: Project): Promise<void> {
  await runLocalPersistence(() => saveProjectInternal(project, { touch: false }));
}

async function saveProjectInternal(project: Project, options: { touch: boolean }): Promise<void> {
  const db = await getDB();
  if (options.touch) {
    project.updatedAt = new Date();
  }
  const { storedProject, mediaRecords, elevationDrawingRecords } = serializeProjectForStorage(project);
  const tx = db.transaction(['projects', 'checkpointMedia', 'elevationDrawings', 'syncMetadata'], 'readwrite');
  const projectStore = tx.objectStore('projects');
  const mediaStore = tx.objectStore('checkpointMedia');
  const drawingStore = tx.objectStore('elevationDrawings');

  await projectStore.put(storedProject);
  if (options.touch) {
    await markPendingProjectInStore(tx.objectStore('syncMetadata'), project.id);
  }

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
    mediaRecords.map(async (record) => {
      const compactRecord = await compactMediaRecord(record);
      return mediaStore.put(
        preserveExistingMediaPayloads(compactRecord, existingMediaByCheckpoint.get(record.checkpointId))
      );
    })
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
  await runLocalPersistence(async () => {
    const db = await getDB();
    const tx = db.transaction(['projects', 'checkpointMedia', 'elevationDrawings', 'syncMetadata'], 'readwrite');
    await tx.objectStore('projects').delete(id);
    const mediaStore = tx.objectStore('checkpointMedia');
    const mediaRecords = await mediaStore.index('by-project').getAll(id);
    await Promise.all(mediaRecords.map((record) => mediaStore.delete(record.checkpointId)));
    const drawingStore = tx.objectStore('elevationDrawings');
    const drawingRecords = await drawingStore.index('by-project').getAll(id);
    await Promise.all(drawingRecords.map((record) => drawingStore.delete(record.id)));
    await markFullSyncNeededInStore(tx.objectStore('syncMetadata'));
    await tx.done;
  });
}

async function markPendingProjectInStore(
  store: SyncMetadataStore,
  projectId: string
) {
  const current = await store.get('pending');
  const projectIds = new Set(current?.projectIds ?? []);
  projectIds.add(projectId);
  await store.put({
    key: 'pending',
    projectIds: [...projectIds],
    fullSyncNeeded: current?.fullSyncNeeded ?? false,
    updatedAt: new Date(),
  });
}

async function markFullSyncNeededInStore(store: SyncMetadataStore) {
  const current = await store.get('pending');
  await store.put({
    key: 'pending',
    projectIds: current?.projectIds ?? [],
    fullSyncNeeded: true,
    updatedAt: new Date(),
  });
}

export async function getDurablePendingSyncState() {
  const db = await getDB();
  const state = await db.get('syncMetadata', 'pending');
  return {
    projectIds: state?.projectIds ?? [],
    fullSyncNeeded: state?.fullSyncNeeded ?? false,
  };
}

export async function persistDurablePendingSyncState(projectIds: string[], fullSyncNeeded: boolean) {
  const db = await getDB();
  if (projectIds.length === 0 && !fullSyncNeeded) {
    await db.delete('syncMetadata', 'pending');
    return;
  }
  await db.put('syncMetadata', {
    key: 'pending',
    projectIds: [...new Set(projectIds)],
    fullSyncNeeded,
    updatedAt: new Date(),
  });
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
