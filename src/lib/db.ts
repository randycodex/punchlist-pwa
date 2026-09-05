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
  isAreaInspectionComplete,
} from '@/types';
import type { AreaTypeKey, ApartmentUnitType, FacadeOrientation } from '@/lib/areas';
import { v4 as uuidv4 } from 'uuid';
import { deleteProjectCaptureDrafts } from '@/lib/captureJournal';

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

export interface PendingSharedAreaSyncRecord {
  key: string;
  localProjectId: string;
  sharedProjectId: string;
  areaId: string;
  baseVersion: number;
  basePublishedAt: string;
  clientId: string;
  revision: number;
  attemptCount: number;
  blockedByConflict: boolean;
  readyAfterConflictReview?: boolean;
  queuedAt: Date;
  lastError: string | null;
}

export type PendingSharedAreaSyncInput = {
  localProjectId: string;
  sharedProjectId: string;
  areaId: string;
  baseVersion: number;
  basePublishedAt: string;
};

export interface PendingSharedProjectMetadataSyncRecord {
  key: string;
  localProjectId: string;
  sharedProjectId: string;
  baseVersion: number;
  clientId: string;
  revision: number;
  attemptCount: number;
  blockedByConflict: boolean;
  queuedAt: Date;
  lastError: string | null;
}

export type PendingSharedProjectMetadataSyncInput = {
  localProjectId: string;
  sharedProjectId: string;
  baseVersion: number;
};

export type SharedSyncQueueSummary = {
  pendingCount: number;
  conflictCount: number;
  lastConflictError: string | null;
};

export type SharedAreaSyncQueueSummary = SharedSyncQueueSummary;

export const SHARED_SYNC_QUEUE_CHANGED_EVENT = 'punchlist-shared-sync-queue-changed';
export const SHARED_AREA_SYNC_QUEUE_CHANGED_EVENT = SHARED_SYNC_QUEUE_CHANGED_EVENT;

type SyncMetadataStore = {
  get(key: 'pending'): Promise<SyncMetadataRecord | undefined>;
  put(value: SyncMetadataRecord): Promise<'pending'>;
};

type SharedProjectMetadataSyncStore = {
  get(key: string): Promise<PendingSharedProjectMetadataSyncRecord | undefined>;
  put(value: PendingSharedProjectMetadataSyncRecord): Promise<string>;
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
  sharedAreaSyncQueue: {
    key: string;
    value: PendingSharedAreaSyncRecord;
    indexes: { 'by-local-project': string; 'by-queued-at': Date };
  };
  sharedProjectMetadataSyncQueue: {
    key: string;
    value: PendingSharedProjectMetadataSyncRecord;
    indexes: { 'by-local-project': string; 'by-queued-at': Date };
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

function reportSharedSyncQueueChanged() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new Event(SHARED_SYNC_QUEUE_CHANGED_EVENT));
}

let activeLocalWrites = 0;
const failedLocalWrites = new Map<string, string>();

