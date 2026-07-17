export const COLLABORATION_REQUEST_TIMEOUT_MS = 20_000;
export const COLLABORATION_TRANSFER_TIMEOUT_MS = 90_000;

type CollaborationRequestPolicy = {
  operation: string;
  timeoutMs: number;
};

function getRequestUrl(input: RequestInfo | URL) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function getCollaborationRequestPolicy(
  input: RequestInfo | URL,
  init?: RequestInit
): CollaborationRequestPolicy {
  const url = getRequestUrl(input);

  if (url.includes('/rpc/publish_shared_project_snapshot')) {
    return {
      operation: 'Publishing shared data',
      timeoutMs: COLLABORATION_TRANSFER_TIMEOUT_MS,
    };
  }

  if (url.includes('/rpc/publish_shared_project_area_snapshot')) {
    return {
      operation: 'Syncing shared area',
      timeoutMs: COLLABORATION_TRANSFER_TIMEOUT_MS,
    };
  }

  if (url.includes('/rpc/capture_shared_project_backup')) {
    return {
      operation: 'Saving shared backup',
      timeoutMs: COLLABORATION_TRANSFER_TIMEOUT_MS,
    };
  }

  if (url.includes('/shared_project_snapshots')) {
    return {
      operation: init?.method?.toUpperCase() === 'GET' ? 'Pulling shared data' : 'Transferring shared data',
      timeoutMs: COLLABORATION_TRANSFER_TIMEOUT_MS,
    };
  }

  if (url.includes('/shared_project_area_snapshots')) {
    return {
      operation: 'Pulling shared area updates',
      timeoutMs: COLLABORATION_TRANSFER_TIMEOUT_MS,
    };
  }

  if (url.includes('/storage/v1/object')) {
    const method = init?.method?.toUpperCase() ?? 'GET';
    return {
      operation: method === 'GET' ? 'Downloading shared attachments' : 'Uploading shared attachments',
      timeoutMs: COLLABORATION_TRANSFER_TIMEOUT_MS,
    };
  }

  return {
    operation: 'Collaboration request',
    timeoutMs: COLLABORATION_REQUEST_TIMEOUT_MS,
  };
}

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
  const policy = getCollaborationRequestPolicy(input, init);
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
  }, policy.timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new CollaborationRequestTimeoutError(policy.operation, policy.timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}
