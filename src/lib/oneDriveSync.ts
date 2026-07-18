import { Area, Checkpoint, FileAttachment, Item, Location, PhotoAttachment, Project } from '@/types';
import { splitFacadeLevels } from '@/lib/areas';
import { parseProjectPayload, serializeProjectPayload } from '@/lib/projectPayload';
import { readLocalStorage, writeLocalStorage } from '@/lib/browserStorage';
import {
  getAllProjects,
  getProject,
  saveProjectPreserveTimestamps,
} from '@/lib/db';
import {
  ensurePunchListFolders,
  listProjectFiles,
  downloadProjectFile,
  downloadDriveItemAsDataUrl,
  uploadProjectFile,
  listPhotoProjectFolders,
  listProjectPhotoFiles,
  listProjectExportFiles,
  uploadProjectPhotoFile,
  deleteDriveItem,
  deleteProjectPhotoFolder,
  deleteProjectFolder,
  deleteProjectFoldersFromState,
  moveDriveItemToFolder,
  downloadDeletionLog,
  uploadDeletionLog,
  acquireSyncLease,
  cleanupLegacyPunchListFolders,
  type DriveItem,
} from '@/lib/oneDrive';

export type SyncConflict = { id: string; name: string };

export type SyncResult = {
  conflicts: SyncConflict[];
  syncedAt: string;
};

export type SyncOptions = {
  pushProjectIds?: string[];
};

export type PushSyncResult = {
  conflicts: SyncConflict[];
};

type RemoteProjectFile = {
  id: string;
  name: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  punchlistPath?: string;
};

type ProjectSyncState = {
  updatedAt: string;
};

type ProjectSyncStateMap = Record<string, ProjectSyncState>;

type OneDriveSyncRemoteIndex = {
  photoProjectFolders?: DriveItem[];
};

const STORAGE_KEY = 'punchlist-onedrive-last-sync';
const DELETIONS_KEY = 'punchlist-onedrive-deletions';
// Allow a small clock-skew window between devices/Graph timestamps,
// but do not suppress normal recent edits.
const CLOCK_SKEW_TOLERANCE_MS = 2_000;

function setLastSyncTime(date: Date) {
  writeLocalStorage(STORAGE_KEY, date.toISOString());
}

function timestampMs(value: string | Date | undefined) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function getProjectUpdatedAt(project: Pick<Project, 'updatedAt'> | Project | null | undefined) {
  if (!project) return 0;

  let newest = timestampMs(project.updatedAt);
  const fullProject = project as Partial<Project>;
  if (!Array.isArray(fullProject.areas)) {
    return newest;
  }

  for (const area of fullProject.areas) {
    newest = Math.max(newest, timestampMs(area.updatedAt), timestampMs(area.deletedAt));
    for (const location of area.locations ?? []) {
      newest = Math.max(newest, timestampMs(location.updatedAt));
      for (const item of location.items ?? []) {
        newest = Math.max(newest, timestampMs(item.updatedAt));
        for (const checkpoint of item.checkpoints ?? []) {
          newest = Math.max(newest, timestampMs(checkpoint.updatedAt));
        }
      }
    }
  }

  return newest;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
) {
  if (items.length === 0) return;
  const size = Math.max(1, Math.min(limit, items.length));
  let index = 0;

  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      await worker(items[current]);
    }
  });

  await Promise.all(runners);
}

