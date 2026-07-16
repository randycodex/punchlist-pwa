'use client';

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { restorePendingSyncStateFromDurableStorage } from '@/lib/pendingSync';
import type { SyncConflict } from '@/lib/oneDriveSync';

export type SyncStatus = 'idle' | 'syncing' | 'pending' | 'needs-auth' | 'error';
export type LocalSaveStatus = 'saving' | 'saved' | 'error';
export type SharedTransferStatus = 'publishing' | 'pulling' | null;

type SyncStatusContextValue = {
  status: SyncStatus;
  setStatus: (status: SyncStatus) => void;
  retryAt: Date | null;
  retryInSeconds: number;
  setRetryAt: (retryAt: Date | null) => void;
  sharedUpdateProjectIds: ReadonlySet<string>;
  markSharedUpdateAvailable: (projectId: string) => void;
  clearSharedUpdateAvailable: (projectId: string) => void;
  localSaveStatus: LocalSaveStatus;
  localSaveError: string | null;
  sharedTransferStatus: SharedTransferStatus;
  setSharedTransferStatus: (status: SharedTransferStatus) => void;
  syncConflicts: SyncConflict[];
  setSyncConflicts: (conflicts: SyncConflict[]) => void;
};

const SyncStatusContext = createContext<SyncStatusContextValue | undefined>(undefined);

export function SyncStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [retryAt, setRetryAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sharedUpdateProjectIds, setSharedUpdateProjectIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [localSaveStatus, setLocalSaveStatus] = useState<LocalSaveStatus>('saved');
  const [localSaveError, setLocalSaveError] = useState<string | null>(null);
  const [sharedTransferStatus, setSharedTransferStatus] = useState<SharedTransferStatus>(null);
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);

  useEffect(() => {
    let active = true;
    void restorePendingSyncStateFromDurableStorage().then((pendingState) => {
      if (!active) return;
      if (pendingState.projectIds.length > 0 || pendingState.fullSyncNeeded) {
        setStatus((current) => current === 'idle' ? 'pending' : current);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    function handleLocalSaveStatus(event: Event) {
      const detail = (event as CustomEvent<{ status?: LocalSaveStatus; message?: string }>).detail;
      if (!detail?.status) return;
      setLocalSaveStatus(detail.status);
      setLocalSaveError(detail.status === 'error' ? detail.message ?? 'This device could not save the latest change.' : null);
    }

    window.addEventListener('punchlist-local-save-status', handleLocalSaveStatus as EventListener);
    return () => {
      window.removeEventListener('punchlist-local-save-status', handleLocalSaveStatus as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  const retryInSeconds = useMemo(() => {
    if (!retryAt) return 0;
    return Math.max(0, Math.ceil((retryAt.getTime() - now) / 1000));
  }, [now, retryAt]);

  const markSharedUpdateAvailable = useCallback((projectId: string) => {
    if (!projectId) return;
    setSharedUpdateProjectIds((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const clearSharedUpdateAvailable = useCallback((projectId: string) => {
    if (!projectId) return;
    setSharedUpdateProjectIds((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      status,
      setStatus,
      retryAt,
      retryInSeconds,
      setRetryAt,
      sharedUpdateProjectIds,
      markSharedUpdateAvailable,
      clearSharedUpdateAvailable,
      localSaveStatus,
      localSaveError,
      sharedTransferStatus,
      setSharedTransferStatus,
      syncConflicts,
      setSyncConflicts,
    }),
    [
      clearSharedUpdateAvailable,
      localSaveError,
      localSaveStatus,
      markSharedUpdateAvailable,
      retryAt,
      retryInSeconds,
      sharedTransferStatus,
      sharedUpdateProjectIds,
      status,
      syncConflicts,
    ]
  );

  return <SyncStatusContext.Provider value={value}>{children}</SyncStatusContext.Provider>;
}

export function useSyncStatus() {
  const context = useContext(SyncStatusContext);
  if (!context) {
    throw new Error('useSyncStatus must be used within a SyncStatusProvider');
  }
  return context;
}
