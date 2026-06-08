type PendingSyncState = {
  projectIds: string[];
  fullSyncNeeded: boolean;
  retryCount: number;
  retryNotBefore: string | null;
};

const PENDING_SYNC_STORAGE_KEY = 'punchlist-pending-sync';
const MAX_STORED_RETRY_WAIT_MS = 30_000;

function getDefaultPendingSyncState(): PendingSyncState {
  return {
    projectIds: [],
    fullSyncNeeded: false,
    retryCount: 0,
    retryNotBefore: null,
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

  return {
    projectIds,
    fullSyncNeeded,
    retryCount: Number.isFinite(retryCount) && retryCount > 0 ? retryCount : 0,
    retryNotBefore: typeof retryNotBefore === 'string' ? retryNotBefore : null,
  };
}

function persistPendingSyncState(state: PendingSyncState) {
  if (typeof window === 'undefined') return;

  if (
    state.projectIds.length === 0 &&
    !state.fullSyncNeeded &&
    state.retryCount === 0 &&
    !state.retryNotBefore
  ) {
    localStorage.removeItem(PENDING_SYNC_STORAGE_KEY);
    return;
  }

  localStorage.setItem(PENDING_SYNC_STORAGE_KEY, JSON.stringify(state));
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
  });
}

export function clearPendingFullSyncFlag() {
  const state = loadPendingSyncState();
  persistPendingSyncState({
    projectIds: state.projectIds,
    fullSyncNeeded: false,
    retryCount: state.retryCount,
    retryNotBefore: state.retryNotBefore,
  });
}

export function clearPendingSyncBackoff() {
  const state = loadPendingSyncState();
  persistPendingSyncState({
    ...state,
    retryCount: 0,
    retryNotBefore: null,
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
  const retryNotBefore = new Date(Date.now() + exponentialDelayMs).toISOString();

  persistPendingSyncState({
    ...state,
    retryCount,
    retryNotBefore,
  });

  return exponentialDelayMs;
}

export function getPendingSyncWaitMs() {
  const retryNotBefore = loadPendingSyncState().retryNotBefore;
  if (!retryNotBefore) return 0;
  const waitMs = new Date(retryNotBefore).getTime() - Date.now();
  return Number.isFinite(waitMs) && waitMs > 0
    ? Math.min(waitMs, MAX_STORED_RETRY_WAIT_MS)
    : 0;
}