function sanitizeNamePart(value: string | undefined, fallback: string) {
  const cleaned = (value ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

function projectJsonFilename(project: Pick<Project, 'id' | 'projectName'>) {
  return `${sanitizeNamePart(project.projectName, 'project')}_${project.id}.json`;
}

function currentProjectFolderName(project: Pick<Project, 'projectName'>) {
  return sanitizeNamePart(project.projectName, 'project');
}

function projectFolderName(project: Pick<Project, 'projectName' | 'oneDriveFolderName'>) {
  return sanitizeNamePart(project.oneDriveFolderName, currentProjectFolderName(project));
}

function isProjectInTrash(project: Pick<Project, 'deletedAt'>) {
  return !!project.deletedAt;
}

function getProjectIdFromFilename(name: string) {
  const match = name.match(/([0-9a-f-]{36})\.json$/i);
  return match?.[1] ?? null;
}

function getProjectFolderNameFromRemoteFile(file: Pick<RemoteProjectFile, 'punchlistPath'>) {
  const path = file.punchlistPath;
  if (!path) return null;
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 3) return null;
  const parent = segments[segments.length - 2];
  return parent === 'projects' ? null : parent;
}

function isRemoteProjectFileInTrash(file: Pick<RemoteProjectFile, 'punchlistPath'>) {
  return file.punchlistPath?.startsWith('PunchList/Trash Bin/') ?? false;
}

function isRemoteProjectFolderInTrash(folder: Pick<RemoteProjectFile, 'punchlistPath'>) {
  return folder.punchlistPath?.startsWith('PunchList/Trash Bin/') ?? false;
}

function isLegacyPhotoFolder(folder: Pick<RemoteProjectFile, 'punchlistPath'>) {
  return folder.punchlistPath?.startsWith('PunchList/photos/') ?? false;
}

function buildRemoteProjectFileIndex(remoteFiles: RemoteProjectFile[]) {
  const remoteById = new Map<string, typeof remoteFiles>();
  for (const file of remoteFiles) {
    if (!file.name.endsWith('.json')) continue;
    const projectId = getProjectIdFromFilename(file.name);
    if (!projectId) continue;
    const existing = remoteById.get(projectId);
    if (existing) {
      existing.push(file);
    } else {
      remoteById.set(projectId, [file]);
    }
  }
  return remoteById;
}

function pickPrimaryRemoteProjectFile<
  T extends { id: string; name: string; lastModifiedDateTime?: string; eTag?: string; punchlistPath?: string }
>(remoteFiles: T[]): T | undefined {
  return [...remoteFiles].sort(
    (left, right) => timestampMs(right.lastModifiedDateTime) - timestampMs(left.lastModifiedDateTime)
  )[0];
}

async function deleteStaleRemoteProjectFiles(
  token: string,
  project: Pick<Project, 'id' | 'projectName' | 'oneDriveFolderName'>,
  remoteFiles: RemoteProjectFile[],
  trashed: boolean,
  targetFolderName: string,
  keepRemoteId?: string
) {
  const targetFilename = projectJsonFilename(project);
  await runWithConcurrency(
    remoteFiles.filter((file) => {
      if (keepRemoteId && file.id === keepRemoteId) return false;
      return (
        file.name !== targetFilename ||
        getProjectFolderNameFromRemoteFile(file) !== targetFolderName ||
        isRemoteProjectFileInTrash(file) !== trashed
      );
    }),
    2,
    async (file) => {
      try {
        await deleteDriveItem(token, file.id);
      } catch (error) {
        if (!isItemNotFoundError(error)) {
          throw error;
        }
      }
    }
  );
}

function getProjectAreaNames(project: Project) {
  return new Map(project.areas.map((area) => [area.id, area.name]));
}

function getCheckpointAreaIdByCheckpointId(project: Project) {
  const checkpointAreaIds = new Map<string, string>();
  for (const area of project.areas ?? []) {
    for (const location of area.locations ?? []) {
      for (const item of location.items ?? []) {
        for (const checkpoint of item.checkpoints ?? []) {
          checkpointAreaIds.set(checkpoint.id, area.id);
        }
      }
    }
  }
  return checkpointAreaIds;
}

function projectPhotoFilename(
  project: Project,
  photo: Pick<PhotoAttachment, 'id' | 'checkpointId'>,
  index: number
) {
  const areaNames = getProjectAreaNames(project);
  const checkpointAreaIds = getCheckpointAreaIdByCheckpointId(project);
  const areaId = checkpointAreaIds.get(photo.checkpointId);
  const areaName = areaId ? areaNames.get(areaId) : undefined;
  const projectName = sanitizeNamePart(project.projectName, 'project');
  const safeAreaName = sanitizeNamePart(areaName, 'area');
  const sequence = String(index + 1).padStart(3, '0');
  return `${projectName}_${safeAreaName}_${sequence}_${photo.id}.jpg`;
}

function getLegacyProjectFolderNames(project: Pick<Project, 'id' | 'projectName' | 'oneDriveFolderName'>) {
  const currentFolder = currentProjectFolderName(project);
  const stableFolder = projectFolderName(project);
  return [
    `${currentFolder}_${project.id}`,
    project.id,
    ...(currentFolder !== stableFolder ? [currentFolder] : []),
  ];
}

function getProjectFolderIdFromName(name: string) {
  const match = name.match(/_([0-9a-f-]{36})$/i);
  return match?.[1] ?? null;
}

function isCanonicalRemoteProjectFile(
  project: Pick<Project, 'id' | 'projectName' | 'oneDriveFolderName' | 'deletedAt'>,
  file: RemoteProjectFile,
  targetFolderName = projectFolderName(project)
) {
  return (
    file.name === projectJsonFilename(project) &&
    getProjectFolderNameFromRemoteFile(file) === targetFolderName &&
    isRemoteProjectFileInTrash(file) === isProjectInTrash(project)
  );
}

function resolveRemoteProjectFolderName(
  project: Pick<Project, 'projectName' | 'oneDriveFolderName'>,
  remoteFiles: RemoteProjectFile[]
) {
  const currentFolder = currentProjectFolderName(project);
  if (remoteFiles.some((file) => getProjectFolderNameFromRemoteFile(file) === currentFolder)) {
    return currentFolder;
  }
  const remote = pickPrimaryRemoteProjectFile(remoteFiles);
  return (remote ? getProjectFolderNameFromRemoteFile(remote) : null) ?? projectFolderName(project);
}

function withProjectFolderName<T extends Project>(project: T, folderName?: string | null): T {
  if (!folderName) return project;
  if (project.oneDriveFolderName === folderName) return project;
  return {
    ...project,
    oneDriveFolderName: folderName,
  };
}

function uniqueFolderNames(names: Array<string | null | undefined>) {
  return [...new Set(names.filter((name): name is string => Boolean(name)))];
}

function getProjectFolderCleanupNames(
  project: Pick<Project, 'id' | 'projectName' | 'oneDriveFolderName'>,
  remoteEntries: RemoteProjectFile[],
  targetFolderName: string
) {
  return uniqueFolderNames([
    targetFolderName,
    projectFolderName(project),
    currentProjectFolderName(project),
    ...getLegacyProjectFolderNames(project),
    ...remoteEntries.map((entry) => getProjectFolderNameFromRemoteFile(entry)),
  ]);
}

function getProjectExportsFolderPath(projectFolderName: string, trashed: boolean) {
  return `PunchList${trashed ? '/Trash Bin' : ''}/${projectFolderName}/exports`;
}

function buildMigratedExportName(filename: string, sourceFolderName: string) {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) {
    return `${filename}_${sourceFolderName}`;
  }
  return `${filename.slice(0, dotIndex)}_${sourceFolderName}${filename.slice(dotIndex)}`;
}

function getProjectPhotosFolderPath(projectFolderName: string, trashed: boolean) {
  return `PunchList${trashed ? '/Trash Bin' : ''}/${projectFolderName}/photos`;
}

async function migrateLegacyProjectExports(
  token: string,
  remoteEntries: RemoteProjectFile[],
  targetFolderName: string,
  trashed: boolean
) {
  const sourceFolderNames = uniqueFolderNames(
    remoteEntries.map((entry) => getProjectFolderNameFromRemoteFile(entry))
  ).filter((folderName) => folderName !== targetFolderName);

  if (sourceFolderNames.length === 0) {
    return;
  }

  const destinationFolderPath = getProjectExportsFolderPath(targetFolderName, trashed);

  await runWithConcurrency(sourceFolderNames, 2, async (sourceFolderName) => {
    const exportFiles = await listProjectExportFiles(token, sourceFolderName, trashed);
    await runWithConcurrency(
      exportFiles.filter((file) => file.id),
      2,
      async (file) => {
        try {
          await moveDriveItemToFolder(token, file.id, destinationFolderPath);
        } catch (error) {
          if (isItemNotFoundError(error)) {
            return;
          }
          if (!(error instanceof Error) || !error.message.toLowerCase().includes('already exists')) {
            throw error;
          }
          await moveDriveItemToFolder(
            token,
            file.id,
            destinationFolderPath,
            buildMigratedExportName(file.name, sourceFolderName)
          );
        }
      }
    );
  });
}

