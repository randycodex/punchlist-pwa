import { afterEach, expect, it, vi } from 'vitest';
import { acquireSyncLease, uploadDeletionLog } from '@/lib/oneDrive';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

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

async function expiryFixture(renewalStatus = 200, writeStatus = 200, beforeWriteResponse?: () => void) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  let tick!: () => void;
  vi.stubGlobal('window', {
    setInterval: vi.fn((callback: () => void) => { tick = callback; return 1; }),
    clearInterval: vi.fn(),
  });
  let lease: string | null = null;
  let lockWrites = 0;
  let dataWrites = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.includes('sync-lock.json')) {
      if (init?.method === 'PUT') {
        lockWrites += 1;
        if (lockWrites > 1 && renewalStatus !== 200) {
          return Response.json({ error: { code: 'preconditionFailed' } }, { status: renewalStatus });
        }
        lease = String(init.body);
        return Response.json({ id: 'lock-file', eTag: `"revision-${lockWrites}"` });
      }
      if (!lease) return Response.json({ error: { code: 'itemNotFound' } }, { status: 404 });
      if (url.includes('/content')) return new Response(lease);
      return Response.json({ id: 'lock-file', eTag: `"revision-${lockWrites}"` });
    }
    if (url.includes('deletions.json')) {
      dataWrites += 1;
      beforeWriteResponse?.();
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer expiry-test');
      return Response.json({}, { status: writeStatus, headers: { 'Retry-After': '60' } });
    }
    return Response.json({ id: 'folder', name: 'PunchList', folder: {} });
  }));
  const leaseHandle = await acquireSyncLease('expiry-test');
  return { leaseHandle, tick: () => tick(), counts: () => ({ lockWrites, dataWrites }) };
}

it('rejects writes and cannot renew an expired lease after browser suspension', async () => {
  const fixture = await expiryFixture();
  vi.setSystemTime(new Date('2026-09-25T12:00:46Z'));
  fixture.tick();
  await expect(uploadDeletionLog(fixture.leaseHandle.token, {})).rejects.toThrow('lock expired or was lost');
  expect(fixture.counts()).toEqual({ lockWrites: 1, dataWrites: 0 });
  await fixture.leaseHandle();
});

it('stops writes immediately when the service rejects renewal ownership', async () => {
  const fixture = await expiryFixture(412);
  fixture.tick();
  await vi.advanceTimersByTimeAsync(0);
  await expect(uploadDeletionLog(fixture.leaseHandle.token, {})).rejects.toThrow('lock expired or was lost');
  expect(fixture.counts()).toEqual({ lockWrites: 2, dataWrites: 0 });
  await fixture.leaseHandle();
});

it('does not retry a throttled write after the lease expires', async () => {
  const fixture = await expiryFixture(200, 429);
  const result = uploadDeletionLog(fixture.leaseHandle.token, {}).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await result).toMatchObject({ message: expect.stringContaining('lock expired or was lost') });
  expect(fixture.counts().dataWrites).toBe(1);
  await fixture.leaseHandle();
});

it('allows writes after a timely renewal, but rejects writes after release', async () => {
  const fixture = await expiryFixture();
  await vi.advanceTimersByTimeAsync(20_000);
  fixture.tick();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(30_000);
  await uploadDeletionLog(fixture.leaseHandle.token, {});
  expect(fixture.counts().dataWrites).toBe(1);
  await fixture.leaseHandle();
  await expect(uploadDeletionLog(fixture.leaseHandle.token, {})).rejects.toThrow('lock expired or was lost');
  expect(fixture.counts().dataWrites).toBe(1);
});

it('rejects an upload response arriving after expiry instead of acknowledging success', async () => {
  const fixture = await expiryFixture(200, 200, () => {
    vi.setSystemTime(new Date('2026-09-25T12:00:46Z'));
  });
  await expect(uploadDeletionLog(fixture.leaseHandle.token, {})).rejects.toThrow('lock expired or was lost');
  expect(fixture.counts().dataWrites).toBe(1);
  await fixture.leaseHandle();
});
