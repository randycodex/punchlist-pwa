'use client';

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';

export type SyncStatus = 'idle' | 'syncing' | 'pending' | 'needs-auth' | 'error';

type SyncStatusContextValue = {
  status: SyncStatus;
  setStatus: (status: SyncStatus) => void;
  retryAt: Date | null;
  retryInSeconds: number;
  setRetryAt: (retryAt: Date | null) => void;
};

const SyncStatusContext = createContext<SyncStatusContextValue | undefined>(undefined);

export function SyncStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [retryAt, setRetryAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  const retryInSeconds = useMemo(() => {
    if (!retryAt) return 0;
    return Math.max(0, Math.ceil((retryAt.getTime() - now) / 1000));
  }, [now, retryAt]);

  const value = useMemo(
    () => ({ status, setStatus, retryAt, retryInSeconds, setRetryAt }),
    [retryAt, retryInSeconds, status]
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
