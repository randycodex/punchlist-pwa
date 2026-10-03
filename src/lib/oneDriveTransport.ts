/** Account-bound refresh registrations preserve the string credential API used by exports. */
type RefreshState = { token: string; refresh: () => Promise<string | null>; pending?: Promise<string | null>; isCurrentAccount: () => boolean };
const refreshers = new Map<string, RefreshState>();
export function clearOneDriveTokenRefresh() { refreshers.clear(); }
export function registerOneDriveTokenRefresh(token: string, refresh: () => Promise<string | null>, isCurrentAccount: () => boolean = () => true) {
  refreshers.set(token, { token, refresh, isCurrentAccount });
  // No persistence; bound stale credentials retained by completed operations.
  while (refreshers.size > 16) refreshers.delete(refreshers.keys().next().value!);
}

const REQUEST_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 4;

function aborted(signal: AbortSignal) {
  return signal.reason ?? new DOMException('OneDrive transfer cancelled.', 'AbortError');
}
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The operation may have started just before cancellation; consume a later
    // rejection even though the caller must stop immediately.
    void promise.catch(() => {});
    return Promise.reject(aborted(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(aborted(signal)); return; }
    const onAbort = () => { clearTimeout(timer); reject(aborted(signal!)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
function retryDelay(response: Response, attempt: number) {
  const value = response.headers.get('Retry-After');
  if (value) {
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(ms)) return Math.max(0, ms);
  }
  return Math.min(1_000 * 2 ** attempt, 8_000);
}

/**
 * A deadline includes response-body reads, not just headers. Only read requests
 * retry uncertain failures: a conditional write might already have committed.
 * Rejected 429/401 responses may retry any method without replaying a commit.
 */
export async function fetchOneDriveRequest(
  initialToken: string, url: string, options: RequestInit,
  controls: { assertActive?: () => void; signal?: AbortSignal } = {}
): Promise<Response> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  const refreshState = refreshers.get(initialToken);
  let token = refreshState?.token ?? initialToken;
  let refreshed = false;
  const readOnly = ['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase());
  const outerSignal = controls.signal ?? options.signal ?? undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (Date.now() >= deadline) throw new DOMException('OneDrive transfer timed out. Retry to continue.', 'TimeoutError');
    controls.assertActive?.();
    if (refreshState && !refreshState.isCurrentAccount()) throw new Error('The Microsoft account changed. Retry from the current account.');
    if (outerSignal?.aborted) throw aborted(outerSignal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(outerSignal?.reason);
    outerSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException(
      'OneDrive request timed out. Your local work is preserved; retry to continue.', 'TimeoutError'
    )), Math.max(0, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())));
    let response: Response;
    try {
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${token}`);
      response = await cancellable(fetch(url, { ...options, headers, signal: controller.signal }), controller.signal);
      // Buffer within the deadline so a stalled download cannot hold sync forever.
      const bytes = await cancellable(response.arrayBuffer(), controller.signal);
      response = new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : bytes, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
      controls.assertActive?.();
      if (refreshState && !refreshState.isCurrentAccount()) throw new Error('The Microsoft account changed. Retry from the current account.');
    } catch (error) {
      if (outerSignal?.aborted) throw aborted(outerSignal);
      controls.assertActive?.();
      if (!readOnly || attempt === MAX_ATTEMPTS - 1 || Date.now() >= deadline) throw error;
      await delay(Math.min(1_000 * 2 ** attempt, Math.max(0, deadline - Date.now())), outerSignal);
      continue;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onAbort);
    }
    if (response.status === 401 && !refreshed && refreshState && attempt < MAX_ATTEMPTS - 1) {
      refreshed = true;
      if (refreshState.token !== token) {
        token = refreshState.token;
        continue;
      }
      const refreshController = new AbortController();
      const cancelRefresh = () => refreshController.abort(outerSignal?.reason);
      outerSignal?.addEventListener('abort', cancelRefresh, { once: true });
      const refreshTimer = setTimeout(() => refreshController.abort(new DOMException('Microsoft token refresh timed out.', 'TimeoutError')),
        Math.max(0, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())));
      try {
        refreshState.pending ??= refreshState.refresh().finally(() => { refreshState.pending = undefined; });
        const next = await cancellable(refreshState.pending, refreshController.signal);
        controls.assertActive?.();
        if (!refreshState.isCurrentAccount()) throw new Error('The Microsoft account changed. Retry from the current account.');
        if (!next) return response;
        refreshState.token = token = next;
        continue;
      } catch (error) {
        if (outerSignal?.aborted) throw aborted(outerSignal);
        if (refreshController.signal.aborted) throw error;
        return response; // Existing auth handling requests a legitimate reconnect.
      } finally {
        clearTimeout(refreshTimer);
        outerSignal?.removeEventListener('abort', cancelRefresh);
      }
    }
    const retryable = response.status === 429 || (readOnly && [408, 500, 502, 503, 504, 509].includes(response.status));
    if (!retryable || attempt === MAX_ATTEMPTS - 1) return response;
    const waitMs = retryDelay(response, attempt);
    // Never shorten a server's Retry-After and hammer it earlier than requested.
    if (Date.now() + waitMs >= deadline) return response;
    await delay(waitMs, outerSignal);
  }
  throw new Error('OneDrive request retry limit reached. Retry to continue.');
}
