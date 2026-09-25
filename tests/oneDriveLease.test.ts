import { afterEach, expect, it, vi } from 'vitest';
import { acquireSyncLease } from '@/lib/oneDrive';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('serializes slow renewals and waits for renewal before releasing', async () => {
  let tick!: () => void;
  vi.stubGlobal('window', {
    setInterval: vi.fn((callback: () => void) => { tick = callback; return 1; }),
    clearInterval: vi.fn(),
  });
  let lease: string | null = null;
  let etag = '"acquired"';
  let writes = 0;
  let finishRenewal!: () => void;
  const pendingRenewal = new Promise<void>((resolve) => { finishRenewal = resolve; });
  const deletes: RequestInit[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'DELETE') {
      deletes.push(init);
      return new Response(null, { status: 204 });
    }
    if (url.includes('sync-lock.json')) {
      if (init?.method === 'PUT') {
        writes += 1;
        if (writes > 1) {
          await pendingRenewal;
          etag = '"renewed"';
        }
        lease = String(init.body);
        return Response.json({ id: 'lock-file', eTag: etag });
      }
      if (!lease) return new Response(JSON.stringify({ error: { code: 'itemNotFound' } }), { status: 404 });
      if (url.includes('/content')) return new Response(lease);
      return Response.json({ id: 'lock-file', eTag: etag });
    }
    return Response.json({ id: 'folder', name: 'PunchList', folder: {} });
  }));
  const release = await acquireSyncLease('slow-renewal');
  tick();
  tick();
  expect(writes).toBe(2); // Acquisition plus one renewal, despite two timer ticks.
  const releasing = release();
  await Promise.resolve();
  expect(deletes).toHaveLength(0);
  tick(); // A callback already queued before clearInterval must do nothing.
  expect(writes).toBe(2);
  finishRenewal();
  await releasing;
  expect(deletes).toHaveLength(1);
  expect(new Headers(deletes[0].headers).get('If-Match')).toBe('"renewed"');
  tick();
  expect(writes).toBe(2);
});

it.each([true, false])('releases only the read lock version (etag available: %s)', async (hasEtag) => {
  vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
  let lease: string | null = null;
  const deletes: RequestInit[] = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'DELETE') {
      deletes.push(init);
      // Simulate another device replacing the lease after its owner was read.
      return new Response(JSON.stringify({ error: { code: 'preconditionFailed', message: 'Lock changed' } }), { status: 412 });
    }
    if (url.includes('sync-lock.json')) {
      if (init?.method === 'PUT') {
        lease = String(init.body);
        return Response.json({ id: 'lock-file', eTag: '"acquired"' });
      }
      if (!lease) return new Response(JSON.stringify({ error: { code: 'itemNotFound' } }), { status: 404 });
      if (url.includes('/content')) return new Response(lease);
      return Response.json({ id: 'lock-file', ...(hasEtag ? { eTag: '"read-version"' } : {}) });
    }
    return Response.json({ id: 'folder', name: 'PunchList', folder: {} });
  }));
  const release = await acquireSyncLease(`lease-test-${hasEtag}`);
  await release();
  await release();
  expect(deletes).toHaveLength(hasEtag ? 1 : 0);
  if (hasEtag) expect(new Headers(deletes[0].headers).get('If-Match')).toBe('"read-version"');
});
