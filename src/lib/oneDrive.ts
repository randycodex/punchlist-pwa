const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const PUNCHLIST_ROOT = 'PunchList';
const TRASH_BIN_ROOT = `${PUNCHLIST_ROOT}/Trash Bin`;
const SHARED_EXPORTS_PATH = `${PUNCHLIST_ROOT}/exports`;
const LEGACY_PROJECTS_PATH = `${PUNCHLIST_ROOT}/projects`;
const LEGACY_PHOTOS_PATH = `${PUNCHLIST_ROOT}/photos`;
const RESERVED_PUNCHLIST_FOLDER_NAMES = new Set(['exports', 'projects', 'photos', 'Trash Bin']);
const ENSURED_FOLDER_CACHE_MS = 5 * 60 * 1000;
const ensuredFolderCache = new Map<string, number>();

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

function getTokenCacheKey(token: string) {
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

async function graphFetch<T>(token: string, path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${GRAPH_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const message = await getGraphErrorMessage(response);
    throw buildGraphError(response, message);
  }

  if (response.status === 204) {
    return {} as T;
  }
  return response.json() as Promise<T>;
}

async function graphFetchAbsolute<T>(token: string, url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const message = await getGraphErrorMessage(response);
    throw buildGraphError(response, message);
  }

  if (response.status === 204) {
    return {} as T;
  }
  return response.json() as Promise<T>;
}

async function getItemByPath(token: string, path: string): Promise<DriveItem | null> {
  try {
    const item = await graphFetch<DriveItem>(
      token,
      `/me/drive/root:/${encodeURI(path)}?$select=id,name,eTag,lastModifiedDateTime,folder`
    );
    return { ...item, punchlistPath: path };
  } catch (error) {
    if (
      error instanceof Error &&
      (
        error.message.includes('itemNotFound') ||
        error.message.includes('404') ||
        error.message.includes('The resource could not be found') ||
        error.message.includes('resource could not be found')
      )
    ) {
      return null;
    }
    throw error;
  }
}

async function createFolder(
  token: string,
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

async function ensureFolder(token: string, path: string): Promise<DriveItem> {
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

async function listProjectRootFolders(token: string, trashed = false): Promise<DriveItem[]> {
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

export async function ensurePunchListFolders(token: string) {
  const cacheKey = getTokenCacheKey(token);
  const cachedUntil = ensuredFolderCache.get(cacheKey) ?? 0;
  if (cachedUntil > Date.now()) {
    return;
  }

  await ensureFolder(token, PUNCHLIST_ROOT);
  await ensureFolder(token, TRASH_BIN_ROOT);
  ensuredFolderCache.set(cacheKey, Date.now() + ENSURED_FOLDER_CACHE_MS);
}

async function listFolderChildrenByPath(token: string, path: string): Promise<DriveItem[]> {
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
    if (
      error instanceof Error &&
      (
        error.message.includes('itemNotFound') ||
        error.message.includes('404') ||
        error.message.includes('The resource could not be found') ||
        error.message.includes('resource could not be found')
      )
    ) {
      return [];
    }
    throw error;
  }
}

export async function listProjectFiles(token: string) {
  await ensurePunchListFolders(token);
  const [legacyFiles, activeProjectFolders, trashedProjectFolders] = await Promise.all([
    listFolderChildrenByPath(token, LEGACY_PROJECTS_PATH),
    listProjectRootFolders(token, false),
    listProjectRootFolders(token, true),
  ]);
  const nestedFiles = await Promise.all(
    [...activeProjectFolders, ...trashedProjectFolders].map((folder) =>
      listFolderChildrenByPath(token, folder.punchlistPath ?? getProjectRootPath(folder.name, isDriveItemInTrash(folder)))
    )
  );
  return [...legacyFiles, ...nestedFiles.flat()].filter((item) => item.name.endsWith('.json'));
}

export async function getProjectFileMetadata(token: string, filename: string): Promise<DriveItem | null> {
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

export async function downloadProjectFile(token: string, id: string): Promise<string> {
  const response = await fetch(`${GRAPH_API}/me/drive/items/${id}/content`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw buildGraphError(response, await getGraphErrorMessage(response));
  }
  return response.text();
}

export async function downloadDriveItemAsDataUrl(token: string, id: string): Promise<string> {
  const response = await fetch(`${GRAPH_API}/me/drive/items/${id}/content`, {
    headers: {
      Authorization: `Bearer ${token}`,
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
  token: string,
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
  token: string,
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
  token: string,
  projectFolderName: string,
  trashed = false
): Promise<DriveItem[]> {
  await ensurePunchListFolders(token);
  return listFolderChildrenByPath(token, getProjectExportsPath(projectFolderName, trashed));
}

export async function listPhotoProjectFolders(token: string): Promise<DriveItem[]> {
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
  token: string,
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

export async function deleteProjectPhotoFolder(token: string, projectFolderName: string): Promise<void> {
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
    await deleteDriveItem(token, folder.id);
  }
}

export async function deleteProjectFolder(token: string, projectFolderName: string): Promise<void> {
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
    await deleteDriveItem(token, folder.id);
  }
}

export async function uploadPdfToOneDrive(
  token: string,
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

function sanitizeExportNamePart(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/gi, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'Project';
}

function formatDateForExport(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd}`;
}

export async function getNextOneDriveExportFilename(
  token: string,
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

export async function deleteDriveItem(token: string, id: string): Promise<void> {
  await graphFetch(token, `/me/drive/items/${id}`, {
    method: 'DELETE',
  });
}

export async function moveDriveItemToFolder(
  token: string,
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

export async function downloadDeletionLog(token: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`${GRAPH_API}/me/drive/root:/PunchList/deletions.json:/content`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      if (response.status === 429) {
        throw buildGraphError(response, await getGraphErrorMessage(response));
      }
      return {};
    }
    const text = await response.text();
    if (!text) return {};
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return parsed ?? {};
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'retryAfterMs' in error
    ) {
      throw error;
    }
    return {};
  }
}

export async function uploadDeletionLog(
  token: string,
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

export async function acquireSyncLease(token: string): Promise<() => Promise<void>> {
  await ensurePunchListFolders(token);
  return async () => {};
}

export async function cleanupLegacyPunchListFolders(token: string): Promise<void> {
  await ensurePunchListFolders(token);

  for (const path of [LEGACY_PROJECTS_PATH, LEGACY_PHOTOS_PATH]) {
    const folder = await getItemByPath(token, path);
    if (!folder?.id) continue;
    const children = await listFolderChildrenByPath(token, path);
    if (children.length === 0) {
      await deleteDriveItem(token, folder.id);
    }
  }
}