async function migrateCrossStateProjectExports(
  token: string,
  sourceFolderNames: string[],
  targetFolderName: string,
  trashed: boolean
) {
  if (sourceFolderNames.length === 0) {
    return;
  }

  const destinationFolderPath = getProjectExportsFolderPath(targetFolderName, trashed);
  const sourceLabel = trashed ? 'active' : 'trash';

  await runWithConcurrency(sourceFolderNames, 2, async (sourceFolderName) => {
    const sourceExports = await listProjectExportFiles(token, sourceFolderName, !trashed);
    await runWithConcurrency(
      sourceExports.filter((file) => file.id),
      2,
      async (file) => {
        try {
          await moveDriveItemToFolder(token, file.id, destinationFolderPath);
        } catch (error) {
          if (isItemNotFoundError(error)) {
            return;
          }
          if (!(error instanceof Error) || !error.message.toLowerCase().includes('already exists')) {
            throw error;
          }
          await moveDriveItemToFolder(
            token,
            file.id,
            destinationFolderPath,
            buildMigratedExportName(file.name, sourceLabel)
          );
        }
      }
    );
  });
}

async function migratePhotosToFolder(
  token: string,
  photoFiles: Awaited<ReturnType<typeof listProjectPhotoFiles>>,
  destinationFolderPath: string
) {
  await runWithConcurrency(
    photoFiles.filter((file) => file.id),
    3,
    async (file) => {
      try {
        await moveDriveItemToFolder(token, file.id, destinationFolderPath);
      } catch (error) {
        if (isItemNotFoundError(error)) {
          return;
        }
        if (!(error instanceof Error) || !error.message.toLowerCase().includes('already exists')) {
          throw error;
        }
        try {
          await deleteDriveItem(token, file.id);
        } catch (deleteError) {
          if (!isItemNotFoundError(deleteError)) {
            throw deleteError;
          }
        }
      }
    }
  );
}

async function migrateLegacyProjectPhotos(
  token: string,
  project: Pick<Project, 'id' | 'projectName' | 'oneDriveFolderName' | 'deletedAt'>,
  targetFolderName: string,
  sourceFolderNames = uniqueFolderNames([
    targetFolderName,
    currentProjectFolderName(project),
    ...getLegacyProjectFolderNames(project),
  ])
) {
  const trashed = isProjectInTrash(project);
  const destinationFolderPath = getProjectPhotosFolderPath(targetFolderName, trashed);

  // When trash state changes (trash or restore), photos live in the opposite path.
  // Move them to the correct destination before the old folder is deleted.
  await runWithConcurrency(sourceFolderNames, 2, async (sourceFolderName) => {
    const crossStatePhotos = await listProjectPhotoFiles(token, sourceFolderName, !trashed, false);
    if (crossStatePhotos.length > 0) {
      await migratePhotosToFolder(token, crossStatePhotos, destinationFolderPath);
    }
  });

  const legacySourceNames = sourceFolderNames.filter((folderName) => folderName !== targetFolderName);

  if (legacySourceNames.length === 0) {
    return;
  }

  await runWithConcurrency(legacySourceNames, 2, async (sourceFolderName) => {
    const photoFiles = await listProjectPhotoFiles(token, sourceFolderName, trashed, false);
    await migratePhotosToFolder(token, photoFiles, destinationFolderPath);
  });
}

function getPhotoIdFromFilename(name: string) {
  const match = name.match(/_([0-9a-f-]{36})\.jpg$/i);
  return match?.[1] ?? null;
}

function getProjectPhotos(project: Project) {
  const photos: PhotoAttachment[] = [];
  for (const area of project.areas ?? []) {
    for (const location of area.locations ?? []) {
      for (const item of location.items ?? []) {
        for (const checkpoint of item.checkpoints ?? []) {
          photos.push(...(checkpoint.photos ?? []));
        }
      }
    }
  }
  return photos;
}

function normalizeProjectPhotos(project: Project): Project {
  return {
    ...project,
    areas: (project.areas ?? []).map((area) => ({
      ...area,
      locations: (area.locations ?? []).map((location) => ({
        ...location,
        items: (location.items ?? []).map((item) => ({
          ...item,
          checkpoints: (item.checkpoints ?? []).map((checkpoint) => {
            const photoMap = new Map<string, PhotoAttachment>();
            for (const photo of checkpoint.photos ?? []) {
              const existing = photoMap.get(photo.id);
              if (!existing) {
                photoMap.set(photo.id, photo);
                continue;
              }
              if (!existing.imageData && photo.imageData) {
                photoMap.set(photo.id, photo);
              }
            }
            return {
              ...checkpoint,
              photos: [...photoMap.values()],
            };
          }),
        })),
      })),
    })),
  };
}

async function getPhotoProjectFoldersForSync(
  token: string,
  remoteIndex?: OneDriveSyncRemoteIndex
) {
  if (remoteIndex?.photoProjectFolders) {
    return remoteIndex.photoProjectFolders;
  }
  const folders = await listPhotoProjectFolders(token);
  if (remoteIndex) {
    remoteIndex.photoProjectFolders = folders;
  }
  return folders;
}

