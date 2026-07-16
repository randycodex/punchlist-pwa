export const COLLABORATION_REQUEST_TIMEOUT_MS = 20_000;

export class CollaborationRequestTimeoutError extends Error {
  readonly code = 'COLLABORATION_REQUEST_TIMEOUT';

  constructor(operation = 'Collaboration request', timeoutMs = COLLABORATION_REQUEST_TIMEOUT_MS) {
    super(`${operation} timed out after ${Math.ceil(timeoutMs / 1_000)} seconds. Check your connection and try again.`);
    this.name = 'CollaborationRequestTimeoutError';
  }
}

export async function withCollaborationTimeout<T>(
  request: PromiseLike<T>,
  operation = 'Collaboration request',
  timeoutMs = COLLABORATION_REQUEST_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new CollaborationRequestTimeoutError(operation, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve(request), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function fetchWithCollaborationTimeout(
  input: RequestInfo | URL,
  init?: RequestInit
) {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  let timedOut = false;

  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, COLLABORATION_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new CollaborationRequestTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}
