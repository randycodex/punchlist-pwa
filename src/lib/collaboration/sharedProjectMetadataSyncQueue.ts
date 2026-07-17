import {
  completePendingSharedProjectMetadataSync,
  discardPendingSharedProjectMetadataSync,
  getPendingSharedProjectMetadataSyncForProject,
  getPendingSharedProjectMetadataSyncs,
  getProjectMetadata,
  recordPendingSharedProjectMetadataSyncFailure,
  saveProjectMetadataWithSharedSync,
  type PendingSharedProjectMetadataSyncRecord,
} from '@/lib/db';
import type { Project } from '@/types';
import { ProjectPayloadValidationError } from '@/lib/projectPayload';
import { getCollaborationSupabaseClient } from './supabaseClient';
import {
  SharedProjectMetadataConflictError,
  isSharedProjectMetadataConflictError,
  publishSharedProjectMetadataSnapshot,
} from './sharedProjectMetadata';

export const SHARED_PROJECT_METADATA_SYNC_EVENT = 'punchlist-shared-project-metadata-sync';

export type SharedProjectMetadataSyncEventDetail = {
  status: 'pending' | 'synced' | 'conflict' | 'error';
  localProjectId: string;
  sharedProjectId: string;
  metadataVersion?: number;
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

function dispatchSharedProjectMetadataSync(detail: SharedProjectMetadataSyncEventDetail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(SHARED_PROJECT_METADATA_SYNC_EVENT, { detail }));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Shared project details did not finish syncing.';
}

function shouldPauseAutomaticRetry(error: unknown) {
  if (isSharedProjectMetadataConflictError(error) || error instanceof ProjectPayloadValidationError) {
    return true;
  }
  if (!error || typeof error !== 'object') return false;
  const input = error as { code?: unknown; message?: unknown };
  const code = typeof input.code === 'string' ? input.code : '';
  const message = typeof input.message === 'string' ? input.message.toLowerCase() : '';
  return code === '22023'
    || code === '42501'
    || message.includes('publish the shared project once');
}

function ensureBrowserListeners() {
  if (browserListenersReady || typeof window === 'undefined') return;
  browserListenersReady = true;
  window.addEventListener('online', () => schedulePendingSharedProjectMetadataSyncFlush(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      schedulePendingSharedProjectMetadataSyncFlush(0);
    }
  });
}

function schedulePendingSharedProjectMetadataSyncFlush(delayMs = 700) {
  if (typeof window === 'undefined') return;
  ensureBrowserListeners();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (flushPromise) {
      flushRequested = true;
      return;
    }
    void flushPendingSharedProjectMetadataSyncs();
  }, delayMs);
}

export async function saveAndQueueSharedProjectMetadataSync(project: Project) {
  const record = await saveProjectMetadataWithSharedSync(project);
  if (!record) return { queued: false as const };
  dispatchSharedProjectMetadataSync({
    status: 'pending',
    localProjectId: record.localProjectId,
    sharedProjectId: record.sharedProjectId,
  });
  schedulePendingSharedProjectMetadataSyncFlush();
  return { queued: true as const, record };
}

async function syncRecord(
  record: PendingSharedProjectMetadataSyncRecord
): Promise<'synced' | 'pending' | 'conflict'> {
  if (record.blockedByConflict) return 'conflict';
  const project = await getProjectMetadata(record.localProjectId);
  if (!project || project.sharedProjectId !== record.sharedProjectId) {
    await discardPendingSharedProjectMetadataSync(record.key);
    return 'synced';
  }

  try {
    const result = await publishSharedProjectMetadataSnapshot({
      project,
      baseVersion: Math.max(record.baseVersion, project.sharedMetadataVersion ?? 0),
      clientId: record.clientId,
    });
    const completion = await completePendingSharedProjectMetadataSync({
      key: record.key,
      clientId: record.clientId,
      revision: record.revision,
      metadataVersion: result.metadataVersion,
      publishedAt: result.publishedAt,
    });
    dispatchSharedProjectMetadataSync({
      status: completion.stillPending ? 'pending' : 'synced',
      localProjectId: record.localProjectId,
      sharedProjectId: record.sharedProjectId,
      metadataVersion: result.metadataVersion,
      publishedAt: result.publishedAt,
    });
    if (completion.stillPending) {
      schedulePendingSharedProjectMetadataSyncFlush(0);
      return 'pending';
    }
    return 'synced';
  } catch (error) {
    const message = getErrorMessage(error);
    const conflicted = shouldPauseAutomaticRetry(error);
    await recordPendingSharedProjectMetadataSyncFailure(
      record.key,
      record.clientId,
      message,
      conflicted
    );
    dispatchSharedProjectMetadataSync({
      status: conflicted ? 'conflict' : 'error',
      localProjectId: record.localProjectId,
      sharedProjectId: record.sharedProjectId,
      message,
    });
    if (!conflicted) {
      const retryDelay = Math.min(30_000, 2_000 * (2 ** Math.min(record.attemptCount, 4)));
      schedulePendingSharedProjectMetadataSyncFlush(retryDelay);
    }
    return conflicted ? 'conflict' : 'pending';
  }
}

export async function flushPendingSharedProjectMetadataSyncs(): Promise<FlushSummary> {
  if (flushPromise) return flushPromise;

  flushPromise = (async () => {
    ensureBrowserListeners();
    const records = await getPendingSharedProjectMetadataSyncs();
    if (records.length === 0) return { synced: 0, pending: 0, conflicted: 0 };
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return { synced: 0, pending: records.length, conflicted: 0 };
    }

    const supabase = getCollaborationSupabaseClient();
    if (!supabase) return { synced: 0, pending: records.length, conflicted: 0 };
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.user.id) {
      return { synced: 0, pending: records.length, conflicted: 0 };
    }

    let synced = 0;
    let pending = 0;
    let conflicted = 0;
    for (const record of records) {
      const result = await syncRecord(record);
      if (result === 'synced') synced += 1;
      else if (result === 'conflict') conflicted += 1;
      else pending += 1;
    }
    return { synced, pending, conflicted };
  })().finally(() => {
    flushPromise = null;
    if (flushRequested) {
      flushRequested = false;
      schedulePendingSharedProjectMetadataSyncFlush(0);
    }
  });

  return flushPromise;
}

export async function settlePendingSharedProjectMetadataSync(project: Project) {
  await flushPendingSharedProjectMetadataSyncs();
  const pending = await getPendingSharedProjectMetadataSyncForProject(project.id);
  if (pending) {
    if (pending.blockedByConflict) {
      throw new SharedProjectMetadataConflictError();
    }
    throw new Error(
      pending.lastError
        || 'Shared project details are still queued. Check your connection and try again.'
    );
  }

  const refreshedProject = await getProjectMetadata(project.id);
  if (!refreshedProject || refreshedProject.sharedProjectId !== project.sharedProjectId) {
    throw new Error('Could not verify the latest shared project details.');
  }
  project.sharedMetadataVersion = refreshedProject.sharedMetadataVersion;
  project.sharedMetadataPublishedAt = refreshedProject.sharedMetadataPublishedAt;
  project.sharedSnapshotPublishedAt = refreshedProject.sharedSnapshotPublishedAt;
  return project;
}

export async function syncSharedProjectMetadataNow(project: Project) {
  await saveAndQueueSharedProjectMetadataSync(project);
  return settlePendingSharedProjectMetadataSync(project);
}

export function resumePendingSharedProjectMetadataSyncs() {
  ensureBrowserListeners();
  schedulePendingSharedProjectMetadataSyncFlush(0);
}
