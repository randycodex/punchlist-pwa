/* Build substitutes this configuration; never serve this template directly. */
const BUILD = __PUNCHLIST_BUILD__;
const PREFIX = 'punchlist-site-v1-';
const CACHE = PREFIX + BUILD.id;
const assets = new Set(BUILD.assets);
const isPage = (path) => path === '/' || /^\/project\/[a-zA-Z0-9-]+(?:\/area\/[a-zA-Z0-9-]+)?$/.test(path);

async function checkedFetch(path, html = false) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!response.ok || response.redirected) throw new Error('Could not download an inspection page or asset.');
  if (html) {
    if (!(response.headers.get('content-type') || '').includes('text/html')) throw new Error('Expected an inspection page.');
    const text = await response.clone().text();
    if (!text.includes(`name="punchlist-build" content="${BUILD.id}"`)) throw new Error('An app update is available. Close all app tabs, reopen online, then prepare again.');
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // A failed installation leaves the previous worker and its prepared pages intact.
    const pages = new Set(['/']);
    for (const key of await caches.keys()) {
      if (!key.startsWith(PREFIX) || key === CACHE) continue;
      for (const request of await (await caches.open(key)).keys()) {
        const path = new URL(request.url).pathname;
        if (isPage(path)) pages.add(path);
      }
    }
    for (const path of [...BUILD.assets, ...pages]) await cache.put(path, await checkedFetch(path, pages.has(path)));
  })());
  // Deliberately no skipWaiting: do not replace an inspector's app during a capture.
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('message', (event) => {
  const port = event.ports[0];
  if (!port) return;
  event.waitUntil((async () => {
    try {
      const paths = event.data?.paths;
      if (!Array.isArray(paths) || !paths.length || paths.length > 1000 || paths.some((path) => typeof path !== 'string' || !isPage(path))) throw new Error('Invalid preparation request.');
      const cache = await caches.open(CACHE);
      if (event.data.type === 'PREPARE') {
        for (const path of paths) await cache.put(path, await checkedFetch(path, true));
      } else if (event.data.type !== 'CHECK') throw new Error('Unknown preparation request.');
      // Read every asset, not just a readiness flag; browser eviction invalidates readiness.
      const missing = [];
      for (const path of [...BUILD.assets, ...paths]) if (!(await cache.match(path))) missing.push(path);
      port.postMessage({ build: BUILD.id, ready: missing.length === 0, missing });
    } catch (error) { port.postMessage({ error: error.message || 'Preparation failed.' }); }
  })());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never cache auth, API, RSC, uploads, or arbitrary responses.
  if (assets.has(url.pathname) && !url.search) {
    event.respondWith((async () => {
      const cached = await (await caches.open(CACHE)).match(url.pathname);
      // A cached response's URL drops the fragment used by the worker bootstrap.
      // A synthetic response preserves the requesting worker's complete URL.
      return cached ? new Response(cached.body, { status: cached.status, headers: cached.headers }) : fetch(request);
    })());
  } else if (request.mode === 'navigate' && isPage(url.pathname)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { signal: AbortSignal.timeout(5000) });
        if (response.status >= 500) throw new Error('Server unavailable');
        return response;
      } catch {
        const cached = await (await caches.open(CACHE)).match(url.pathname);
        return cached || new Response('<!doctype html><meta name="viewport" content="width=device-width"><title>Page not prepared</title><h1>This page is not available offline</h1><p>Reconnect and prepare this project before your site visit.</p><a href="/">Open saved projects</a>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
  }
});
