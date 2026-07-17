import {
  completePendingSharedAreaSync,
  discardPendingSharedAreaSync,
  getPendingSharedAreaSyncs,
  getProjectForArea,
  queuePendingSharedAreaSync,
  recordPendingSharedAreaSyncFailure,
  type PendingSharedAreaSyncRecord,
} from '@/lib/db';
import type { Project } from '@/types';
import { getCollaborationSupabaseClient } from './supabaseClient';
import {
  isSharedProjectAreaConflictError,
  publishSharedProjectAreaSnapshot,
} from './sharedProjectAreas';

export const SHARED_AREA_SYNC_EVENT = 'punchlist-shared-area-sync';

export type SharedAreaSyncEventDetail = {
  status: 'pending' | 'synced' | 'conflict' | 'error';
  localProjectId: string;
  sharedProjectId: string;
  areaId: string;
  areaVersion?: number;
  publishedAt?: string;
  message?: string;
};

type FlushSummary = {
  synced: number;
  pending: number;
  conflicted: number;
};

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushPromise: Promise<FlushSummary> | null = null;
let flushRequested = false;
let browserListenersReady = false;

function dispatchSharedAreaSync(detail: SharedAreaSyncEventDetail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(SHARED_AREA_SYNC_EVENT, { detail }));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Shared area sync did not finish.';
}

function shouldPauseAutomaticRetry(error: unknown) {
  if (isSharedProjectAreaConflictError(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const input = error as { code?: unknown; message?: unknown };
  const code = typeof input.code === 'string' ? input.code : '';
  const message = typeof input.message === 'string' ? input.message.toLowerCase() : '';
  return code === '42501'
    || message.includes('publish the shared project once');
}

function ensureBrowserListeners() {
  if (browserListenersReady || typeof window === 'undefined') return;
  browserListenersReady = true;
  window.addEventListener('online', () => schedulePendingSharedAreaSyncFlush(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      schedulePendingSharedAreaSyncFlush(0);
    }
  });
}

function schedulePendingSharedAreaSyncFlush(delayMs = 700) {
  if (typeof window === 'undefined') return;
  ensureBrowserListeners();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (flushPromise) {
      flushRequested = true;
      return;
    }
    void flushPendingSharedAreaSyncs();
  }, delayMs);
}

export async function queueSharedProjectAreaSync(project: Project, areaId: string) {
  const sharedProjectId = project.sharedProjectId;
  const area = project.areas.find((entry) => entry.id === areaId);
  if (!sharedProjectId || !project.sharedSnapshotPublishedAt || !area) {
    return { queued: false as const };
  }

  const record = await queuePendingSharedAreaSync({
    localProjectId: project.id,
    sharedProjectId,
    areaId,
    baseVersion: area.sharedVersion ?? 0,
    basePublishedAt: (
      area.sharedPublishedAt
      ?? project.sharedBaselinePublishedAt
      ?? project.sharedSnapshotPublishedAt
    ).toISOString(),
  });
  dispatchSharedAreaSync({
    status: 'pending',
    localProjectId: project.id,
    sharedProjectId,
    areaId,
  });
  schedulePendingSharedAreaSyncFlush();
  return { queued: true as const, record };
}

async function syncRecord(
  record: PendingSharedAreaSyncRecord,
  publishedByUserId: string
): Promise<'synced' | 'pending' | 'conflict'> {
  if (record.blockedByConflict) return 'conflict';
  const project = await getProjectForArea(record.localProjectId, record.areaId);
  if (!project || project.sharedProjectId !== record.sharedProjectId) {
    await discardPendingSharedAreaSync(record.key);
    return 'synced';
  }
  const area = project.areas.find((entry) => entry.id === record.areaId);
  if (!area) {
    await discardPendingSharedAreaSync(record.key);
    return 'synced';
  }

  try {
    const areaBaseVersion = area.sharedVersion ?? 0;
    const useAreaBase = areaBaseVersion > record.baseVersion && area.sharedPublishedAt;
    const result = await publishSharedProjectAreaSnapshot({
      project,
      areaId: record.areaId,
      baseVersion: Math.max(record.baseVersion, areaBaseVersion),
      basePublishedAt: useAreaBase ? area.sharedPublishedAt!.toISOString() : record.basePublishedAt,
      clientId: record.clientId,
      publishedByUserId,
    });
    const completion = await completePendingSharedAreaSync({
      key: record.key,
      clientId: record.clientId,
      revision: record.revision,
      areaVersion: result.areaVersion,
      publishedAt: result.publishedAt,
    });
    dispatchSharedAreaSync({
      status: completion.stillPending ? 'pending' : 'synced',
      localProjectId: record.localProjectId,
      sharedProjectId: record.sharedProjectId,
      areaId: record.areaId,
      areaVersion: result.areaVersion,
      publishedAt: result.publishedAt,
    });
    if (completion.stillPending) {
      schedulePendingSharedAreaSyncFlush(0);
      return 'pending';
    }
    return 'synced';
  } catch (error) {
    const message = getErrorMessage(error);
    const conflicted = shouldPauseAutomaticRetry(error);
    await recordPendingSharedAreaSyncFailure(record.key, record.clientId, message, conflicted);
    dispatchSharedAreaSync({
      status: conflicted ? 'conflict' : 'error',
      localProjectId: record.localProjectId,
      sharedProjectId: record.sharedProjectId,
      areaId: record.areaId,
      message,
    });
    if (!conflicted) {
      const retryDelay = Math.min(30_000, 2_000 * (2 ** Math.min(record.attemptCount, 4)));
      schedulePendingSharedAreaSyncFlush(retryDelay);
    }
    return conflicted ? 'conflict' : 'pending';
  }
}

export async function flushPendingSharedAreaSyncs(): Promise<FlushSummary> {
  if (flushPromise) return flushPromise;

  flushPromise = (async () => {
    ensureBrowserListeners();
    const records = await getPendingSharedAreaSyncs();
    if (records.length === 0) return { synced: 0, pending: 0, conflicted: 0 };
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return { synced: 0, pending: records.length, conflicted: 0 };
    }

    const supabase = getCollaborationSupabaseClient();
    if (!supabase) return { synced: 0, pending: records.length, conflicted: 0 };
    const { data, error } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    if (error || !userId) {
      return { synced: 0, pending: records.length, conflicted: 0 };
    }

    let synced = 0;
    let pending = 0;
    let conflicted = 0;
    for (const record of records) {
      const result = await syncRecord(record, userId);
      if (result === 'synced') synced += 1;
      else if (result === 'conflict') conflicted += 1;
      else pending += 1;
    }
    return { synced, pending, conflicted };
  })().finally(() => {
    flushPromise = null;
    if (flushRequested) {
      flushRequested = false;
      schedulePendingSharedAreaSyncFlush(0);
    }
  });

  return flushPromise;
}

export function resumePendingSharedAreaSyncs() {
  ensureBrowserListeners();
  schedulePendingSharedAreaSyncFlush(0);
}