async function hydrateProjectPhotosFromOneDrive(
  token: string,
  project: Project,
  preferredFolderName?: string,
  remoteIndex?: OneDriveSyncRemoteIndex
): Promise<Project> {
  const normalizedProject = withProjectFolderName(
    normalizeProjectPhotos(project),
    preferredFolderName
  );
  const remoteFolders = await getPhotoProjectFoldersForSync(token, remoteIndex);
  const candidateFolderNames = [
    projectFolderName(normalizedProject),
    ...getLegacyProjectFolderNames(normalizedProject),
  ];
  const candidateFolders = remoteFolders.filter((entry) => {
    if (isRemoteProjectFolderInTrash(entry) !== isProjectInTrash(normalizedProject)) {
      return false;
    }
    return candidateFolderNames.includes(entry.name);
  });

  if (candidateFolders.length === 0) {
    return normalizedProject;
  }

  const remotePhotoSets = await Promise.all(
    candidateFolders.map((folder) =>
      listProjectPhotoFiles(token, folder.name, isProjectInTrash(normalizedProject), true)
    )
  );
  const remotePhotos = remotePhotoSets.flat();
  const remotePhotoById = new Map(
    remotePhotos
      .map((photo) => {
        const photoId = getPhotoIdFromFilename(photo.name);
        return photoId ? [photoId, photo] : null;
      })
      .filter((entry): entry is [string, typeof remotePhotos[number]] => entry !== null)
  );

  const missingPhotos: Array<{ photo: PhotoAttachment; driveItemId: string }> = [];
  for (const area of normalizedProject.areas ?? []) {
    for (const location of area.locations ?? []) {
      for (const item of location.items ?? []) {
        for (const checkpoint of item.checkpoints ?? []) {
          for (const photo of checkpoint.photos ?? []) {
            if (photo.imageData) {
              continue;
            }
            const driveItem = remotePhotoById.get(photo.id);
            if (!driveItem?.id) {
              continue;
            }
            missingPhotos.push({ photo, driveItemId: driveItem.id });
          }
        }
      }
    }
  }

  await runWithConcurrency(missingPhotos, 3, async ({ photo, driveItemId }) => {
    try {
      const dataUrl = await downloadDriveItemAsDataUrl(token, driveItemId);
      photo.imageData = dataUrl;
    } catch (error) {
      if (!isItemNotFoundError(error)) {
        throw error;
      }
    }
  });

  return normalizedProject;
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) {
    throw new Error('Photo data is not in a supported format.');
  }

  const mimeType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3];
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

async function syncProjectPhotosToOneDrive(
  token: string,
  project: Project,
  targetFolderName = projectFolderName(project),
  remoteIndex?: OneDriveSyncRemoteIndex
): Promise<void> {
  const localPhotos = getProjectPhotos(project);
  const trashed = isProjectInTrash(project);
  const expectedNames = new Set(
    localPhotos.map((photo, index) => projectPhotoFilename(project, photo, index))
  );
  const expectedPhotoIds = new Set(localPhotos.map((photo) => photo.id));
  const remoteFolders = await getPhotoProjectFoldersForSync(token, remoteIndex);
  const matchingFolder = remoteFolders.find(
    (folder) => folder.name === targetFolderName && isRemoteProjectFolderInTrash(folder) === trashed
  );
  // listPhotoProjectFolders includes real project folders too; only delete old PunchList/photos/* folders here.
  const legacyPhotoFolders = remoteFolders.filter((folder) => {
    if (!isLegacyPhotoFolder(folder)) return false;
    if (folder.name === targetFolderName && isRemoteProjectFolderInTrash(folder) === trashed) return false;
    const folderProjectId = getProjectFolderIdFromName(folder.name);
    return (
      folderProjectId === project.id ||
      getLegacyProjectFolderNames(project).includes(folder.name) ||
      folder.name === currentProjectFolderName(project)
    );
  });
  const remotePhotos = matchingFolder
    ? await listProjectPhotoFiles(token, matchingFolder.name, trashed, false)
    : [];
  const remoteNames = new Set(remotePhotos.map((photo) => photo.name));
  const remotePhotoIds = new Set(
    remotePhotos
      .map((photo) => getPhotoIdFromFilename(photo.name))
      .filter((photoId): photoId is string => Boolean(photoId))
  );

  await runWithConcurrency(localPhotos.map((photo, index) => ({ photo, index })), 3, async ({ photo, index }) => {
    const filename = projectPhotoFilename(project, photo, index);
    if (remoteNames.has(filename) || remotePhotoIds.has(photo.id) || !photo.imageData) {
      return;
    }
    const blob = await dataUrlToBlob(photo.imageData);
    await uploadProjectPhotoFile(token, targetFolderName, filename, blob, trashed);
  });

  await runWithConcurrency(
    remotePhotos.filter((photo) => {
      if (!photo.id) return false;
      if (expectedNames.has(photo.name)) return false;
      const remotePhotoId = getPhotoIdFromFilename(photo.name);
      return !remotePhotoId || !expectedPhotoIds.has(remotePhotoId);
    }),
    3,
    async (photo) => {
      try {
        await deleteDriveItem(token, photo.id);
      } catch (error) {
        if (!isItemNotFoundError(error)) {
          throw error;
        }
      }
    }
  );

  await runWithConcurrency(
    legacyPhotoFolders.filter((folder) => folder.id),
    2,
    async (folder) => {
      try {
        await deleteDriveItem(token, folder.id);
      } catch (error) {
        if (!isItemNotFoundError(error)) {
          throw error;
        }
      }
    }
  );
}

async function syncProjectStorageToOneDriveState(
  token: string,
  project: Project,
  remoteEntries: RemoteProjectFile[],
  targetFolderName: string,
  remoteIndex?: OneDriveSyncRemoteIndex
) {
  const trashed = isProjectInTrash(project);
  const sourceFolderNames = getProjectFolderCleanupNames(project, remoteEntries, targetFolderName);

  await migrateLegacyProjectPhotos(token, project, targetFolderName, sourceFolderNames);
  await migrateCrossStateProjectExports(token, sourceFolderNames, targetFolderName, trashed);
  await migrateLegacyProjectExports(token, remoteEntries, targetFolderName, trashed);
  await syncProjectPhotosToOneDrive(token, project, targetFolderName, remoteIndex);
  await deleteProjectFoldersFromState(token, sourceFolderNames, !trashed, project.id);
}

function isConflictError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('precondition failed') ||
    message.includes('etag mismatch') ||
    message.includes('resource has changed') ||
    message.includes('caller last read') ||
    message.includes('name already exists') ||
    message.includes('already exists')
  );
}

async function uploadProjectFileRecoveringMissingRemote(
  token: string,
  projectFolderName: string,
  filename: string,
  content: string,
  trashed: boolean,
  etag?: string
) {
  try {
    return await uploadProjectFile(token, projectFolderName, filename, content, trashed, etag);
  } catch (error) {
    if (etag && isItemNotFoundError(error)) {
      return uploadProjectFile(token, projectFolderName, filename, content, trashed);
    }
    throw error;
  }
}

function isItemNotFoundError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('itemnotfound') ||
    message.includes('item not found') ||
    message.includes('404') ||
    message.includes('resource could not be found') ||
    message.includes('resource not found')
  );
}

