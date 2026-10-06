'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getAllProjects } from '@/lib/db';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { AppUpdateWaitingError, isOfflinePage, offlineBuild, prepareSavedProjectPages, registerInspectionWorker } from './sitePreparation';

type StatusNotice = { message: string; kind: 'offline' | 'preparation'; error?: boolean };

export default function OfflineAppStatus() {
  const pathname = usePathname();
  const showAboveAddButton = pathname === '/' || /^\/project\/[^/]+$/.test(pathname);
  const isAreaRoute = /^\/project\/[^/]+\/area\/[^/]+$/.test(pathname);
  const floatingStatusClass = 'pointer-events-auto fixed inset-x-4 z-20 mx-auto max-w-sm px-2 text-center text-xs leading-4 text-slate-700 dark:text-slate-300';
  const [notice, setNotice] = useState<StatusNotice | null>(null);
  const activeNotice = useRef<StatusNotice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [retry, setRetry] = useState(0);
  const { localSaveStatus } = useSyncStatus();
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [updating, setUpdating] = useState(false);
  const reloadForUpdate = useRef(false);
  const clearNotice = useCallback(() => {
    clearTimeout(noticeTimer.current);
    noticeTimer.current = undefined;
    activeNotice.current = null;
    setNotice(null);
  }, []);
  const showNotice = useCallback((next: StatusNotice) => {
    if (next.kind !== 'offline' && !navigator.onLine) return;
    const current = activeNotice.current;
    if (current?.kind === next.kind && current.message === next.message && current.error === next.error) return;
    clearTimeout(noticeTimer.current);
    activeNotice.current = next;
    setNotice(next);
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = undefined;
      activeNotice.current = null;
      setNotice(null);
    }, 30_000);
  }, []);
  useEffect(() => () => {
    clearTimeout(noticeTimer.current);
    noticeTimer.current = undefined;
    activeNotice.current = null;
  }, []);
  useEffect(() => {
    if (offlineBuild === 'development' || !('serviceWorker' in navigator)) return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null = null;
    const showWaiting = () => {
      if (!disposed && registration?.waiting) setUpdateRegistration(registration);
    };
    const onStateChange = () => showWaiting();
    const onUpdateFound = () => {
      installing?.removeEventListener('statechange', onStateChange);
      installing = registration?.installing ?? null;
      installing?.addEventListener('statechange', onStateChange);
      showWaiting();
    };
    const checkForUpdate = () => {
      if (navigator.onLine) void registration?.update().then(showWaiting).catch(() => {});
    };
    const onControllerChange = () => {
      if (reloadForUpdate.current) window.location.reload();
    };
    void registerInspectionWorker().then((value) => {
      if (disposed) return;
      registration = value;
      registration.addEventListener('updatefound', onUpdateFound);
      showWaiting();
      checkForUpdate();
    }).catch(() => {});
    window.addEventListener('focus', checkForUpdate);
    window.addEventListener('online', checkForUpdate);
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    return () => {
      disposed = true;
      registration?.removeEventListener('updatefound', onUpdateFound);
      installing?.removeEventListener('statechange', onStateChange);
      window.removeEventListener('focus', checkForUpdate);
      window.removeEventListener('online', checkForUpdate);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);
  useEffect(() => {
    if (offlineBuild === 'development') return;
    let disposed = false;
    let running = false;
    let requested = false;
    let firstCheck = true;
    let timer: ReturnType<typeof setTimeout>;
    const prepare = async () => {
      if (disposed || !navigator.onLine) return;
      if (running) { requested = true; return; }
      running = true;
      requested = false;
      if (firstCheck) showNotice({ kind: 'preparation', message: 'Preparing saved pages for offline use…' });
      firstCheck = false;
      try {
        await prepareSavedProjectPages(await getAllProjects());
        if (!disposed) showNotice({ kind: 'preparation', message: 'App pages ready offline' });
      } catch (reason) {
        if (!disposed) {
          const updateWaiting = reason instanceof AppUpdateWaitingError;
          showNotice({
            kind: 'preparation',
            message: reason instanceof Error ? reason.message : 'Offline preparation failed. Stay online and retry.',
            error: !updateWaiting,
          });
        }
      } finally {
        running = false;
        if (requested && !disposed) schedule();
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void prepare(); }, 500);
    };
    const saved = (event: Event) => {
      if ((event as CustomEvent<{ status: string }>).detail?.status === 'saved') schedule();
    };
    schedule();
    window.addEventListener('online', schedule);
    window.addEventListener('focus', schedule);
    window.addEventListener('punchlist-local-save-status', saved);
    navigator.serviceWorker?.addEventListener('controllerchange', schedule);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('online', schedule);
      window.removeEventListener('focus', schedule);
      window.removeEventListener('punchlist-local-save-status', saved);
      navigator.serviceWorker?.removeEventListener('controllerchange', schedule);
    };
  }, [retry, showNotice]);
  useEffect(() => {
    const update = () => {
      if (!navigator.onLine) showNotice({ kind: 'offline', message: 'Offline · Edits save on this device. Team delivery waits for a connection.' });
      else if (activeNotice.current?.kind === 'offline') clearNotice();
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    // Full-document navigation uses the prepared HTML, avoiding uncached RSC requests.
    const navigate = (event: MouseEvent) => {
      if (navigator.onLine || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target || anchor.download) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin || !isOfflinePage(url.pathname)) return;
      event.preventDefault(); event.stopPropagation();
      location.assign(url.href);
    };
    document.addEventListener('click', navigate, true);
    return () => {
      window.removeEventListener('online', update); window.removeEventListener('offline', update);
      document.removeEventListener('click', navigate, true);
    };
  }, [clearNotice, showNotice]);
  if (notice?.kind === 'offline') return <div role="status" className="shrink-0 bg-amber-100 px-4 py-2 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">{notice.message}</div>;
  if (offlineBuild === 'development') return null;
  if (updateRegistration) return <div role="status" className={`${floatingStatusClass} bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] rounded-xl bg-amber-100 py-2 text-amber-950 shadow-lg dark:bg-amber-950 dark:text-amber-100`}>
    <span>A new PunchList version is ready.</span>{' '}
    <button type="button" className="ml-2 font-semibold underline disabled:opacity-50" disabled={updating || localSaveStatus !== 'saved'} onClick={() => {
      const waiting = updateRegistration.waiting;
      if (!waiting) { setUpdateRegistration(null); return; }
      reloadForUpdate.current = true;
      setUpdating(true);
      waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    }}>{updating ? 'Updating…' : localSaveStatus === 'saved' ? 'Update now' : 'Save your changes first'}</button>
  </div>;
  if (!notice) return null;
  return <div
    role="status"
    className={isAreaRoute
      ? `${floatingStatusClass} bottom-[calc(env(safe-area-inset-bottom)+4.5rem)]`
      : showAboveAddButton
        ? `${floatingStatusClass} bottom-[calc(env(safe-area-inset-bottom)+5.5rem)]`
        : 'shrink-0 bg-slate-100 px-4 py-2 text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-200'}
  >
    {notice.message}
    {notice.error && <button type="button" className="ml-2 underline" onClick={() => setRetry((value) => value + 1)}>Retry</button>}
  </div>;
}