async function runLocalPersistence<T>(operation: () => Promise<T>, scope = 'project'): Promise<T> {
  activeLocalWrites += 1;
  reportLocalSaveStatus({ status: 'saving' });
  try {
    const result = await operation();
    failedLocalWrites.delete(scope);
    return result;
  } catch (error) {
    failedLocalWrites.set(scope, error instanceof Error ? error.message : 'This device could not save the latest change.');
    throw error;
  } finally {
    activeLocalWrites -= 1;
    const message = failedLocalWrites.values().next().value;
    reportLocalSaveStatus(message
      ? { status: 'error', message }
      : { status: activeLocalWrites > 0 ? 'saving' : 'saved' });
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

function projectHasInlineMediaPayload(project: Project) {
  if (project.facadeElevationDrawings?.some((drawing) => Boolean(drawing.dataUrl))) {
    return true;
  }

  for (const area of project.areas) {
    for (const location of area.locations) {
      for (const item of location.items) {
        for (const checkpoint of item.checkpoints) {
          if (checkpoint.photos.some((photo) => Boolean(photo.imageData || photo.thumbnail))) {
            return true;
          }
          if ((checkpoint.files ?? []).some((file) => Boolean(file.data))) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function stripProjectMediaPayloadsIfNeeded(project: Project) {
  return projectHasInlineMediaPayload(project) ? cloneProjectWithoutMediaPayload(project) : project;
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

async function hydrateProjectMedia(
  project: Project,
  mediaRecords: CheckpointMediaRecord[],
  targetAreaId?: string
): Promise<Project> {
  if (mediaRecords.length === 0) {
    return project;
  }

  const hydratedMediaRecords = await Promise.all(
    mediaRecords.map(async (record) => [record.checkpointId, await hydrateMediaRecord(record)] as const)
  );
  const mediaByCheckpoint = new Map(hydratedMediaRecords);

  return {
    ...project,
    areas: project.areas.map((area) => {
      if (targetAreaId && area.id !== targetAreaId) {
        return area;
      }

      return {
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
      };
    }),
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
    dbPromise = openDB<PunchListDB>('punchlist-db', 7, {
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

        if (!db.objectStoreNames.contains('sharedAreaSyncQueue')) {
          const sharedAreaSyncStore = db.createObjectStore('sharedAreaSyncQueue', { keyPath: 'key' });
          sharedAreaSyncStore.createIndex('by-local-project', 'localProjectId');
          sharedAreaSyncStore.createIndex('by-queued-at', 'queuedAt');
        }

        if (!db.objectStoreNames.contains('sharedProjectMetadataSyncQueue')) {
          const metadataSyncStore = db.createObjectStore('sharedProjectMetadataSyncQueue', { keyPath: 'key' });
          metadataSyncStore.createIndex('by-local-project', 'localProjectId');
          metadataSyncStore.createIndex('by-queued-at', 'queuedAt');
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
  // IndexedDB already returns structured clones. Current writes keep binary
  // payloads in dedicated stores, so only legacy inline records need another
  // deep clone before they are exposed as dashboard metadata.
  return projects.map(stripProjectMediaPayloadsIfNeeded);
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
  const projectWithAreaMedia = await hydrateProjectMedia(project, mediaRecords, areaId);
  return hydrateProjectElevationDrawings(projectWithAreaMedia, drawingRecords);
}

export async function getProjectMetadata(id: string): Promise<Project | undefined> {
  const db = await getDB();
  const project = await db.get('projects', id);
  return project ? stripProjectMediaPayloadsIfNeeded(project) : undefined;
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
    const storedProject = cloneProjectWithoutMediaPayload(project);
    const tx = db.transaction(['projects', 'syncMetadata'], 'readwrite');
    await tx.objectStore('projects').put(storedProject);
    if (shouldMarkPending) {
      await markPendingProjectInStore(tx.objectStore('syncMetadata'), project.id);
    }
    await tx.done;
  });
}

export async function saveProjectMetadataWithSharedSync(
  project: Project
): Promise<PendingSharedProjectMetadataSyncRecord | null> {
  let queuedRecord: PendingSharedProjectMetadataSyncRecord | null = null;
  await runLocalPersistence(async () => {
    const db = await getDB();
    project.updatedAt = new Date();
    const tx = db.transaction(
      ['projects', 'syncMetadata', 'sharedProjectMetadataSyncQueue'],
      'readwrite'
    );
    const projectStore = tx.objectStore('projects');
    const existingProject = await projectStore.get(project.id);
    if ((existingProject?.sharedMetadataVersion ?? 0) > (project.sharedMetadataVersion ?? 0)) {
      project.sharedMetadataVersion = existingProject!.sharedMetadataVersion;
    }
    if (
      (existingProject?.sharedMetadataPublishedAt?.getTime() ?? 0)
      > (project.sharedMetadataPublishedAt?.getTime() ?? 0)
    ) {
      project.sharedMetadataPublishedAt = existingProject!.sharedMetadataPublishedAt;
    }
    if (
      (existingProject?.sharedSnapshotPublishedAt?.getTime() ?? 0)
      > (project.sharedSnapshotPublishedAt?.getTime() ?? 0)
    ) {
      project.sharedSnapshotPublishedAt = existingProject!.sharedSnapshotPublishedAt;
    }
    const storedProject = existingProject
      ? {
          ...existingProject,
          projectName: project.projectName,
          address: project.address,
          date: project.date,
          inspector: project.inspector,
          gcName: project.gcName,
          gcSignoff: project.gcSignoff,
          facadeLevelStart: project.facadeLevelStart,
          facadeLevelEnd: project.facadeLevelEnd,
          sharedMetadataVersion: project.sharedMetadataVersion,
          sharedMetadataPublishedAt: project.sharedMetadataPublishedAt,
          sharedSnapshotPublishedAt: project.sharedSnapshotPublishedAt,
          updatedAt: project.updatedAt,
        }
      : cloneProjectWithoutMediaPayload(project);
    await projectStore.put(storedProject);
    await markPendingProjectInStore(tx.objectStore('syncMetadata'), project.id);

    if (storedProject.sharedProjectId && storedProject.sharedSnapshotPublishedAt) {
      queuedRecord = await putPendingSharedProjectMetadataSyncInStore(
        tx.objectStore('sharedProjectMetadataSyncQueue'),
        {
          localProjectId: project.id,
          sharedProjectId: storedProject.sharedProjectId,
          baseVersion: storedProject.sharedMetadataVersion ?? 0,
        }
      );
    }
    await tx.done;
  });
  if (queuedRecord) reportSharedSyncQueueChanged();
  return queuedRecord;
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

    const tx = db.transaction(['projects', 'syncMetadata', 'sharedAreaSyncQueue'], 'readwrite');
    try {
      const projectStore = tx.objectStore('projects');
      const existingProject = await projectStore.get(project.id);
      const storedArea = cloneAreaWithoutMediaPayload(area);

      if (!existingProject) {
        const storedProject = cloneProjectWithoutMediaPayload(project);
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
      await queueSavedArea(tx.objectStore('sharedAreaSyncQueue'), existingProject ?? project, area);
      }
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* It may already have aborted. */ }
      await tx.done.catch(() => {});
      throw error;
    }
    reportSharedSyncQueueChanged();
  });
}

export async function saveProjectArea(
  project: Project,
  areaId: string,
  options: { includeElevationDrawings?: boolean } = {}
): Promise<void> {
  await runLocalPersistence(async () => {
    const area = project.areas.find((entry) => entry.id === areaId);
    if (!area) {
      throw new Error(`Could not save missing project area ${areaId}.`);
    }

    const db = await getDB();
    project.updatedAt = new Date();
    const scopedSerialization = serializeProjectForStorage({
      ...project,
      areas: [area],
    });
    const storedArea = scopedSerialization.storedProject.areas[0];
    const tx = db.transaction(
      ['projects', 'checkpointMedia', 'elevationDrawings', 'syncMetadata', 'sharedAreaSyncQueue'],
      'readwrite'
    );
    try {
      const projectStore = tx.objectStore('projects');
      const mediaStore = tx.objectStore('checkpointMedia');
      const drawingStore = tx.objectStore('elevationDrawings');
      const existingProject = await projectStore.get(project.id);

      if (!existingProject) {
        await projectStore.put(cloneProjectWithoutMediaPayload(project));
      } else {
        const existingIndex = existingProject.areas.findIndex((entry) => entry.id === areaId);
        const nextAreas = [...existingProject.areas];
        if (existingIndex === -1) nextAreas.push(storedArea);
        else nextAreas[existingIndex] = storedArea;
        await projectStore.put({
          ...existingProject,
          updatedAt: project.updatedAt,
          areas: nextAreas,
          ...(options.includeElevationDrawings
            ? { facadeElevationDrawings: scopedSerialization.storedProject.facadeElevationDrawings }
            : {}),
        });
      }
      await markPendingProjectInStore(tx.objectStore('syncMetadata'), project.id);
      await queueSavedArea(tx.objectStore('sharedAreaSyncQueue'), existingProject ?? project, area);

      const existingMediaRecords = await mediaStore.index('by-project-area').getAll([project.id, areaId]);
      const existingMediaByCheckpoint = new Map(
        existingMediaRecords.map((record) => [record.checkpointId, record])
      );
      const nextCheckpointIds = new Set(
        scopedSerialization.mediaRecords.map((record) => record.checkpointId)
      );
      await Promise.all(
        existingMediaRecords
          .filter((record) => !nextCheckpointIds.has(record.checkpointId))
          .map((record) => mediaStore.delete(record.checkpointId))
      );
      await Promise.all(
        scopedSerialization.mediaRecords.map(async (record) => {
          const compactRecord = await compactMediaRecord(record);
          return mediaStore.put(
            preserveExistingMediaPayloads(
              compactRecord,
              existingMediaByCheckpoint.get(record.checkpointId)
            )
          );
        })
      );

      if (options.includeElevationDrawings) {
        const existingDrawingRecords = await drawingStore.index('by-project').getAll(project.id);
        const existingDrawingById = new Map(
          existingDrawingRecords.map((record) => [record.id, record])
        );
        const incomingDrawingPayloadById = new Map(
          scopedSerialization.elevationDrawingRecords.map((record) => [record.id, record.dataUrl])
        );
        const nextDrawingMetadata = scopedSerialization.storedProject.facadeElevationDrawings ?? [];
        const nextDrawingIds = new Set(nextDrawingMetadata.map((drawing) => drawing.id));
        await Promise.all(
          existingDrawingRecords
            .filter((record) => !nextDrawingIds.has(record.id))
            .map((record) => drawingStore.delete(record.id))
        );
        await Promise.all(
          nextDrawingMetadata
            .map((drawing) => {
              const dataUrl = incomingDrawingPayloadById.get(drawing.id)
                || existingDrawingById.get(drawing.id)?.dataUrl
                || '';
              if (!dataUrl) return null;
              return drawingStore.put({
                ...drawing,
                dataUrl,
                projectId: project.id,
              });
            })
            .filter((operation): operation is Promise<string> => operation !== null)
        );
      }

      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* It may already have aborted. */ }
      await tx.done.catch(() => {});
      throw error;
    }
    reportSharedSyncQueueChanged();
  });
}

export async function saveProjectPreserveTimestamps(project: Project): Promise<void> {
  await runLocalPersistence(() => saveProjectInternal(project, { touch: false }));
}

// Read the latest stored record inside the write transaction. A note or photo
// save must not replace another checkpoint's edits with an older React snapshot.
export async function saveCheckpointInspectionChange(
  projectId: string,
  areaId: string,
  checkpointId: string,
  change: Partial<Pick<Checkpoint, 'comments' | 'status' | 'issueState' | 'fixStatus'>>,
  photos: PhotoAttachment[] = [],
  options: { recoveredNote?: { baseValue: string; value: string } } = {},
): Promise<void> {
  const compactPhotos = photos.length
    ? (await compactMediaRecord({ checkpointId, projectId, areaId, photos, files: [] })).photos
    : [];
  await runLocalPersistence(async () => {
    const db = await getDB();
    const tx = db.transaction(['projects', 'checkpointMedia', 'syncMetadata', 'sharedAreaSyncQueue'], 'readwrite');
    try {
      const project = await tx.objectStore('projects').get(projectId);
      const area = project?.areas.find((entry) => entry.id === areaId && !entry.deletedAt);
      const checkpoint = area?.locations.flatMap((location) => location.items)
        .flatMap((item) => item.checkpoints).find((entry) => entry.id === checkpointId);
      if (!project || !area || !checkpoint) {
        tx.abort();
        await tx.done.catch(() => {});
        throw new Error('This checkpoint is no longer available. Your draft is still open.');
      }
      if (options.recoveredNote) {
        const { value, baseValue } = options.recoveredNote;
        const current = checkpoint.comments;
        checkpoint.comments = current === value || (value && current.endsWith(`\n${value}`)) ? current : current === baseValue ? value : `${current.trimEnd()}\n${value}`.trim();
      }
      Object.assign(checkpoint, change, { updatedAt: new Date() });
      if (photos.length) {
        const store = tx.objectStore('checkpointMedia');
        const media = await store.get(checkpointId) ?? { checkpointId, projectId, areaId, photos: [], files: [] };
        const existingIds = new Set(media.photos.map((photo) => photo.id));
        media.photos.push(...compactPhotos.filter((photo) => !existingIds.has(photo.id)));
        const metadataIds = new Set(checkpoint.photos.map((photo) => photo.id));
        checkpoint.photos.push(...photos.filter((photo) => !metadataIds.has(photo.id)).map((photo) => ({ ...photo, imageData: '', thumbnail: undefined })));
        await store.put(media);
      }
      area.updatedAt = new Date();
      area.isComplete = isAreaInspectionComplete(area);
      project.updatedAt = new Date();
      await tx.objectStore('projects').put(project);
      await markPendingProjectInStore(tx.objectStore('syncMetadata'), projectId);
      await queueSavedArea(tx.objectStore('sharedAreaSyncQueue'), project, area);
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* It may already have aborted. */ }
      await tx.done.catch(() => {});
      throw error;
    }
    reportSharedSyncQueueChanged();
  }, `checkpoint:${projectId}:${checkpointId}`);
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
    await deleteProjectCaptureDrafts(id);
    const db = await getDB();
    const tx = db.transaction([
      'projects',
      'checkpointMedia',
      'elevationDrawings',
      'syncMetadata',
      'sharedAreaSyncQueue',
      'sharedProjectMetadataSyncQueue',
    ], 'readwrite');
    await tx.objectStore('projects').delete(id);
    const mediaStore = tx.objectStore('checkpointMedia');
    const mediaRecords = await mediaStore.index('by-project').getAll(id);
    await Promise.all(mediaRecords.map((record) => mediaStore.delete(record.checkpointId)));
    const drawingStore = tx.objectStore('elevationDrawings');
    const drawingRecords = await drawingStore.index('by-project').getAll(id);
    await Promise.all(drawingRecords.map((record) => drawingStore.delete(record.id)));
    const areaSyncStore = tx.objectStore('sharedAreaSyncQueue');
    const areaSyncKeys = await areaSyncStore.index('by-local-project').getAllKeys(id);
    await Promise.all(areaSyncKeys.map((key) => areaSyncStore.delete(key)));
    const metadataSyncStore = tx.objectStore('sharedProjectMetadataSyncQueue');
    const metadataSyncKeys = await metadataSyncStore.index('by-local-project').getAllKeys(id);
    await Promise.all(metadataSyncKeys.map((key) => metadataSyncStore.delete(key)));
    await markFullSyncNeededInStore(tx.objectStore('syncMetadata'));
    await tx.done;
    for (const key of failedLocalWrites.keys()) if (key.startsWith(`checkpoint:${id}:`)) failedLocalWrites.delete(key);
  });
  reportSharedSyncQueueChanged();
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

function getSharedProjectMetadataSyncKey(input: {
  localProjectId: string;
  sharedProjectId: string;
}) {
  return `${input.localProjectId}:${input.sharedProjectId}`;
}

async function putPendingSharedProjectMetadataSyncInStore(
  store: SharedProjectMetadataSyncStore,
  input: PendingSharedProjectMetadataSyncInput
): Promise<PendingSharedProjectMetadataSyncRecord> {
  const key = getSharedProjectMetadataSyncKey(input);
  const existing = await store.get(key);
  const record = {
    key,
    localProjectId: input.localProjectId,
    sharedProjectId: input.sharedProjectId,
    baseVersion: Math.max(existing?.baseVersion ?? 0, input.baseVersion),
    clientId: uuidv4(),
    revision: (existing?.revision ?? 0) + 1,
    attemptCount: 0,
    blockedByConflict: false,
    queuedAt: new Date(),
    lastError: null,
  } satisfies PendingSharedProjectMetadataSyncRecord;
  await store.put(record);
  return record;
}

export async function queuePendingSharedProjectMetadataSync(
  input: PendingSharedProjectMetadataSyncInput
) {
  const db = await getDB();
  const tx = db.transaction('sharedProjectMetadataSyncQueue', 'readwrite');
  const store = tx.objectStore('sharedProjectMetadataSyncQueue');
  const record = await putPendingSharedProjectMetadataSyncInStore(store, input);
  await tx.done;
  reportSharedSyncQueueChanged();
  return record;
}

export async function getPendingSharedProjectMetadataSyncs() {
  const db = await getDB();
  return db.getAllFromIndex('sharedProjectMetadataSyncQueue', 'by-queued-at');
}

export async function getPendingSharedProjectMetadataSyncForProject(localProjectId: string) {
  const db = await getDB();
  const records = await db.getAllFromIndex(
    'sharedProjectMetadataSyncQueue',
    'by-local-project',
    localProjectId
  );
  return records[0];
}

export async function completePendingSharedProjectMetadataSync(input: {
  key: string;
  clientId: string;
  revision: number;
  metadataVersion: number;
  publishedAt: string;
}): Promise<{ stillPending: boolean }> {
  const db = await getDB();
  const tx = db.transaction(['sharedProjectMetadataSyncQueue', 'projects'], 'readwrite');
  const queueStore = tx.objectStore('sharedProjectMetadataSyncQueue');
  const projectStore = tx.objectStore('projects');
  const current = await queueStore.get(input.key);

  if (current) {
    if (current.clientId === input.clientId && current.revision === input.revision) {
      await queueStore.delete(input.key);
    } else if (current.baseVersion < input.metadataVersion) {
      await queueStore.put({
        ...current,
        baseVersion: input.metadataVersion,
        attemptCount: 0,
        blockedByConflict: false,
        lastError: null,
      });
    }

    const project = await projectStore.get(current.localProjectId);
    if (project) {
      const currentMetadataVersion = project.sharedMetadataVersion ?? 0;
      const publishedAt = new Date(input.publishedAt);
      if (
        input.metadataVersion >= currentMetadataVersion
        && !Number.isNaN(publishedAt.getTime())
      ) {
        project.sharedMetadataVersion = input.metadataVersion;
        const currentMetadataPublishedAt = project.sharedMetadataPublishedAt?.getTime() ?? 0;
        if (publishedAt.getTime() >= currentMetadataPublishedAt) {
          project.sharedMetadataPublishedAt = publishedAt;
        }
        const currentProjectPublishedAt = project.sharedSnapshotPublishedAt?.getTime() ?? 0;
        if (publishedAt.getTime() > currentProjectPublishedAt) {
          project.sharedSnapshotPublishedAt = publishedAt;
        }
      }
      await projectStore.put(project);
    }
  }

  await tx.done;
  const stillPending = Boolean(await db.get('sharedProjectMetadataSyncQueue', input.key));
  reportSharedSyncQueueChanged();
  return { stillPending };
}

export async function recordPendingSharedProjectMetadataSyncFailure(
  key: string,
  clientId: string,
  message: string,
  blockedByConflict = false
) {
  const db = await getDB();
  const tx = db.transaction('sharedProjectMetadataSyncQueue', 'readwrite');
  const store = tx.objectStore('sharedProjectMetadataSyncQueue');
  const current = await store.get(key);
  if (current?.clientId === clientId) {
    await store.put({
      ...current,
      attemptCount: current.attemptCount + 1,
      blockedByConflict,
      lastError: message,
    });
  }
  await tx.done;
  reportSharedSyncQueueChanged();
}

export async function discardPendingSharedProjectMetadataSync(key: string) {
  const db = await getDB();
  await db.delete('sharedProjectMetadataSyncQueue', key);
  reportSharedSyncQueueChanged();
}

export async function clearPendingSharedProjectMetadataSyncForProject(localProjectId: string) {
  const db = await getDB();
  const tx = db.transaction('sharedProjectMetadataSyncQueue', 'readwrite');
  const store = tx.objectStore('sharedProjectMetadataSyncQueue');
  const keys = await store.index('by-local-project').getAllKeys(localProjectId);
  await Promise.all(keys.map((key) => store.delete(key)));
  await tx.done;
  reportSharedSyncQueueChanged();
}

export function summarizePendingSharedSyncs(
  records: ReadonlyArray<Pick<
    PendingSharedAreaSyncRecord | PendingSharedProjectMetadataSyncRecord,
    'blockedByConflict' | 'lastError'
  >>
): SharedSyncQueueSummary {
  const conflicts = records.filter((record) => record.blockedByConflict);
  return {
    pendingCount: records.length,
    conflictCount: conflicts.length,
    lastConflictError: conflicts.find((record) => record.lastError)?.lastError ?? null,
  };
}

export async function queuePendingSharedAreaSync(
  input: PendingSharedAreaSyncInput
): Promise<PendingSharedAreaSyncRecord> {
  const [record] = await queuePendingSharedAreaSyncs([input]);
  if (!record) {
    throw new Error('Could not queue the shared area update.');
  }
  return record;
}

type SharedAreaQueueStore = {
  get(key: string): Promise<PendingSharedAreaSyncRecord | undefined>;
  put(value: PendingSharedAreaSyncRecord): Promise<string>;
};

async function putPendingAreaInStore(store: SharedAreaQueueStore, input: PendingSharedAreaSyncInput) {
  const key = `${input.localProjectId}:${input.sharedProjectId}:${input.areaId}`;
  const existing = await store.get(key);
  const inputBasePublishedAt = new Date(input.basePublishedAt).getTime();
  const existingBasePublishedAt = existing ? new Date(existing.basePublishedAt).getTime() : 0;
  const shouldUseInputBase = !existing
    || input.baseVersion > existing.baseVersion
    || (
    input.baseVersion === existing.baseVersion
    && Number.isFinite(inputBasePublishedAt)
    && inputBasePublishedAt > existingBasePublishedAt
    );
  const record: PendingSharedAreaSyncRecord = {
    key,
    localProjectId: input.localProjectId,
    sharedProjectId: input.sharedProjectId,
    areaId: input.areaId,
    baseVersion: shouldUseInputBase ? input.baseVersion : existing!.baseVersion,
    basePublishedAt: shouldUseInputBase ? input.basePublishedAt : existing!.basePublishedAt,
    clientId: uuidv4(),
    revision: (existing?.revision ?? 0) + 1,
    attemptCount: 0,
    blockedByConflict: false,
    readyAfterConflictReview: false,
    queuedAt: new Date(),
    lastError: null,
  };
  await store.put(record);
  return record;
}

async function queueSavedArea(store: SharedAreaQueueStore, project: Project, area: Area) {
  if (!project.sharedProjectId || !project.sharedSnapshotPublishedAt) return;
  await putPendingAreaInStore(store, {
    localProjectId: project.id,
    sharedProjectId: project.sharedProjectId,
    areaId: area.id,
    baseVersion: area.sharedVersion ?? 0,
    basePublishedAt: (area.sharedPublishedAt ?? project.sharedBaselinePublishedAt ?? project.sharedSnapshotPublishedAt).toISOString(),
  });
}

export async function queuePendingSharedAreaSyncs(
  inputs: ReadonlyArray<PendingSharedAreaSyncInput>
): Promise<PendingSharedAreaSyncRecord[]> {
  if (inputs.length === 0) return [];
  const db = await getDB();
  const tx = db.transaction('sharedAreaSyncQueue', 'readwrite');
  const store = tx.objectStore('sharedAreaSyncQueue');
  const uniqueInputs = [...new Map(
    inputs.map((input) => [
      `${input.localProjectId}:${input.sharedProjectId}:${input.areaId}`,
      input,
    ])
  ).values()];
  const records: PendingSharedAreaSyncRecord[] = [];
  for (const input of uniqueInputs) {
    const record = await putPendingAreaInStore(store, input);
    records.push(record);
  }
  await tx.done;
  reportSharedSyncQueueChanged();
  return records;
}

export async function getPendingSharedAreaSyncs(): Promise<PendingSharedAreaSyncRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('sharedAreaSyncQueue', 'by-queued-at');
}

export async function getPendingSharedAreaSyncsForProject(localProjectId: string) {
  const db = await getDB();
  return db.getAllFromIndex('sharedAreaSyncQueue', 'by-local-project', localProjectId);
}

export function summarizePendingSharedAreaSyncs(
  records: ReadonlyArray<PendingSharedAreaSyncRecord>
): SharedAreaSyncQueueSummary {
  return summarizePendingSharedSyncs(records);
}

export async function completePendingSharedAreaSync(input: {
  key: string;
  clientId: string;
  revision: number;
  areaVersion: number;
  publishedAt: string;
}): Promise<{ stillPending: boolean }> {
  const db = await getDB();
  const tx = db.transaction(['sharedAreaSyncQueue', 'projects'], 'readwrite');
  const queueStore = tx.objectStore('sharedAreaSyncQueue');
  const projectStore = tx.objectStore('projects');
  const current = await queueStore.get(input.key);

  if (current) {
    if (current.clientId === input.clientId && current.revision === input.revision) {
      await queueStore.delete(input.key);
    } else if (current.baseVersion < input.areaVersion) {
      await queueStore.put({
        ...current,
        baseVersion: input.areaVersion,
        basePublishedAt: input.publishedAt,
        attemptCount: 0,
        blockedByConflict: false,
        lastError: null,
      });
    }

    const project = await projectStore.get(current.localProjectId);
    if (project) {
      const area = project.areas.find((entry) => entry.id === current.areaId);
      if (area) {
        const currentAreaVersion = area.sharedVersion ?? 0;
        const publishedAt = new Date(input.publishedAt);
        if (
          input.areaVersion >= currentAreaVersion
          && !Number.isNaN(publishedAt.getTime())
        ) {
          area.sharedVersion = input.areaVersion;
          const currentAreaPublishedAt = area.sharedPublishedAt?.getTime() ?? 0;
          if (publishedAt.getTime() >= currentAreaPublishedAt) {
            area.sharedPublishedAt = publishedAt;
          }
          const currentProjectPublishedAt = project.sharedSnapshotPublishedAt?.getTime() ?? 0;
          if (publishedAt.getTime() > currentProjectPublishedAt) {
            project.sharedSnapshotPublishedAt = publishedAt;
          }
        }
        await projectStore.put(project);
      }
    }
  }

  await tx.done;
  const stillPending = Boolean(await db.get('sharedAreaSyncQueue', input.key));
  reportSharedSyncQueueChanged();
  return { stillPending };
}

export async function recordPendingSharedAreaSyncFailure(
  key: string,
  clientId: string,
  message: string,
  blockedByConflict = false
) {
  const db = await getDB();
  const tx = db.transaction('sharedAreaSyncQueue', 'readwrite');
  const store = tx.objectStore('sharedAreaSyncQueue');
  const current = await store.get(key);
  if (current?.clientId === clientId) {
    await store.put({
      ...current,
      attemptCount: current.attemptCount + 1,
      blockedByConflict,
      readyAfterConflictReview: false,
      lastError: message,
    });
  }
  await tx.done;
  reportSharedSyncQueueChanged();
}

export async function rebasePendingSharedAreaSyncsForReview(
  inputs: ReadonlyArray<PendingSharedAreaSyncInput>
): Promise<PendingSharedAreaSyncRecord[]> {
  if (inputs.length === 0) return [];
  const db = await getDB();
  const tx = db.transaction('sharedAreaSyncQueue', 'readwrite');
  const store = tx.objectStore('sharedAreaSyncQueue');
  const records: PendingSharedAreaSyncRecord[] = [];
  const uniqueInputs = [...new Map(
    inputs.map((input) => [
      `${input.localProjectId}:${input.sharedProjectId}:${input.areaId}`,
      input,
    ])
  ).values()];

  for (const input of uniqueInputs) {
    const key = `${input.localProjectId}:${input.sharedProjectId}:${input.areaId}`;
    const existing = await store.get(key);
    const record: PendingSharedAreaSyncRecord = {
      key,
      localProjectId: input.localProjectId,
      sharedProjectId: input.sharedProjectId,
      areaId: input.areaId,
      baseVersion: input.baseVersion,
      basePublishedAt: input.basePublishedAt,
      clientId: uuidv4(),
      revision: (existing?.revision ?? 0) + 1,
      attemptCount: 0,
      blockedByConflict: true,
      readyAfterConflictReview: true,
      queuedAt: existing?.queuedAt ?? new Date(),
      lastError: 'Team updates were merged. Review this area, then tap Send to Team.',
    };
    await store.put(record);
    records.push(record);
  }

  await tx.done;
  reportSharedSyncQueueChanged();
  return records;
}

export async function resumeReviewedPendingSharedAreaSyncs(localProjectId: string) {
  const db = await getDB();
  const tx = db.transaction('sharedAreaSyncQueue', 'readwrite');
  const store = tx.objectStore('sharedAreaSyncQueue');
  const records = await store.index('by-local-project').getAll(localProjectId);
  let resumed = 0;

  for (const record of records) {
    if (!record.blockedByConflict || !record.readyAfterConflictReview) continue;
    await store.put({
      ...record,
      attemptCount: 0,
      blockedByConflict: false,
      readyAfterConflictReview: false,
      lastError: null,
    });
    resumed += 1;
  }

  await tx.done;
  if (resumed > 0) reportSharedSyncQueueChanged();
  return resumed;
}

export async function discardPendingSharedAreaSync(key: string) {
  const db = await getDB();
  await db.delete('sharedAreaSyncQueue', key);
  reportSharedSyncQueueChanged();
}

export async function clearPendingSharedAreaSyncsForProject(
  localProjectId: string,
  expectedRecords?: ReadonlyArray<Pick<PendingSharedAreaSyncRecord, 'key' | 'clientId' | 'revision'>>
) {
  const db = await getDB();
  const tx = db.transaction('sharedAreaSyncQueue', 'readwrite');
  const store = tx.objectStore('sharedAreaSyncQueue');
  if (expectedRecords) {
    for (const expected of expectedRecords) {
      const current = await store.get(expected.key);
      if (
        current?.localProjectId === localProjectId
        && current.clientId === expected.clientId
        && current.revision === expected.revision
      ) {
        await store.delete(expected.key);
      }
    }
  } else {
    const keys = await store.index('by-local-project').getAllKeys(localProjectId);
    await Promise.all(keys.map((key) => store.delete(key)));
  }
  await tx.done;
  reportSharedSyncQueueChanged();
}

export async function clearPendingSharedSyncsForProject(localProjectId: string) {
  const db = await getDB();
  const tx = db.transaction(
    ['sharedAreaSyncQueue', 'sharedProjectMetadataSyncQueue'],
    'readwrite'
  );
  const areaStore = tx.objectStore('sharedAreaSyncQueue');
  const metadataStore = tx.objectStore('sharedProjectMetadataSyncQueue');
  const [areaKeys, metadataKeys] = await Promise.all([
    areaStore.index('by-local-project').getAllKeys(localProjectId),
    metadataStore.index('by-local-project').getAllKeys(localProjectId),
  ]);
  await Promise.all([
    ...areaKeys.map((key) => areaStore.delete(key)),
    ...metadataKeys.map((key) => metadataStore.delete(key)),
  ]);
  await tx.done;
  reportSharedSyncQueueChanged();
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
