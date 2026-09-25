import { afterEach, expect, it, vi } from 'vitest';
import { acquireSyncLease } from '@/lib/oneDrive';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