function normalizeSyncStateMap(raw: unknown): ProjectSyncStateMap {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const normalized: ProjectSyncStateMap = {};

  for (const [projectId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      normalized[projectId] = {
        updatedAt: value,
      };
      continue;
    }

    if (!value || typeof value !== 'object') {
      continue;
    }

    const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
    if (typeof updatedAt !== 'string') {
      continue;
    }

    normalized[projectId] = { updatedAt };
  }

  return normalized;
}

function getLocalSyncStates(): ProjectSyncStateMap {
  try {
    const raw = readLocalStorage(DELETIONS_KEY);
    if (!raw) return {};
    return normalizeSyncStateMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

function setLocalSyncStates(syncStates: ProjectSyncStateMap) {
  writeLocalStorage(DELETIONS_KEY, JSON.stringify(syncStates));
}

function isAfterOrEqual(left: string, right: string | undefined) {
  if (!right) return true;
  return new Date(left).getTime() >= new Date(right).getTime();
}

function compareTimestampsWithTolerance(
  left: string | Date | number | undefined,
  right: string | Date | number | undefined,
  toleranceMs = CLOCK_SKEW_TOLERANCE_MS
) {
  const leftMs = typeof left === 'number' ? left : timestampMs(left);
  const rightMs = typeof right === 'number' ? right : timestampMs(right);
  const difference = leftMs - rightMs;
  if (difference > toleranceMs) return 1;
  if (difference < -toleranceMs) return -1;
  return 0;
}

function maxDate(left: Date | undefined, right: Date | undefined) {
  if (!left) return right;
  if (!right) return left;
  return left.getTime() >= right.getTime() ? left : right;
}

function entityChangedAt(value: { updatedAt?: Date; deletedAt?: Date; purgedAt?: Date }) {
  return Math.max(
    timestampMs(value.updatedAt),
    timestampMs(value.deletedAt),
    timestampMs(value.purgedAt)
  );
}

function isRightNewer(
  left: { updatedAt?: Date; deletedAt?: Date; purgedAt?: Date },
  right: { updatedAt?: Date; deletedAt?: Date; purgedAt?: Date }
) {
  return entityChangedAt(right) > entityChangedAt(left) + CLOCK_SKEW_TOLERANCE_MS;
}

function sortBySortOrder<T extends { sortOrder: number }>(items: T[]) {
  return [...items].sort((left, right) => left.sortOrder - right.sortOrder);
}

function mergeById<T extends { id: string }>(
  localItems: T[] = [],
  remoteItems: T[] = [],
  mergeItem: (localItem: T, remoteItem: T) => T
) {
  const merged = new Map<string, T>();
  for (const item of remoteItems) {
    merged.set(item.id, item);
  }
  for (const localItem of localItems) {
    const remoteItem = merged.get(localItem.id);
    merged.set(localItem.id, remoteItem ? mergeItem(localItem, remoteItem) : localItem);
  }
  return [...merged.values()];
}

function mergePhotos(localPhotos: PhotoAttachment[] = [], remotePhotos: PhotoAttachment[] = []) {
  return mergeById(localPhotos, remotePhotos, (localPhoto, remotePhoto) => {
    const base = timestampMs(remotePhoto.createdAt) > timestampMs(localPhoto.createdAt)
      ? remotePhoto
      : localPhoto;
    return {
      ...base,
      imageData: base.imageData || localPhoto.imageData || remotePhoto.imageData,
      thumbnail: base.thumbnail || localPhoto.thumbnail || remotePhoto.thumbnail,
    };
  });
}

function mergeFiles(localFiles: FileAttachment[] = [], remoteFiles: FileAttachment[] = []) {
  return mergeById(localFiles, remoteFiles, (localFile, remoteFile) => {
    const base = timestampMs(remoteFile.createdAt) > timestampMs(localFile.createdAt)
      ? remoteFile
      : localFile;
    return {
      ...base,
      data: base.data || localFile.data || remoteFile.data,
    };
  });
}

function mergeCheckpoints(localCheckpoint: Checkpoint, remoteCheckpoint: Checkpoint): Checkpoint {
  const base = isRightNewer(localCheckpoint, remoteCheckpoint) ? remoteCheckpoint : localCheckpoint;
  return {
    ...base,
    updatedAt: maxDate(localCheckpoint.updatedAt, remoteCheckpoint.updatedAt) ?? base.updatedAt,
    photos: mergePhotos(localCheckpoint.photos, remoteCheckpoint.photos),
    files: mergeFiles(localCheckpoint.files, remoteCheckpoint.files),
  };
}

function mergeItems(localItem: Item, remoteItem: Item): Item {
  const base = isRightNewer(localItem, remoteItem) ? remoteItem : localItem;
  return {
    ...base,
    updatedAt: maxDate(localItem.updatedAt, remoteItem.updatedAt) ?? base.updatedAt,
    checkpoints: sortBySortOrder(
      mergeById(localItem.checkpoints, remoteItem.checkpoints, mergeCheckpoints)
    ),
  };
}

function mergeLocations(localLocation: Location, remoteLocation: Location): Location {
  const base = isRightNewer(localLocation, remoteLocation) ? remoteLocation : localLocation;
  return {
    ...base,
    updatedAt: maxDate(localLocation.updatedAt, remoteLocation.updatedAt) ?? base.updatedAt,
    items: sortBySortOrder(
      mergeById(localLocation.items, remoteLocation.items, mergeItems)
    ),
  };
}

function mergeAreas(localArea: Area, remoteArea: Area): Area {
  if (localArea.purgedAt || remoteArea.purgedAt) {
    const purgedArea = !localArea.purgedAt
      ? remoteArea
      : !remoteArea.purgedAt
        ? localArea
        : timestampMs(remoteArea.purgedAt) > timestampMs(localArea.purgedAt)
          ? remoteArea
          : localArea;
    return {
      ...purgedArea,
      deletedAt: purgedArea.deletedAt ?? purgedArea.purgedAt,
      locations: [],
      notes: '',
    };
  }
  const base = isRightNewer(localArea, remoteArea) ? remoteArea : localArea;
  const locations = sortBySortOrder(
    mergeById(localArea.locations, remoteArea.locations, mergeLocations)
  );
  const selectedFacadeLevels =
    base.areaTypeKey === 'facade' ? new Set(splitFacadeLevels(base.facadeLevel)) : null;

  return {
    ...base,
    updatedAt: maxDate(localArea.updatedAt, remoteArea.updatedAt) ?? base.updatedAt,
    locations: selectedFacadeLevels?.size
      ? locations.filter((location) => selectedFacadeLevels.has(location.name.trim()))
      : locations,
  };
}

function mergeProjects(localProject: Project, remoteProject: Project): Project {
  const base = isRightNewer(localProject, remoteProject) ? remoteProject : localProject;
  return {
    ...base,
    oneDriveFolderName: remoteProject.oneDriveFolderName ?? localProject.oneDriveFolderName,
    updatedAt: maxDate(localProject.updatedAt, remoteProject.updatedAt) ?? base.updatedAt,
    areas: sortBySortOrder(
      mergeById(localProject.areas, remoteProject.areas, mergeAreas)
    ),
  };
}

function stripProjectMediaPayload(project: Project): Project {
  return {
    ...project,
    facadeElevationDrawings: project.facadeElevationDrawings?.map((drawing) => ({
      ...drawing,
      dataUrl: '',
    })),
    areas: (project.areas ?? []).map((area) => ({
      ...area,
      locations: (area.locations ?? []).map((location) => ({
        ...location,
        items: (location.items ?? []).map((item) => ({
          ...item,
          checkpoints: (item.checkpoints ?? []).map((checkpoint) => ({
            ...checkpoint,
            photos: (checkpoint.photos ?? []).map((photo) => ({
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

function projectsEqual(left: Project, right: Project) {
  return JSON.stringify(stripProjectMediaPayload(left)) === JSON.stringify(stripProjectMediaPayload(right));
}

function mergeSyncStates(
  localSyncStates: ProjectSyncStateMap,
  remoteSyncStates: ProjectSyncStateMap
) {
  const merged: ProjectSyncStateMap = { ...remoteSyncStates };

  for (const [projectId, localState] of Object.entries(localSyncStates)) {
    const remoteState = remoteSyncStates[projectId];
    if (!remoteState || timestampMs(localState.updatedAt) >= timestampMs(remoteState.updatedAt)) {
      merged[projectId] = localState;
    }
  }

  for (const [projectId, remoteState] of Object.entries(remoteSyncStates)) {
    const localState = localSyncStates[projectId];
    if (!localState || timestampMs(remoteState.updatedAt) > timestampMs(localState.updatedAt)) {
      merged[projectId] = remoteState;
    }
  }

  return merged;
}

function syncStateMapsEqual(left: ProjectSyncStateMap, right: ProjectSyncStateMap) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  for (const [projectId, state] of leftEntries) {
    const rightState = right[projectId];
    if (!rightState) return false;
    if (rightState.updatedAt !== state.updatedAt) return false;
  }
  return true;
}

export function markProjectDeleted(projectId: string, deletedAt = new Date()) {
  const syncStates = getLocalSyncStates();
  syncStates[projectId] = {
    updatedAt: deletedAt.toISOString(),
  };
  setLocalSyncStates(syncStates);
}

export function unmarkProjectDeleted(projectId: string) {
  const syncStates = getLocalSyncStates();
  delete syncStates[projectId];
  setLocalSyncStates(syncStates);
}

function resolveProjectSyncStates(
  syncStates: ProjectSyncStateMap,
  localProjectMap: Map<string, Project>,
  remoteFilesById: Map<string, Array<{ id: string; name: string; eTag?: string; lastModifiedDateTime?: string }>>
) {
  const next: ProjectSyncStateMap = { ...syncStates };
  const revivedRemoteProjectIds = new Set<string>();

  for (const [projectId] of Object.entries(syncStates)) {
    const localProject = localProjectMap.get(projectId);
    // Hard-delete tombstones apply only after the local project record is gone.
    // App-trash projects still exist locally and should sync to OneDrive's Trash Bin.
    if (localProject) {
      delete next[projectId];
      continue;
    }

    const remote = pickPrimaryRemoteProjectFile(remoteFilesById.get(projectId) ?? []);
    if (remote) {
      // A project file reappearing in the live OneDrive folder cancels any stale hard-delete
      // tombstone, but the project payload itself still decides whether the project is active
      // or sitting in the app trash via its own deletedAt + updatedAt fields.
      revivedRemoteProjectIds.add(projectId);
      delete next[projectId];
      continue;
    }
  }

  return { syncStates: next, revivedRemoteProjectIds };
}

async function downloadRemoteProject(token: string, remoteId: string): Promise<Project | null> {
  let raw: string;
  try {
    raw = await downloadProjectFile(token, remoteId);
  } catch (error) {
    if (isItemNotFoundError(error)) {
      return null;
    }
    throw error;
  }
  try {
    return parseProjectPayload(JSON.parse(raw));
  } catch (error) {
    throw new Error('OneDrive project data is invalid. Your local project was not changed.', { cause: error });
  }
}

async function getRemoteProjectPayloadUpdatedAt(
  token: string,
  remote?: Pick<RemoteProjectFile, 'id' | 'lastModifiedDateTime'>,
  cache?: Map<string, number>
) {
  if (!remote?.id) {
    return 0;
  }
  const cached = cache?.get(remote.id);
  if (cached !== undefined) {
    return cached;
  }
  const remoteProject = await downloadRemoteProject(token, remote.id);
  const updatedAt = getProjectUpdatedAt(remoteProject);
  cache?.set(remote.id, updatedAt);
  return updatedAt;
}

async function ignoreMissingRemoteItem(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    if (!isItemNotFoundError(error)) {
      throw error;
    }
  }
}

export async function syncProjectsWithOneDrive(token: string, options: SyncOptions = {}): Promise<SyncResult> {
  const releaseSyncLease = await acquireSyncLease(token);

  try {
    await ensurePunchListFolders(token);

    const conflictsById = new Map<string, SyncConflict>();
    const addConflict = (id: string, name: string) => {
      if (!conflictsById.has(id)) {
        conflictsById.set(id, { id, name });
      }
    };
    const [remoteFiles, localProjects, remoteDeletions] = await Promise.all([
      listProjectFiles(token),
      getAllProjects(),
      downloadDeletionLog(token),
    ]);
    const localSyncStates = getLocalSyncStates();
    const localProjectMap = new Map(localProjects.map((project) => [project.id, project]));
    const remoteFilesById = buildRemoteProjectFileIndex(remoteFiles);
    const remoteIndex: OneDriveSyncRemoteIndex = {};
    const requestedPushProjectIds = new Set(options.pushProjectIds ?? []);
    const mergedProjectIdsToPush = new Set<string>();
    const remoteSyncStates = normalizeSyncStateMap(remoteDeletions);
    const mergedSyncStates = mergeSyncStates(localSyncStates, remoteSyncStates);
    const { syncStates: resolvedSyncStates, revivedRemoteProjectIds } = resolveProjectSyncStates(
      mergedSyncStates,
      localProjectMap,
      remoteFilesById
    );
    setLocalSyncStates(resolvedSyncStates);
    if (!syncStateMapsEqual(resolvedSyncStates, remoteSyncStates)) {
      await uploadDeletionLog(token, resolvedSyncStates);
    }
    const remoteDeleteQueue: string[] = [];
    const remoteProjectFolderDeleteQueue = new Set<string>();
    const remotePhotoDeleteQueue = new Set<string>();

    // Apply explicit hard-delete states only when this device no longer has a
    // project record. If it still exists locally, preserving work wins.
    for (const [projectId, syncState] of Object.entries(resolvedSyncStates)) {
      if (localProjectMap.has(projectId)) {
        continue;
      }

      const remoteEntries = remoteFilesById.get(projectId) ?? [];
      const remote = pickPrimaryRemoteProjectFile(remoteEntries);
      const remoteLegacyFolderName = remote?.name.endsWith('.json') ? remote.name.slice(0, -5) : null;
      const folderName = remote ? getProjectFolderNameFromRemoteFile(remote) : null;
      let shouldDeleteRemoteStorage = false;

      if (remote && isAfterOrEqual(syncState.updatedAt, remote.lastModifiedDateTime)) {
        remoteDeleteQueue.push(...remoteEntries.map((entry) => entry.id));
        remoteFilesById.delete(projectId);
        shouldDeleteRemoteStorage = true;
      }

      if (folderName && shouldDeleteRemoteStorage) {
        remoteProjectFolderDeleteQueue.add(folderName);
        remotePhotoDeleteQueue.add(projectId);
        if (remoteLegacyFolderName) {
          remotePhotoDeleteQueue.add(remoteLegacyFolderName);
        }
      }
    }

    await runWithConcurrency(remoteDeleteQueue, 4, (remoteId) =>
      ignoreMissingRemoteItem(() => deleteDriveItem(token, remoteId))
    );
    await runWithConcurrency([...remoteProjectFolderDeleteQueue], 2, (folderName) =>
      ignoreMissingRemoteItem(() => deleteProjectFolder(token, folderName))
    );
    await runWithConcurrency([...remotePhotoDeleteQueue], 2, (folderName) =>
      ignoreMissingRemoteItem(() => deleteProjectPhotoFolder(token, folderName))
    );

  // Pull newer or missing projects from OneDrive
  const remoteProjectUpdatedAtByItemId = new Map<string, number>();
  const pullQueue = [...remoteFilesById.entries()];
  await runWithConcurrency(pullQueue, 4, async ([projectId, remoteEntries]) => {
    const remote = pickPrimaryRemoteProjectFile(remoteEntries);
    if (!remote) return;
    if (!remote.name.endsWith('.json') || !remote.id) return;
    const remoteFolderName = getProjectFolderNameFromRemoteFile(remote);
    const syncState = resolvedSyncStates[projectId];
    if (syncState && isAfterOrEqual(syncState.updatedAt, remote.lastModifiedDateTime)) {
      return;
    }
    const localProject = localProjectMap.get(projectId);
    const remoteProject = await downloadRemoteProject(token, remote.id);
    if (!remoteProject) {
      return;
    }
    const remoteProjectWithFolder = withProjectFolderName(remoteProject, remoteFolderName);
    const remoteUpdatedAt = getProjectUpdatedAt(remoteProjectWithFolder);
    remoteProjectUpdatedAtByItemId.set(remote.id, remoteUpdatedAt);
    const hydrateRemoteProject = () =>
      hydrateProjectPhotosFromOneDrive(
        token,
        remoteProjectWithFolder,
        remoteFolderName ?? undefined,
        remoteIndex
      );

    if (!localProject) {
      const hydratedRemoteProject = await hydrateRemoteProject();
      await saveProjectPreserveTimestamps(hydratedRemoteProject);
      localProjectMap.set(projectId, hydratedRemoteProject);
      return;
    }

    const localUpdatedAt = getProjectUpdatedAt(localProject);
    const staleDeleteUpdatedAt = timestampMs(mergedSyncStates[projectId]?.updatedAt);
    if (
      revivedRemoteProjectIds.has(projectId) &&
      localUpdatedAt <= staleDeleteUpdatedAt + CLOCK_SKEW_TOLERANCE_MS
    ) {
      const hydratedRemoteProject = await hydrateRemoteProject();
      await saveProjectPreserveTimestamps(hydratedRemoteProject);
      localProjectMap.set(projectId, hydratedRemoteProject);
      return;
    }

    const fullLocalProject = await getProject(projectId);
    const localProjectForMerge = fullLocalProject ?? localProject;
    const mergedProject = mergeProjects(localProjectForMerge, remoteProjectWithFolder);
    if (!projectsEqual(mergedProject, localProjectForMerge)) {
      const hydratedMergedProject = await hydrateProjectPhotosFromOneDrive(
        token,
        mergedProject,
        remoteFolderName ?? undefined,
        remoteIndex
      );
      await saveProjectPreserveTimestamps(hydratedMergedProject);
      localProjectMap.set(projectId, hydratedMergedProject);
    }
    if (!projectsEqual(mergedProject, remoteProjectWithFolder)) {
      mergedProjectIdsToPush.add(projectId);
    }
  });

  // Push local changes to OneDrive
  const pushProjectIds = new Set(requestedPushProjectIds);
  mergedProjectIdsToPush.forEach((projectId) => pushProjectIds.add(projectId));
  for (const project of localProjectMap.values()) {
    if (!project.deletedAt && !(remoteFilesById.get(project.id)?.length)) {
      pushProjectIds.add(project.id);
    }
  }
  const pushQueue = [...localProjectMap.values()].filter((project) => pushProjectIds.has(project.id));
  await runWithConcurrency(pushQueue, 3, async (project) => {
    const filename = projectJsonFilename(project);
    const remoteEntries = remoteFilesById.get(project.id) ?? [];
    const targetFolderName = resolveRemoteProjectFolderName(project, remoteEntries);
    const remote = pickPrimaryRemoteProjectFile(remoteEntries);
    const canonicalRemote = remoteEntries.find((entry) =>
      isCanonicalRemoteProjectFile(project, entry, targetFolderName)
    );
    const syncState = resolvedSyncStates[project.id];
    if (syncState && timestampMs(syncState.updatedAt) >= project.updatedAt.getTime()) {
      return;
    }

    const projectForUpload = await getProject(project.id);
    if (!projectForUpload) {
      return;
    }
    const fullProject = withProjectFolderName(projectForUpload, targetFolderName);
    await saveProjectPreserveTimestamps(fullProject);

    const localUpdatedAt = getProjectUpdatedAt(project);
    const remoteUpdatedAt = await getRemoteProjectPayloadUpdatedAt(
      token,
      remote,
      remoteProjectUpdatedAtByItemId
    );
    const remoteNeedsMergedLocalChanges = mergedProjectIdsToPush.has(project.id);
    const needsProjectFileMigration =
      remoteEntries.length > 0 && (!canonicalRemote || remoteEntries.some((entry) => entry.id !== canonicalRemote.id));
    const freshnessComparison = compareTimestampsWithTolerance(localUpdatedAt, remoteUpdatedAt);
    if (freshnessComparison <= 0 && !needsProjectFileMigration && !remoteNeedsMergedLocalChanges) {
      await syncProjectStorageToOneDriveState(token, fullProject, remoteEntries, targetFolderName, remoteIndex);
      return;
    }

    try {
      const uploadedRemote = await uploadProjectFileRecoveringMissingRemote(
        token,
        targetFolderName,
        filename,
        serializeProjectPayload(stripProjectMediaPayload(fullProject)),
        isProjectInTrash(fullProject),
        canonicalRemote?.eTag
      );
      await deleteStaleRemoteProjectFiles(
        token,
        fullProject,
        remoteEntries,
        isProjectInTrash(fullProject),
        targetFolderName,
        uploadedRemote.id
      );
      await syncProjectStorageToOneDriveState(token, fullProject, remoteEntries, targetFolderName, remoteIndex);
    } catch (error) {
      if (isConflictError(error)) {
        addConflict(project.id, project.projectName);
      } else {
        throw error;
      }
    }
  });

  const syncedAt = new Date();
  setLastSyncTime(syncedAt);
  await cleanupLegacyPunchListFolders(token);

    return { conflicts: [...conflictsById.values()], syncedAt: syncedAt.toISOString() };
  } finally {
    await releaseSyncLease();
  }
}

export async function pushProjectsToOneDrive(token: string, projectIds: string[]): Promise<PushSyncResult> {
  if (projectIds.length === 0) return { conflicts: [] };

  const releaseSyncLease = await acquireSyncLease(token);

  try {
    await ensurePunchListFolders(token);
    const syncStates = getLocalSyncStates();
    const uniqueProjectIds = [...new Set(projectIds)];
    const conflictsById = new Map<string, SyncConflict>();
    const remoteFilesById = buildRemoteProjectFileIndex(await listProjectFiles(token));
    const remoteIndex: OneDriveSyncRemoteIndex = {};

    await runWithConcurrency(uniqueProjectIds, 2, async (projectId) => {
    const syncState = syncStates[projectId];

    const localProject = await getProject(projectId);
    if (!localProject) return;
    if (syncState && timestampMs(syncState.updatedAt) >= localProject.updatedAt.getTime()) return;

    const filename = projectJsonFilename(localProject);
    const remoteEntries = remoteFilesById.get(projectId) ?? [];
    const targetFolderName = resolveRemoteProjectFolderName(localProject, remoteEntries);
    const remote = pickPrimaryRemoteProjectFile(remoteEntries);
    const canonicalRemote = remoteEntries.find((entry) =>
      isCanonicalRemoteProjectFile(localProject, entry, targetFolderName)
    );
    const remoteUpdatedAt = await getRemoteProjectPayloadUpdatedAt(token, remote);
    const localUpdatedAt = getProjectUpdatedAt(localProject);

    const freshnessComparison = compareTimestampsWithTolerance(localUpdatedAt, remoteUpdatedAt);
    if (freshnessComparison < 0) {
      conflictsById.set(projectId, { id: projectId, name: localProject.projectName });
      return;
    }

    const localProjectWithFolder = withProjectFolderName(localProject, targetFolderName);
    await saveProjectPreserveTimestamps(localProjectWithFolder);

    if (freshnessComparison === 0) {
      await syncProjectStorageToOneDriveState(token, localProjectWithFolder, remoteEntries, targetFolderName, remoteIndex);
      return;
    }

    try {
      const uploadedRemote = await uploadProjectFileRecoveringMissingRemote(
        token,
        targetFolderName,
        filename,
        serializeProjectPayload(stripProjectMediaPayload(localProjectWithFolder)),
        isProjectInTrash(localProjectWithFolder),
        canonicalRemote?.eTag
      );
      await deleteStaleRemoteProjectFiles(
        token,
        localProjectWithFolder,
        remoteEntries,
        isProjectInTrash(localProjectWithFolder),
        targetFolderName,
        uploadedRemote.id
      );
      await syncProjectStorageToOneDriveState(token, localProjectWithFolder, remoteEntries, targetFolderName, remoteIndex);
    } catch (error) {
      // Background push should not interrupt the editing flow; full sync can resolve conflicts.
      if (isConflictError(error)) {
        conflictsById.set(projectId, { id: projectId, name: localProject.projectName });
        return;
      }
      throw error;
    }
  });

    return { conflicts: [...conflictsById.values()] };
  } finally {
    await releaseSyncLease();
  }
}

export async function hydrateProjectMediaFromOneDrive(
  token: string,
  projectId: string
): Promise<Project | null> {
  const localProject = await getProject(projectId);
  if (!localProject) {
    return null;
  }

  const hydratedProject = await hydrateProjectPhotosFromOneDrive(
    token,
    localProject,
    localProject.oneDriveFolderName
  );

  await saveProjectPreserveTimestamps(hydratedProject);
  return hydratedProject;
}
