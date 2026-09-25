import { formatDateForExport, sanitizeExportNamePart } from '@/lib/projectNaming';
import { isMicrosoftMissingObjectError } from '@/lib/microsoftErrors';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const PUNCHLIST_ROOT = 'PunchList';
const TRASH_BIN_ROOT = `${PUNCHLIST_ROOT}/Trash Bin`;
const SHARED_EXPORTS_PATH = `${PUNCHLIST_ROOT}/exports`;
const LEGACY_PROJECTS_PATH = `${PUNCHLIST_ROOT}/projects`;
const LEGACY_PHOTOS_PATH = `${PUNCHLIST_ROOT}/photos`;
const SYNC_LOCK_PATH = `${PUNCHLIST_ROOT}/sync-lock.json`;
const RESERVED_PUNCHLIST_FOLDER_NAMES = new Set(['exports', 'projects', 'photos', 'Trash Bin']);
const ENSURED_FOLDER_CACHE_MS = 5 * 60 * 1000;
const SYNC_LEASE_DURATION_MS = 45_000;
const SYNC_LEASE_RENEW_MS = 15_000;
const SYNC_LEASE_MAX_WAIT_MS = 2 * 60_000;
const ensuredFolderCache = new Map<string, number>();

// Scoped credentials carry the lease through every nested Graph request and
// throttle retry, without affecting unrelated exports or another operation.
export type OneDriveToken = string | { accessToken: string; assertActive: () => void };
type SyncLeaseHandle = (() => Promise<void>) & { token: OneDriveToken };

function accessToken(token: OneDriveToken) {
  return typeof token === 'string' ? token : token.accessToken;
}

export function assertOneDriveLeaseActive(token: OneDriveToken) {
  if (typeof token !== 'string') token.assertActive();
}

export type DriveItem = {
  id: string;
  name: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  folder?: { childCount: number };
  punchlistPath?: string;
};

type DriveChildrenResponse = {
  value: DriveItem[];
  '@odata.nextLink'?: string;
};

type SyncLeaseFile = {
  ownerId: string;
  leaseId: string;
  acquiredAt: string;
  expiresAt: string;
};

function getTokenCacheKey(credential: OneDriveToken) {
  const token = accessToken(credential);
  try {
    const payload = token.split('.')[1];
    if (!payload) throw new Error('Missing token payload.');
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const claims = JSON.parse(atob(padded)) as {
      oid?: string;
      preferred_username?: string;
      sub?: string;
      tid?: string;
      upn?: string;
    };
    const tenant = claims.tid ?? 'tenant';
    const account = claims.oid ?? claims.sub ?? claims.preferred_username ?? claims.upn;
    if (account) return `${tenant}:${account}`;
  } catch {
    // Fall back to the token itself when Microsoft changes claim shape.
  }
  return token;
}

function getRetryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get('Retry-After');
  if (!retryAfter) return undefined;

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds)) {
    return Math.max(seconds * 1000, 0);
  }

  const retryAt = new Date(retryAfter).getTime();
  if (Number.isFinite(retryAt)) {
    return Math.max(retryAt - Date.now(), 0);
  }

  return undefined;
}

function isGraphItemNotFoundError(error: unknown) {
  return isMicrosoftMissingObjectError(error);
}

async function getGraphErrorMessage(response: Response) {
  try {
    const data = await response.clone().json();
    if (typeof data?.error?.message === 'string') {
      return data.error.message;
    }
  } catch {
    // Try text below.
  }

  try {
    return await response.clone().text();
  } catch {
    return '';
  }
}

function buildGraphError(response: Response, message: string) {
  const error = new Error(message || `Graph request failed: ${response.status}`) as Error & {
    retryAfterMs?: number;
    status?: number;
  };
  error.status = response.status;
  if (response.status === 429 || error.message.toLowerCase().includes('throttled')) {
    error.retryAfterMs = getRetryAfterMs(response) ?? 60_000;
  }
  return error;
}

async function fetchGraphWithThrottleRetry(token: OneDriveToken, url: string, options: RequestInit): Promise<Response> {
  assertOneDriveLeaseActive(token);
  const response = await fetch(url, options);
  assertOneDriveLeaseActive(token);
  if (response.status !== 429) {
    return response;
  }

  await wait(getRetryAfterMs(response) ?? 60_000);
  assertOneDriveLeaseActive(token);
  const retried = await fetch(url, options);
  assertOneDriveLeaseActive(token);
  return retried;
}

