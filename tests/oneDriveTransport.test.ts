import { afterEach, expect, it, vi } from 'vitest';
import { clearOneDriveTokenRefresh, fetchOneDriveRequest, registerOneDriveTokenRefresh } from '@/lib/oneDriveTransport';
afterEach(() => { clearOneDriveTokenRefresh(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('honors throttling then retries with unchanged conditional headers/body', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } })).mockResolvedValueOnce(Response.json({ id: 'same' }));
  vi.stubGlobal('fetch', fetcher);
  const request = fetchOneDriveRequest('token', 'https://graph.microsoft.com/test', { method: 'PUT', headers: { 'If-Match': 'old' }, body: 'payload' });
  await vi.advanceTimersByTimeAsync(1_999); expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect((await request).status).toBe(200);
  expect(fetcher.mock.calls[1][1].body).toBe('payload');
  expect(fetcher.mock.calls[1][1].headers.get('If-Match')).toBe('old');
});
it('does not shorten a Retry-After beyond its deadline', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '3600' } })); vi.stubGlobal('fetch', fetcher);
  expect((await fetchOneDriveRequest('token', 'test', {})).status).toBe(429); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('retries transient reads, but never uncertain conditional writes', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('download'));
  vi.stubGlobal('fetch', fetcher);
  const request = fetchOneDriveRequest('token', 'test', {}); await vi.advanceTimersByTimeAsync(1_000); expect(await (await request).text()).toBe('download');
  fetcher.mockReset().mockRejectedValue(new TypeError('network'));
  await expect(fetchOneDriveRequest('token', 'test', { method: 'PUT', headers: { 'If-Match': 'old' }, body: 'data' })).rejects.toThrow('network'); expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockReset().mockResolvedValue(new Response('', { status: 503 }));
  expect((await fetchOneDriveRequest('token', 'test', { method: 'POST' })).status).toBe(503); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('silently refreshes once on 401 and resumes the same request', async () => {
  const refresh = vi.fn().mockResolvedValue('new'); registerOneDriveTokenRefresh('old', refresh);
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('ok')).mockResolvedValueOnce(new Response('next'));
  vi.stubGlobal('fetch', fetcher);
  expect(await (await fetchOneDriveRequest('old', 'test', { method: 'PUT', body: 'same' })).text()).toBe('ok');
  await fetchOneDriveRequest('old', 'test', {});
  expect(fetcher.mock.calls[1][1].headers.get('Authorization')).toBe('Bearer new');
  expect(fetcher.mock.calls[1][1].body).toBe('same');
  expect(fetcher.mock.calls[2][1].headers.get('Authorization')).toBe('Bearer new'); expect(refresh).toHaveBeenCalledTimes(1);
});
it('returns auth denial when silent recovery requires interaction', async () => {
  registerOneDriveTokenRefresh('old', async () => { throw new Error('interaction required'); });
  const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 401 })); vi.stubGlobal('fetch', fetcher);
  expect((await fetchOneDriveRequest('old', 'test', {})).status).toBe(401); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('cancels in-flight requests and throttling waits without replay', async () => {
  vi.useFakeTimers();
  const controller = new AbortController(); const fetcher = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetcher);
  const request = fetchOneDriveRequest('token', 'test', {}, { signal: controller.signal }); const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await rejected; expect(fetcher).toHaveBeenCalledTimes(1);
  const waiting = new AbortController(); fetcher.mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '20' } }));
  const retry = fetchOneDriveRequest('token', 'test', {}, { signal: waiting.signal }); const cancelled = expect(retry).rejects.toMatchObject({ name: 'AbortError' }); await vi.advanceTimersByTimeAsync(1); waiting.abort(); await cancelled; expect(fetcher).toHaveBeenCalledTimes(2);
});
it('bounds a stalled response body and does not replay a write', async () => {
  vi.useFakeTimers(); const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} })));
  vi.stubGlobal('fetch', fetcher); const request = fetchOneDriveRequest('token', 'test', { method: 'PUT', body: 'data' });
  const rejected = expect(request).rejects.toMatchObject({ name: 'TimeoutError' }); await vi.advanceTimersByTimeAsync(30_000); await rejected; expect(fetcher).toHaveBeenCalledTimes(1);
});

it('bounds repeated failures and never retries permission or lease loss', async () => {
  vi.useFakeTimers(); const fetcher = vi.fn().mockImplementation(async () => new Response('', { status: 503 })); vi.stubGlobal('fetch', fetcher);
  const request = fetchOneDriveRequest('token', 'test', {}); await vi.advanceTimersByTimeAsync(7_000);
  expect((await request).status).toBe(503); expect(fetcher).toHaveBeenCalledTimes(4);
  fetcher.mockReset().mockResolvedValue(new Response('', { status: 403 }));
  expect((await fetchOneDriveRequest('token', 'test', {})).status).toBe(403); expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockClear();
  await expect(fetchOneDriveRequest('token', 'test', {}, { assertActive: () => { throw new Error('lease lost'); } })).rejects.toThrow('lease lost'); expect(fetcher).not.toHaveBeenCalled();
});
it('cancels a pending refresh without waiting for MSAL to finish', async () => {
  registerOneDriveTokenRefresh('old', () => new Promise(() => {}));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
  const controller = new AbortController(); const request = fetchOneDriveRequest('old', 'test', {}, { signal: controller.signal });
  const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 0)); controller.abort(); await rejected;
});

it('does not refresh or issue a request after an account switch', async () => {
  const refresh = vi.fn().mockResolvedValue('new'); registerOneDriveTokenRefresh('old', refresh, () => false);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(fetchOneDriveRequest('old', 'test', {})).rejects.toThrow('account changed'); expect(refresh).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
it('cancels stalled downloads without replay', async () => {
  const controller = new AbortController(); const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }))); vi.stubGlobal('fetch', fetcher);
  const request = fetchOneDriveRequest('old', 'test', {}, { signal: controller.signal }); const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 0)); controller.abort(); await rejected; expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects a late successful write after an account switch without acknowledging or replaying it', async () => {
  let currentAccount = true;
  registerOneDriveTokenRefresh('old', async () => 'new', () => currentAccount);
  const fetcher = vi.fn(async () => {
    currentAccount = false;
    return new Response('accepted', { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(fetchOneDriveRequest('old', 'test', { method: 'PUT', body: 'saved' })).rejects.toThrow('account changed');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
