import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type WorkerEvent = { waitUntil: (value: Promise<unknown>) => void; [key: string]: unknown };
function worker() {
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const entries = new Map<string, Map<string, Response>>();
  const caches = {
    open: async (name: string) => {
      if (!entries.has(name)) entries.set(name, new Map());
      const cache = entries.get(name)!;
      return { keys: async () => [...cache.keys()].map((path) => ({ url: `https://app.test${path}` })), put: async (key: string, response: Response) => { cache.set(key, response.clone()); }, match: async (key: string) => cache.get(key)?.clone() };
    },
    keys: async () => [...entries.keys()], delete: async (key: string) => entries.delete(key),
  };
  const fetch = vi.fn(async (input: string | { url: string }) => {
    const path = typeof input === 'string' ? input : new URL(input.url).pathname;
    return new Response(path.endsWith('.js') ? 'bundle' : '<meta name="punchlist-build" content="test-build">', { headers: { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html' } });
  });
  const claim = vi.fn();
  runInNewContext(readFileSync('scripts/offline-worker.js', 'utf8').replace('__PUNCHLIST_BUILD__', JSON.stringify({ id: 'test-build', assets: ['/_next/static/chunk.js'] })), {
    self: { addEventListener: (name: string, handler: (event: WorkerEvent) => void) => listeners.set(name, handler), location: { origin: 'https://app.test' }, clients: { claim } },
    caches, fetch, Response, URL, AbortSignal,
  });
  async function dispatch(name: string, extra: Record<string, unknown> = {}) {
    let pending = Promise.resolve();
    listeners.get(name)!({ waitUntil: (value) => { pending = value.then(() => {}); }, ...extra });
    await pending;
  }
  async function message(type: string, paths: string[]) {
    let result: { ready?: boolean; error?: string; missing?: string[] } = {};
    await dispatch('message', { data: { type, paths }, ports: [{ postMessage: (value: typeof result) => { result = value; } }] });
    return result;
  }
  function request(path: string, mode = 'navigate', method = 'GET') {
    let response: Promise<Response> | undefined;
    listeners.get('fetch')!({ request: { url: `https://app.test${path}`, mode, method }, waitUntil: () => {}, respondWith: (value: Promise<Response>) => { response = value; } });
    return response;
  }
  return { entries, fetch, dispatch, message, request, claim };
}

describe('prepared offline application', () => {
  it('reopens prepared pages and assets with the server unavailable', async () => {
    const sw = worker(); await sw.dispatch('install');
    expect((await sw.message('PREPARE', ['/', '/project/id/area/room'])).ready).toBe(true);
    sw.fetch.mockRejectedValue(new Error('Offline'));
    expect(await (await sw.request('/project/id/area/room'))?.text()).toContain('test-build');
    expect(await (await sw.request('/_next/static/chunk.js', 'cors'))?.text()).toBe('bundle');
    expect((await sw.request('/project/unprepared'))?.status).toBe(503);
  });
  it('preserves the requested worker URL by returning a synthetic cached response', async () => {
    const sw = worker(); await sw.dispatch('install');
    const cached = new Response('worker bootstrap', { headers: { 'content-type': 'text/javascript' } });
    Object.defineProperty(cached, 'url', { value: 'https://app.test/_next/static/chunk.js' });
    cached.clone = () => cached;
    sw.entries.get('punchlist-site-v1-test-build')!.set('/_next/static/chunk.js', cached);
    const response = await sw.request('/_next/static/chunk.js#params=bootstrap', 'cors');
    expect(response?.url).toBe('');
    expect(await response?.text()).toBe('worker bootstrap');
    expect(response?.headers.get('content-type')).toBe('text/javascript');
  });
  it('carries prepared routes into an update before removing the old copy', async () => {
    const sw = worker();
    sw.entries.set('punchlist-site-v1-previous', new Map([['/project/previous', new Response('old page')]]));
    await sw.dispatch('install');
    expect((await sw.message('CHECK', ['/project/previous'])).ready).toBe(true);
    const broken = worker(); broken.entries.set('punchlist-site-v1-previous', new Map([['/project/previous', new Response('old page')]]));
    broken.fetch.mockRejectedValue(new Error('Interrupted download'));
    await expect(broken.dispatch('install')).rejects.toThrow();
    expect(broken.entries.has('punchlist-site-v1-previous')).toBe(true);
  });
  it('never intercepts API, auth, RSC or mutations', async () => {
    const sw = worker();
    expect(sw.request('/api/auth')).toBeUndefined();
    expect(sw.request('/project/id?_rsc=token', 'cors')).toBeUndefined();
    expect(sw.request('/project/id', 'navigate', 'POST')).toBeUndefined();
    expect((await sw.message('PREPARE', ['https://external.test/'])).error).toBeTruthy();
  });
  it('detects evicted pages and assets instead of trusting a stored ready flag', async () => {
    const sw = worker(); await sw.dispatch('install'); await sw.message('PREPARE', ['/project/id']);
    sw.entries.get('punchlist-site-v1-test-build')!.delete('/_next/static/chunk.js');
    expect((await sw.message('CHECK', ['/project/id'])).ready).toBe(false);
  });
  it('rejects mixed-build preparation and keeps unrelated caches on activation', async () => {
    const sw = worker(); await sw.dispatch('install');
    sw.entries.set('voice-model', new Map()); sw.entries.set('punchlist-site-v1-old-build', new Map());
    sw.fetch.mockResolvedValue(new Response('<meta name="punchlist-build" content="different">', { headers: { 'content-type': 'text/html' } }));
    expect((await sw.message('PREPARE', ['/project/id'])).error).toContain('update');
    await sw.dispatch('activate');
    expect(sw.entries.has('voice-model')).toBe(true); expect(sw.entries.has('punchlist-site-v1-old-build')).toBe(false); expect(sw.claim).toHaveBeenCalled();
  });
});