async function graphFetch<T>(token: OneDriveToken, path: string, options?: RequestInit): Promise<T> {
  const response = await fetchGraphWithThrottleRetry(token, `${GRAPH_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken(token)}`,
      ...(options?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const message = await getGraphErrorMessage(response);
    const error = buildGraphError(response, message);
    if (isGraphItemNotFoundError(error)) {
      ensuredFolderCache.delete(getTokenCacheKey(token));
    }
    throw error;
  }

  if (response.status === 204) {
    return {} as T;
  }
  return response.json() as Promise<T>;
}

async function graphFetchAbsolute<T>(token: OneDriveToken, url: string, options?: RequestInit): Promise<T> {
  const response = await fetchGraphWithThrottleRetry(token, url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken(token)}`,
      ...(options?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const message = await getGraphErrorMessage(response);
    const error = buildGraphError(response, message);
    if (isGraphItemNotFoundError(error)) {
      ensuredFolderCache.delete(getTokenCacheKey(token));
    }
    throw error;
  }

  if (response.status === 204) {
    return {} as T;
  }
  return response.json() as Promise<T>;
}

function getGraphErrorStatus(error: unknown) {
  return error instanceof Error && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined;
}

function isGraphConflictError(error: unknown) {
  const status = getGraphErrorStatus(error);
  if (status === 409 || status === 412) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('precondition failed') ||
    message.includes('etag mismatch') ||
    message.includes('name already exists') ||
    message.includes('already exists') ||
    message.includes('resource has changed')
  );
}

function wait(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function getItemByPath(token: OneDriveToken, path: string): Promise<DriveItem | null> {
  try {
    const item = await graphFetch<DriveItem>(
      token,
      `/me/drive/root:/${encodeURI(path)}?$select=id,name,eTag,lastModifiedDateTime,folder`
    );
    return { ...item, punchlistPath: path };
  } catch (error) {
    if (isGraphItemNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function downloadTextFileByPath(token: OneDriveToken, path: string): Promise<string | null> {
  try {
    const response = await fetchGraphWithThrottleRetry(token, `${GRAPH_API}/me/drive/root:/${encodeURI(path)}:/content`, {
      headers: {
        Authorization: `Bearer ${accessToken(token)}`,
      },
    });
    if (!response.ok) {
      if (isGraphItemNotFoundError(buildGraphError(response, await getGraphErrorMessage(response)))) {
        return null;
      }
      throw buildGraphError(response, await getGraphErrorMessage(response));
    }
    return response.text();
  } catch (error) {
    if (isGraphItemNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function uploadTextFileByPath(
  token: OneDriveToken,
  path: string,
  content: string,
  headers?: Record<string, string>
) {
  return graphFetch<DriveItem>(token, `/me/drive/root:/${encodeURI(path)}:/content`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
    body: content,
  });
}

async function createFolder(
  token: OneDriveToken,
  name: string,
  parentId?: string
): Promise<DriveItem> {
  const endpoint = parentId ? `/me/drive/items/${parentId}/children` : '/me/drive/root/children';

  return graphFetch<DriveItem>(token, endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    }),
  });
}

async function ensureFolder(token: OneDriveToken, path: string): Promise<DriveItem> {
  const existing = await getItemByPath(token, path);
  if (existing?.folder) return existing;
  if (existing) {
    throw new Error(`Expected folder at ${path}, but found a file instead.`);
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Folder path cannot be empty.');
  }

  const folderName = segments[segments.length - 1];
  const parentPath = segments.slice(0, -1).join('/');
  const parentFolder = parentPath ? await ensureFolder(token, parentPath) : null;

  try {
    return await createFolder(token, folderName, parentFolder?.id);
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes('already exists')) {
      const created = await getItemByPath(token, path);
      if (created?.folder) return created;
    }
    throw error;
  }
}

function getProjectContainerRoot(trashed = false) {
  return trashed ? TRASH_BIN_ROOT : PUNCHLIST_ROOT;
}

function getProjectRootPath(projectFolderName: string, trashed = false) {
  return `${getProjectContainerRoot(trashed)}/${projectFolderName}`;
}

function getProjectFilePath(projectFolderName: string, filename: string, trashed = false) {
  return `${getProjectRootPath(projectFolderName, trashed)}/${filename}`;
}

function getProjectPhotosPath(projectFolderName: string, trashed = false) {
  return `${getProjectRootPath(projectFolderName, trashed)}/photos`;
}

function getProjectExportsPath(projectFolderName: string, trashed = false) {
  return `${getProjectRootPath(projectFolderName, trashed)}/exports`;
}

function isDriveItemInTrash(item: Pick<DriveItem, 'punchlistPath'>) {
  return item.punchlistPath?.startsWith(`${TRASH_BIN_ROOT}/`) ?? false;
}

async function listProjectRootFolders(token: OneDriveToken, trashed = false): Promise<DriveItem[]> {
  const children = await listFolderChildrenByPath(token, getProjectContainerRoot(trashed));
  return children.filter(
    (item) => item.folder && !RESERVED_PUNCHLIST_FOLDER_NAMES.has(item.name)
  );
}

function attachPunchlistPaths(items: DriveItem[], parentPath: string) {
  return items.map((item) => ({
    ...item,
    punchlistPath: `${parentPath}/${item.name}`,
  }));
}

function dedupeDriveItems(items: DriveItem[]) {
  const seenIds = new Set<string>();
  const deduped: DriveItem[] = [];
  for (const item of items) {
    if (item.id && seenIds.has(item.id)) continue;
    if (item.id) {
      seenIds.add(item.id);
    }
    deduped.push(item);
  }
  return deduped;
}

export async function ensurePunchListFolders(token: OneDriveToken) {
  const cacheKey = getTokenCacheKey(token);
  const cachedUntil = ensuredFolderCache.get(cacheKey) ?? 0;
  if (cachedUntil > Date.now()) {
    return;
  }

  await ensureFolder(token, PUNCHLIST_ROOT);
  await ensureFolder(token, TRASH_BIN_ROOT);
  ensuredFolderCache.set(cacheKey, Date.now() + ENSURED_FOLDER_CACHE_MS);
}

async function listFolderChildrenByPath(token: OneDriveToken, path: string): Promise<DriveItem[]> {
  try {
    const items: DriveItem[] = [];
    let nextUrl: string | null =
      `${GRAPH_API}/me/drive/root:/${encodeURI(path)}:/children?$select=id,name,lastModifiedDateTime,eTag,folder`;

    while (nextUrl) {
      const result: DriveChildrenResponse = await graphFetchAbsolute<DriveChildrenResponse>(
        token,
        nextUrl
      );
      items.push(...(result.value ?? []));
      nextUrl = result['@odata.nextLink'] ?? null;
    }

    return attachPunchlistPaths(items, path);
  } catch (error) {
    if (isGraphItemNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

export async function listProjectFiles(token: OneDriveToken) {
  await ensurePunchListFolders(token);
  const [legacyFiles, activeProjectFolders, trashedProjectFolders] = await Promise.all([
    listFolderChildrenByPath(token, LEGACY_PROJECTS_PATH),
    listProjectRootFolders(token, false),
    listProjectRootFolders(token, true),
  ]);
  const folders = [...activeProjectFolders, ...trashedProjectFolders];
  const nestedFiles: DriveItem[][] = new Array(folders.length);
  let nextFolder = 0;
  await Promise.all(Array.from({ length: Math.min(2, folders.length) }, async () => {
    while (nextFolder < folders.length) {
      const index = nextFolder++;
      const folder = folders[index];
      nestedFiles[index] = await listFolderChildrenByPath(
        token,
        folder.punchlistPath ?? getProjectRootPath(folder.name, isDriveItemInTrash(folder))
      );
    }
  }));
  return [...legacyFiles, ...nestedFiles.flat()].filter((item) => item.name.endsWith('.json'));
}

export async function getProjectFileMetadata(token: OneDriveToken, filename: string): Promise<DriveItem | null> {
  await ensurePunchListFolders(token);
  const projectFolders = [
    ...(await listProjectRootFolders(token, false)),
    ...(await listProjectRootFolders(token, true)),
  ];
  for (const folder of projectFolders) {
    const match = await getItemByPath(
      token,
      getProjectFilePath(folder.name, filename, isDriveItemInTrash(folder))
    );
    if (match) return match;
  }
  return getItemByPath(token, `${LEGACY_PROJECTS_PATH}/${filename}`);
}

export async function downloadProjectFile(token: OneDriveToken, id: string): Promise<string> {
  const response = await fetchGraphWithThrottleRetry(token, `${GRAPH_API}/me/drive/items/${id}/content`, {
    headers: {
      Authorization: `Bearer ${accessToken(token)}`,
    },
  });
  if (!response.ok) {
    throw buildGraphError(response, await getGraphErrorMessage(response));
  }
  return response.text();
}

export async function downloadDriveItemAsDataUrl(token: OneDriveToken, id: string): Promise<string> {
  const response = await fetchGraphWithThrottleRetry(token, `${GRAPH_API}/me/drive/items/${id}/content`, {
    headers: {
      Authorization: `Bearer ${accessToken(token)}`,
    },
  });
  if (!response.ok) {
    throw buildGraphError(response, await getGraphErrorMessage(response));
  }

  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Drive download produced a non-string result.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Drive download failed.'));
    reader.readAsDataURL(blob);
  });
}

export async function uploadProjectFile(
  token: OneDriveToken,
  projectFolderName: string,
  filename: string,
  content: string,
  trashed = false,
  etag?: string
) {
  await ensurePunchListFolders(token);
  await ensureFolder(token, getProjectRootPath(projectFolderName, trashed));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (etag) {
    headers['If-Match'] = etag;
  }
  return graphFetch<DriveItem>(token, `/me/drive/root:/${encodeURI(getProjectFilePath(projectFolderName, filename, trashed))}:/content`, {
    method: 'PUT',
    headers,
    body: content,
  });
}

export async function listProjectPhotoFiles(
  token: OneDriveToken,
  projectFolderName: string,
  trashed = false,
  includeFallback = false
): Promise<DriveItem[]> {
  await ensurePunchListFolders(token);
  const paths = [getProjectPhotosPath(projectFolderName, trashed)];
  if (includeFallback) {
    paths.push(getProjectPhotosPath(projectFolderName, !trashed), `${LEGACY_PHOTOS_PATH}/${projectFolderName}`);
  }
  const photoSets = await Promise.all(paths.map((path) => listFolderChildrenByPath(token, path)));
  return dedupeDriveItems(photoSets.flat());
}

export async function listProjectExportFiles(
  token: OneDriveToken,
  projectFolderName: string,
  trashed = false
): Promise<DriveItem[]> {
  await ensurePunchListFolders(token);
  return listFolderChildrenByPath(token, getProjectExportsPath(projectFolderName, trashed));
}

export async function listPhotoProjectFolders(token: OneDriveToken): Promise<DriveItem[]> {
  await ensurePunchListFolders(token);
  const [activeProjectFolders, trashedProjectFolders, legacyPhotoFolders] = await Promise.all([
    listProjectRootFolders(token, false),
    listProjectRootFolders(token, true),
    listFolderChildrenByPath(token, LEGACY_PHOTOS_PATH),
  ]);
  const byKey = new Map<string, DriveItem>();
  for (const folder of [...activeProjectFolders, ...trashedProjectFolders]) {
    byKey.set(`${folder.name}:${isDriveItemInTrash(folder) ? 'trash' : 'active'}`, folder);
  }
  for (const folder of legacyPhotoFolders.filter((item) => item.folder)) {
    const key = `${folder.name}:legacy`;
    if (!byKey.has(key)) {
      byKey.set(key, folder);
    }
  }
  return [...byKey.values()];
}

export async function uploadProjectPhotoFile(
  token: OneDriveToken,
  projectFolderName: string,
  filename: string,
  blob: Blob,
  trashed = false
) {
  await ensurePunchListFolders(token);
  await ensureFolder(token, getProjectRootPath(projectFolderName, trashed));
  await ensureFolder(token, getProjectPhotosPath(projectFolderName, trashed));
  return graphFetch<DriveItem>(
    token,
    `/me/drive/root:/${encodeURI(getProjectPhotosPath(projectFolderName, trashed))}/${encodeURI(filename)}:/content`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': blob.type || 'image/jpeg',
      },
      body: blob,
    }
  );
}

function isItemNotFoundError(error: unknown) {
  return isGraphItemNotFoundError(error);
}

async function deleteDriveItemIfExists(token: OneDriveToken, id: string): Promise<void> {
  try {
    await deleteDriveItem(token, id);
  } catch (error) {
    if (!isItemNotFoundError(error)) {
      throw error;
    }
  }
}

export async function deleteProjectPhotoFolder(token: OneDriveToken, projectFolderName: string): Promise<void> {
  await ensurePunchListFolders(token);
  const [activeProjectFolderPhotos, trashedProjectFolderPhotos, legacyFolder] = await Promise.all([
    getItemByPath(token, getProjectPhotosPath(projectFolderName, false)),
    getItemByPath(token, getProjectPhotosPath(projectFolderName, true)),
    getItemByPath(token, `${LEGACY_PHOTOS_PATH}/${projectFolderName}`),
  ]);
  const folders = dedupeDriveItems(
    [activeProjectFolderPhotos, trashedProjectFolderPhotos, legacyFolder].filter(
      (item): item is DriveItem => !!item?.id
    )
  );
  for (const folder of folders) {
    await deleteDriveItemIfExists(token, folder.id);
  }
}

export async function deleteProjectFolder(token: OneDriveToken, projectFolderName: string): Promise<void> {
  await ensurePunchListFolders(token);
  const folders = dedupeDriveItems(
    (
      await Promise.all([
        getItemByPath(token, getProjectRootPath(projectFolderName, false)),
        getItemByPath(token, getProjectRootPath(projectFolderName, true)),
      ])
    ).filter((item): item is DriveItem => !!item?.id)
  );
  for (const folder of folders) {
    await deleteDriveItemIfExists(token, folder.id);
  }
}

export async function deleteProjectFolderFromState(
  token: OneDriveToken,
  projectFolderName: string,
  trashed: boolean,
  projectId?: string
): Promise<void> {
  await ensurePunchListFolders(token);
  const folderPath = getProjectRootPath(projectFolderName, trashed);
  if (projectId) {
    const children = await listFolderChildrenByPath(token, folderPath);
    const hasOtherProjectFile = children.some(
      (item) => item.name.endsWith('.json') && !item.name.endsWith(`${projectId}.json`)
    );
    if (hasOtherProjectFile) return;
  }
  const folder = await getItemByPath(token, folderPath);
  if (!folder?.id) return;
  await deleteDriveItemIfExists(token, folder.id);
}

export async function deleteProjectFoldersFromState(
  token: OneDriveToken,
  projectFolderNames: string[],
  trashed: boolean,
  projectId?: string
): Promise<void> {
  const uniqueFolderNames = [...new Set(projectFolderNames.filter(Boolean))];
  for (const folderName of uniqueFolderNames) {
    await deleteProjectFolderFromState(token, folderName, trashed, projectId);
  }
}

export async function uploadPdfToOneDrive(
  token: OneDriveToken,
  filename: string,
  blob: Blob,
  projectFolderName?: string
) {
  await ensurePunchListFolders(token);
  const exportPath = projectFolderName
    ? getProjectExportsPath(projectFolderName)
    : SHARED_EXPORTS_PATH;
  if (projectFolderName) {
    await ensureFolder(token, getProjectRootPath(projectFolderName));
    await ensureFolder(token, exportPath);
  } else {
    await ensureFolder(token, SHARED_EXPORTS_PATH);
  }
  return graphFetch<DriveItem>(token, `/me/drive/root:/${encodeURI(exportPath)}/${encodeURI(filename)}:/content`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/pdf',
    },
    body: blob,
  });
}

export async function getNextOneDriveExportFilename(
  token: OneDriveToken,
  projectNames: string[],
  now = new Date(),
  projectFolderName?: string
): Promise<string> {
  await ensurePunchListFolders(token);
  const base = projectNames.map(sanitizeExportNamePart).join('_') || 'PunchList';
  const date = formatDateForExport(now);
  const exportPath = projectFolderName
    ? getProjectExportsPath(projectFolderName)
    : SHARED_EXPORTS_PATH;
  if (projectFolderName) {
    await ensureFolder(token, getProjectRootPath(projectFolderName));
    await ensureFolder(token, exportPath);
  } else {
    await ensureFolder(token, SHARED_EXPORTS_PATH);
  }
  const existingFiles = await graphFetch<{ value: DriveItem[] }>(
    token,
    `/me/drive/root:/${encodeURI(exportPath)}:/children?$select=name`
  );
  const prefix = `${base}_${date}_`;
  const matchingVersions = (existingFiles.value ?? [])
    .map((item) => item.name)
    .filter((name) => name.startsWith(prefix) && name.toLowerCase().endsWith('.pdf'))
    .map((name) => name.slice(prefix.length, -4))
    .map((rawVersion) => Number.parseInt(rawVersion, 10))
    .filter((version) => Number.isFinite(version) && version > 0);

  const nextVersion = (matchingVersions.length > 0 ? Math.max(...matchingVersions) : 0) + 1;
  return `${base}_${date}_${nextVersion}.pdf`;
}

export async function deleteDriveItem(token: OneDriveToken, id: string): Promise<void> {
  await graphFetch(token, `/me/drive/items/${id}`, {
    method: 'DELETE',
  });
}

export async function moveDriveItemToFolder(
  token: OneDriveToken,
  id: string,
  destinationFolderPath: string,
  name?: string
): Promise<DriveItem> {
  await ensurePunchListFolders(token);
  const destinationFolder = await ensureFolder(token, destinationFolderPath);
  return graphFetch<DriveItem>(token, `/me/drive/items/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parentReference: {
        id: destinationFolder.id,
      },
      ...(name ? { name } : {}),
    }),
  });
}

