export const COLLABORATION_REQUEST_TIMEOUT_MS = 20_000;
export const COLLABORATION_TRANSFER_TIMEOUT_MS = 90_000;
export const COLLABORATION_RETRY_ATTEMPTS = 3;

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

  if (url.includes('/rpc/publish_shared_project_metadata_snapshot')) {
    return {
      operation: 'Syncing shared project details',
      timeoutMs: COLLABORATION_REQUEST_TIMEOUT_MS,
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

  if (url.includes('/shared_project_metadata_snapshots')) {
    return {
      operation: 'Pulling shared project details',
      timeoutMs: COLLABORATION_REQUEST_TIMEOUT_MS,
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

function getCollaborationErrorText(error: unknown) {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.toLowerCase();
  }
  if (!error || typeof error !== 'object') {
    return typeof error === 'string' ? error.toLowerCase() : '';
  }

  const input = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  return [
    input.code,
    input.message,
    input.details,
    input.hint,
    input.status,
    input.statusCode,
  ]
    .filter((part): part is string | number => (
      typeof part === 'string' || typeof part === 'number'
    ))
    .join(' ')
    .toLowerCase();
}

export function isRetryableCollaborationError(error: unknown) {
  if (error instanceof CollaborationRequestTimeoutError) return true;

  const text = getCollaborationErrorText(error);
  if (!text) return false;
  return (
    text.includes('failed to fetch')
    || text.includes('load failed')
    || text.includes('network request failed')
    || text.includes('networkerror')
    || text.includes('network error')
    || text.includes('connection reset')
    || text.includes('connection closed')
    || text.includes('temporarily unavailable')
    || text.includes('service unavailable')
    || text.includes('gateway timeout')
    || text.includes('timed out')
    || text.includes('timeout')
    || /\b(408|429|500|502|503|504)\b/.test(text)
  );
}

export async function retryCollaborationOperation<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
  } = {}
) {
  const attempts = Math.max(1, options.attempts ?? COLLABORATION_RETRY_ATTEMPTS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 500);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableCollaborationError(error)) {
        throw error;
      }
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
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
