import {
  getDurablePendingSyncState,
  persistDurablePendingSyncState,
} from '@/lib/db';

type PendingSyncState = {
  projectIds: string[];
  fullSyncNeeded: boolean;
  retryCount: number;
  retryNotBefore: string | null;
  autoRetryPaused: boolean;
};

const PENDING_SYNC_STORAGE_KEY = 'punchlist-pending-sync';
const MAX_STORED_RETRY_WAIT_MS = 30_000;

function getDefaultPendingSyncState(): PendingSyncState {
  return {
    projectIds: [],
    fullSyncNeeded: false,
    retryCount: 0,
    retryNotBefore: null,
    autoRetryPaused: false,
  };
}

function normalizePendingSyncState(raw: unknown): PendingSyncState {
  if (!raw || typeof raw !== 'object') {
    return getDefaultPendingSyncState();
  }

  const projectIds = Array.isArray((raw as { projectIds?: unknown }).projectIds)
    ? [...new Set((raw as { projectIds: unknown[] }).projectIds.filter((value): value is string => typeof value === 'string' && value.length > 0))]
    : [];
  const fullSyncNeeded = Boolean((raw as { fullSyncNeeded?: unknown }).fullSyncNeeded);
  const retryCount = Number((raw as { retryCount?: unknown }).retryCount);
  const retryNotBefore = (raw as { retryNotBefore?: unknown }).retryNotBefore;
  const autoRetryPaused = Boolean((raw as { autoRetryPaused?: unknown }).autoRetryPaused);

  return {
    projectIds,
    fullSyncNeeded,
    retryCount: Number.isFinite(retryCount) && retryCount > 0 ? retryCount : 0,
    retryNotBefore: typeof retryNotBefore === 'string' ? retryNotBefore : null,
    autoRetryPaused,
  };
}

function persistPendingSyncState(state: PendingSyncState) {
  if (typeof window === 'undefined') return;

  void persistDurablePendingSyncState(state.projectIds, state.fullSyncNeeded).catch((error) => {
    console.info('Durable pending sync state could not be updated:', error);
  });

  if (
    state.projectIds.length === 0 &&
    !state.fullSyncNeeded &&
    state.retryCount === 0 &&
    !state.retryNotBefore &&
    !state.autoRetryPaused
  ) {
    localStorage.removeItem(PENDING_SYNC_STORAGE_KEY);
    return;
  }

  localStorage.setItem(PENDING_SYNC_STORAGE_KEY, JSON.stringify(state));
}

export async function restorePendingSyncStateFromDurableStorage() {
  const localState = loadPendingSyncState();
  try {
    const durableState = await getDurablePendingSyncState();
    const restoredState: PendingSyncState = {
      ...localState,
      projectIds: [...new Set([...durableState.projectIds, ...localState.projectIds])],
      fullSyncNeeded: durableState.fullSyncNeeded || localState.fullSyncNeeded,
    };
    persistPendingSyncState(restoredState);
    return restoredState;
  } catch (error) {
    console.info('Durable pending sync state could not be restored:', error);
    return localState;
  }
}

export function loadPendingSyncState(): PendingSyncState {
  if (typeof window === 'undefined') {
    return getDefaultPendingSyncState();
  }

  try {
    const raw = localStorage.getItem(PENDING_SYNC_STORAGE_KEY);
    if (!raw) {
      return getDefaultPendingSyncState();
    }
    return normalizePendingSyncState(JSON.parse(raw));
  } catch {
    return getDefaultPendingSyncState();
  }
}

export function hasPendingSyncState() {
  const state = loadPendingSyncState();
  return state.projectIds.length > 0 || state.fullSyncNeeded;
}

export function queuePendingSync(projectId?: string, options?: { fullSync?: boolean }) {
  const state = loadPendingSyncState();
  const projectIds = new Set(state.projectIds);
  if (projectId) {
    projectIds.add(projectId);
  }

  persistPendingSyncState({
    projectIds: [...projectIds],
    fullSyncNeeded: state.fullSyncNeeded || Boolean(options?.fullSync),
    retryCount: state.retryCount,
    retryNotBefore: state.retryNotBefore,
    autoRetryPaused: state.autoRetryPaused,
  });
}

export function clearPendingSyncState() {
  persistPendingSyncState(getDefaultPendingSyncState());
}

export function clearPendingProjectSync(projectIds: string[]) {
  if (projectIds.length === 0) return;
  const state = loadPendingSyncState();
  const completedIds = new Set(projectIds);
  persistPendingSyncState({
    projectIds: state.projectIds.filter((projectId) => !completedIds.has(projectId)),
    fullSyncNeeded: state.fullSyncNeeded,
    retryCount: state.retryCount,
    retryNotBefore: state.retryNotBefore,
    autoRetryPaused: state.autoRetryPaused,
  });
}

export function isPendingSyncAutoRetryPaused() {
  return loadPendingSyncState().autoRetryPaused;
}

export function pausePendingSyncAutoRetry() {
  const state = loadPendingSyncState();
  persistPendingSyncState({
    ...state,
    retryNotBefore: null,
    autoRetryPaused: true,
  });
}

export function resumePendingSyncAutoRetry() {
  const state = loadPendingSyncState();
  persistPendingSyncState({
    ...state,
    retryCount: 0,
    retryNotBefore: null,
    autoRetryPaused: false,
  });
}

export function recordPendingSyncRetry(
  baseDelayMs: number,
  options?: {
    minDelayMs?: number;
    maxDelayMs?: number;
  }
) {
  const state = loadPendingSyncState();
  const retryCount = Math.min(state.retryCount + 1, 5);
  const minDelayMs = options?.minDelayMs ?? 15_000;
  const maxDelayMs = Math.max(options?.maxDelayMs ?? MAX_STORED_RETRY_WAIT_MS, baseDelayMs);
  const exponentialDelayMs = Math.min(
    Math.max(baseDelayMs, minDelayMs) * 2 ** Math.max(retryCount - 1, 0),
    maxDelayMs
  );
  const retryAt = new Date(Date.now() + exponentialDelayMs);
  const retryNotBefore = retryAt.toISOString();

  persistPendingSyncState({
    ...state,
    retryCount,
    retryNotBefore,
    autoRetryPaused: false,
  });

  return {
    delayMs: exponentialDelayMs,
    retryAt,
  };
}