export async function downloadDeletionLog(token: OneDriveToken): Promise<Record<string, unknown>> {
  const response = await fetchGraphWithThrottleRetry(token, `${GRAPH_API}/me/drive/root:/PunchList/deletions.json:/content`, {
    headers: {
      Authorization: `Bearer ${accessToken(token)}`,
    },
  });
  if (!response.ok) {
    if (response.status === 404) return {};
    throw buildGraphError(response, await getGraphErrorMessage(response));
  }
  const text = await response.text();
  if (!text) return {};
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return parsed ?? {};
}

export async function uploadDeletionLog(
  token: OneDriveToken,
  data: Record<string, unknown>
): Promise<DriveItem> {
  return graphFetch<DriveItem>(token, '/me/drive/root:/PunchList/deletions.json:/content', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
}

function getSyncLeaseOwnerId() {
  const key = 'punchlist-sync-lease-owner-id';
  const createId = () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const ownerId = createId();
    localStorage.setItem(key, ownerId);
    return ownerId;
  } catch {
    return createId();
  }
}

function createSyncLease(ownerId: string, leaseId: string): SyncLeaseFile {
  const now = new Date();
  return {
    ownerId,
    leaseId,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SYNC_LEASE_DURATION_MS).toISOString(),
  };
}

function parseSyncLease(raw: string | null): SyncLeaseFile | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncLeaseFile>;
    if (
      typeof parsed.ownerId !== 'string' ||
      typeof parsed.leaseId !== 'string' ||
      typeof parsed.acquiredAt !== 'string' ||
      typeof parsed.expiresAt !== 'string'
    ) {
      return null;
    }
    return {
      ownerId: parsed.ownerId,
      leaseId: parsed.leaseId,
      acquiredAt: parsed.acquiredAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function syncLeaseExpiresAtMs(lease: SyncLeaseFile | null) {
  if (!lease) return 0;
  const ms = new Date(lease.expiresAt).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function readSyncLease(token: OneDriveToken) {
  const metadata = await getItemByPath(token, SYNC_LOCK_PATH);
  if (!metadata) {
    return { metadata: null, lease: null };
  }
  return {
    metadata,
    lease: parseSyncLease(await downloadTextFileByPath(token, SYNC_LOCK_PATH)),
  };
}

async function releaseSyncLeaseFile(token: OneDriveToken, leaseId: string) {
  const { metadata, lease } = await readSyncLease(token);
  if (!metadata?.id || !metadata.eTag || lease?.leaseId !== leaseId) {
    return;
  }
  // Another device may acquire the expired lease between this read and delete.
  // Never remove a different revision of the lock file.
  await graphFetch(token, `/me/drive/items/${metadata.id}`, {
    method: 'DELETE', headers: { 'If-Match': metadata.eTag },
  });
}

export async function acquireSyncLease(token: OneDriveToken): Promise<SyncLeaseHandle> {
  await ensurePunchListFolders(token);
  const ownerId = getSyncLeaseOwnerId();
  const leaseId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const waitDeadline = Date.now() + SYNC_LEASE_MAX_WAIT_MS;
  let activeLease: SyncLeaseFile = createSyncLease(ownerId, leaseId);
  let activeEtag: string | undefined;

  while (true) {
    const { metadata, lease } = await readSyncLease(token);
    const expiresAtMs = syncLeaseExpiresAtMs(lease);
    const now = Date.now();
    if (lease && lease.leaseId !== leaseId && expiresAtMs > now) {
      if (now >= waitDeadline) {
        throw new Error('Another OneDrive backup or restore is still running. Try again after it finishes.');
      }
      await wait(Math.min(Math.max(expiresAtMs - now + 250, 1_000), 3_000, waitDeadline - now));
      continue;
    }

    activeLease = createSyncLease(ownerId, leaseId);
    try {
      const uploaded = await uploadTextFileByPath(
        token,
        SYNC_LOCK_PATH,
        JSON.stringify(activeLease),
        metadata?.eTag ? { 'If-Match': metadata.eTag } : { 'If-None-Match': '*' }
      );
      // A separate metadata read could belong to a replacement lease. If the
      // upload omits its tag, renewal must verify ownership before using one.
      activeEtag = uploaded.eTag;
      break;
    } catch (error) {
      if (!isGraphConflictError(error)) {
        throw error;
      }
      if (Date.now() >= waitDeadline) {
        throw new Error('Another OneDrive backup or restore is still running. Try again after it finishes.');
      }
      await wait(1_000);
    }
  }

  let released = false;
  let lost = false;
  let validUntil = syncLeaseExpiresAtMs(activeLease);
  const assertActive = () => {
    if (released || lost || Date.now() >= validUntil) {
      lost = true;
      throw new Error('The OneDrive sync lock expired or was lost. Your local work is preserved. Sync again to continue.');
    }
  };
  let renewal: Promise<void> | undefined;
  const renewTimer = window.setInterval(() => {
    if (released || lost || renewal) return;
    let renewedUntil = validUntil;
    renewal = (async () => {
      assertActive();
      let renewalEtag = activeEtag;
      if (!renewalEtag) {
        const { metadata, lease } = await readSyncLease(token);
        if (lease?.leaseId !== leaseId || !metadata?.eTag) {
          lost = true;
          return;
        }
        renewalEtag = metadata.eTag;
      }

      assertActive();
      const renewedLease = createSyncLease(ownerId, leaseId);
      renewedUntil = syncLeaseExpiresAtMs(renewedLease);
      return uploadTextFileByPath(
        { accessToken: accessToken(token), assertActive },
        SYNC_LOCK_PATH,
        JSON.stringify(renewedLease),
        { 'If-Match': renewalEtag }
      );
    })()
      .then((uploaded) => {
        // A response received after the previous deadline cannot prove that
        // this operation retained continuous ownership.
        if (Date.now() >= validUntil || !uploaded) lost = true;
        if (!lost) validUntil = renewedUntil;
        activeEtag = uploaded?.eTag;
      })
      .catch((error) => {
        if (isGraphConflictError(error) || Date.now() >= validUntil) lost = true;
        console.info('OneDrive sync lease renewal skipped:', error);
      })
      .finally(() => {
        renewal = undefined;
      });
  }, SYNC_LEASE_RENEW_MS);

  const release = async () => {
    if (released) return;
    released = true;
    window.clearInterval(renewTimer);
    try {
      // Finish any in-flight renewal before reading the revision to delete.
      await renewal;
      await releaseSyncLeaseFile(token, leaseId);
    } catch (error) {
      console.info('OneDrive sync lease release skipped:', error);
    }
  };
  return Object.assign(release, { token: { accessToken: accessToken(token), assertActive } });
}

export async function cleanupLegacyPunchListFolders(token: OneDriveToken): Promise<void> {
  await ensurePunchListFolders(token);

  for (const path of [LEGACY_PROJECTS_PATH, LEGACY_PHOTOS_PATH]) {
    const folder = await getItemByPath(token, path);
    if (!folder?.id) continue;
    const children = await listFolderChildrenByPath(token, path);
    if (children.length === 0) {
      await deleteDriveItemIfExists(token, folder.id);
    }
  }
}
