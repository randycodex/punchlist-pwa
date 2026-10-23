import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment,
} from '@/lib/db';
import type { Project } from '@/types';
import type { SharedSnapshotAssetManifest, SharedSnapshotAssetReference } from '@/lib/collaboration/sharedSnapshotPayload';

const { download } = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@/lib/collaboration/supabaseClient', () => ({
  getCollaborationSupabaseClient: () => ({ storage: { from: () => ({ download }) } }),
}));

class MemoryCache {
  readonly entries = new Map<string, Response>();
  async match(key: string) { return this.entries.get(key)?.clone(); }
  async put(key: string, value: Response) { this.entries.set(key, value.clone()); }
  async keys() { return [...this.entries.keys()]; }
  async delete(key: string) { return this.entries.delete(key); }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Each loaded module graph gets its own transfer pool and browser-lock fallback.
// Only Cache Storage and the simulated origin-wide Web Lock manager are shared.
async function tab(accountId = 'account-a') {
  vi.resetModules();
  const account = await import('@/lib/localAccount');
  account.configureLocalAccount(accountId, `${accountId}@example.test`, 'account-a');
  return {
    ...await import('@/lib/collaboration/sharedSnapshotAssets'),
    ...await import('@/lib/collaboration/sharedTransferPool'),
  };
}

type Tab = Awaited<ReturnType<typeof tab>>;
let cachesByName: Map<string, MemoryCache>;
let openCache: Mock<(name: string) => Promise<MemoryCache>>;
let requestLock: Mock<(name: string, run: () => Promise<unknown>) => Promise<unknown>>;
let storage: Map<string, string>;

beforeEach(() => {
  download.mockReset();
  cachesByName = new Map();
  openCache = vi.fn(async (name: string) => {
    if (!cachesByName.has(name)) cachesByName.set(name, new MemoryCache());
    return cachesByName.get(name)!;
  });
  vi.stubGlobal('caches', { open: openCache });
  const locks = new Map<string, Promise<unknown>>();
  requestLock = vi.fn((name: string, run: () => Promise<unknown>) => {
    const next = (locks.get(name) ?? Promise.resolve()).catch(() => undefined).then(run);
    locks.set(name, next);
    return next.finally(() => { if (locks.get(name) === next) locks.delete(name); });
  });
  vi.stubGlobal('navigator', { locks: { request: requestLock } });
  storage = new Map([['punchlist:legacy-data-owner', 'account-a'], ['auth-sentinel', 'preserve-session']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function fixture(client: Tab, body = 'saved photo', sharedProjectId = crypto.randomUUID()) {
  const project = createProject('Download cache regression');
  project.sharedProjectId = sharedProjectId;
  const area = createArea(project.id, 'Area', 0);
  const location = createLocation(area.id, 'Room', 0);
  const item = createItem(location.id, 'Item', 0);
  const checkpoint = createCheckpoint(item.id, 'Finish', 0);
  checkpoint.photos.push(createPhotoAttachment(checkpoint.id, `data:image/jpeg;base64,${btoa(body)}`));
  item.checkpoints.push(checkpoint); location.items.push(item); area.locations.push(location); project.areas.push(area);
  const plan = await client.buildSharedSnapshotAssetPlan(project);
  return { project, assets: plan.assets, reference: Object.values(plan.assets.photos)[0].image,
    blob: new Blob([body], { type: 'image/jpeg' }) };
}

function hydrate(client: Tab, input: { project: Project; assets: SharedSnapshotAssetManifest }, local?: Project) {
  const project = structuredClone(input.project);
  for (const area of project.areas) for (const room of area.locations) for (const item of room.items)
    for (const checkpoint of item.checkpoints) for (const photo of checkpoint.photos) {
      photo.imageData = ''; photo.thumbnail = undefined;
    }
  return client.hydrateSharedSnapshotAssets(project, input.assets, project.sharedProjectId!, local);
}

function cacheKey(reference: SharedSnapshotAssetReference) {
  return `https://punchlist-cache.invalid/${encodeURIComponent(reference.bucket)}/${reference.path}`;
}

describe('shared snapshot downloads across browser contexts', () => {
  it('rechecks the verified cache after another tab completes the same object', async () => {
    const first = await tab(); const second = await tab(); const input = await fixture(first);
    download.mockResolvedValue({ data: input.blob, error: null });
    const copies = await Promise.all([hydrate(first, input), hydrate(second, input)]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(copies[0]).toEqual(copies[1]);
    expect(copies[0].areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData)
      .toBe(input.project.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData);
  });

  it('allows unrelated objects to download while a different object is blocked', async () => {
    const first = await tab(); const second = await tab();
    const a = await fixture(first); const b = await fixture(second, 'other photo'); const gate = deferred();
    download.mockImplementation(async (path: string) => {
      if (path === a.reference.path) await gate.promise;
      return { data: path === a.reference.path ? a.blob : b.blob, error: null };
    });
    const one = hydrate(first, a);
    try { await hydrate(second, b); expect(download).toHaveBeenCalledTimes(2); }
    finally { gate.resolve(); await one; }
  });

  it('releases a failed object lock so a waiting tab can download, without cancelling unrelated work', async () => {
    const first = await tab(); const second = await tab();
    const a = await fixture(first); const b = await fixture(second, 'unrelated photo'); const gate = deferred();
    const failure = { message: 'Forbidden', status: 403 }; let attempts = 0;
    download.mockImplementation(async (path: string) => {
      if (path !== a.reference.path) return { data: b.blob, error: null };
      if (++attempts === 1) { await gate.promise; return { data: null, error: failure }; }
      return { data: a.blob, error: null };
    });
    const one = Promise.allSettled([hydrate(first, a)]);
    await vi.waitFor(() => expect(attempts).toBe(1));
    const two = hydrate(second, a);
    try { await hydrate(second, b); }
    finally { gate.resolve(); }
    expect(await one).toEqual([{ status: 'rejected', reason: failure }]);
    await two;
    expect(attempts).toBe(2);
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('never reuses a corrupt cache entry or caches a corrupt download', async () => {
    const first = await tab(); const input = await fixture(first);
    const cache = await openCache('punchlist-shared-assets-v1');
    await cache.put(cacheKey(input.reference), new Response('damaged'));
    download.mockResolvedValueOnce({ data: new Blob(['wrong']), error: null });
    await expect(hydrate(first, input)).rejects.toThrow('failed verification');
    expect(await cache.match(cacheKey(input.reference))).toBeUndefined();
    download.mockResolvedValue({ data: input.blob, error: null });
    await hydrate(await tab(), input);
    await hydrate(first, input);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('isolates accounts even when their authorized manifests reference the same object', async () => {
    const first = await tab('account-a'); const second = await tab('account-b'); const input = await fixture(first);
    download.mockResolvedValue({ data: input.blob, error: null });
    await Promise.all([hydrate(first, input), hydrate(second, input)]);
    expect(download).toHaveBeenCalledTimes(2);
    expect([...cachesByName.keys()]).toEqual(expect.arrayContaining(['punchlist-shared-assets-v1', 'punchlist-shared-assets-v1:account-b']));
    expect(new Set(requestLock.mock.calls.filter(([name]) => String(name).includes(input.reference.path)).map(([name]) => name)).size).toBe(2);
  });

  it('does not share bytes between team projects or accept a foreign project reference', async () => {
    const first = await tab(); const second = await tab();
    const a = await fixture(first); const b = structuredClone(a);
    b.project.sharedProjectId = crypto.randomUUID();
    const bRef = Object.values(b.assets.photos)[0].image;
    bRef.path = bRef.path.replace(a.project.sharedProjectId!, b.project.sharedProjectId);
    download.mockResolvedValue({ data: a.blob, error: null });
    await Promise.all([hydrate(first, a), hydrate(second, b)]);
    expect(download).toHaveBeenCalledTimes(2);
    await expect(hydrate(first, { project: b.project, assets: a.assets })).rejects.toThrow('outside this shared project');
    expect(download).toHaveBeenCalledTimes(2);
  });

  it.each(['missing cache', 'cache open denied', 'cache write quota', 'missing Web Locks'])(
    'keeps verified downloads available with %s', async (condition) => {
      const first = await tab(); const input = await fixture(first);
      if (condition === 'missing cache') vi.stubGlobal('caches', undefined);
      if (condition === 'cache open denied') openCache.mockRejectedValue(new Error('SecurityError'));
      if (condition === 'cache write quota') {
        const cache = await openCache('punchlist-shared-assets-v1');
        vi.spyOn(cache, 'put').mockRejectedValue(new Error('QuotaExceededError'));
      }
      if (condition === 'missing Web Locks') vi.stubGlobal('navigator', {});
      download.mockResolvedValue({ data: input.blob, error: null });
      await hydrate(first, input);
      await hydrate(await tab(), input);
      expect(download).toHaveBeenCalledTimes(condition === 'missing Web Locks' ? 1 : 2);
    }
  );

  it.each(['legacy', 'larger than cache limit'])('retains ordinary downloads for %s objects', async (kind) => {
    const first = await tab(); const second = await tab();
    const input = await fixture(first, kind === 'legacy' ? 'legacy photo' : 'a'.repeat(1024 * 1024 + 1));
    if (kind === 'legacy') delete input.reference.sha256;
    download.mockResolvedValue({ data: input.blob, error: null });
    await Promise.all([hydrate(first, input), hydrate(second, input)]);
    expect(download).toHaveBeenCalledTimes(2);
    expect(requestLock.mock.calls.filter(([name]) => String(name).includes(input.reference.path))).toHaveLength(0);
    expect([...cachesByName.values()].flatMap((cache) => [...cache.entries.keys()])).toHaveLength(0);
  });

  it('preserves saved photos, unsynced edits, queues and session storage while coordinating downloads', async () => {
    const first = await tab(); const second = await tab(); const remote = await fixture(first);
    const db = await import('@/lib/db');
    const local = structuredClone(remote.project);
    local.sharedSnapshotPublishedAt = new Date(0); local.sharedBaselinePublishedAt = new Date(0);
    await db.saveProjectPreserveTimestamps(local);
    local.areas[0].notes = 'Unsent inspection note';
    const cp = local.areas[0].locations[0].items[0].checkpoints[0];
    cp.photos.push(createPhotoAttachment(cp.id, 'data:image/jpeg;base64,dW5zZW50'));
    await db.saveProjectArea(local, local.areas[0].id);
    const before = await db.getProject(local.id);
    const pending = await db.getPendingSharedAreaSyncsForProject(local.id);
    expect(pending.length).toBeGreaterThan(0);
    const cookieWrite = vi.fn();
    vi.stubGlobal('document', Object.defineProperty({}, 'cookie', { get: () => 'session=preserved', set: cookieWrite }));
    download.mockResolvedValue({ data: remote.blob, error: null });
    await Promise.all([hydrate(first, remote), hydrate(second, remote)]);
    expect(await db.getProject(local.id)).toEqual(before);
    expect(await db.getPendingSharedAreaSyncsForProject(local.id)).toEqual(pending);
    expect(storage.get('auth-sentinel')).toBe('preserve-session');
    expect(cookieWrite).not.toHaveBeenCalled();
  });
});
