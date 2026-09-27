'use client';

import { useEffect, useState } from 'react';
import { getAllProjects } from '@/lib/db';
import { isOfflinePage, offlineBuild, prepareSavedProjectPages } from './sitePreparation';

export default function OfflineAppStatus() {
  const [offline, setOffline] = useState(false);
  const [preparation, setPreparation] = useState('Preparing saved pages for offline use…');
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (offlineBuild === 'development') return;
    let disposed = false;
    let running = false;
    let requested = false;
    let timer: ReturnType<typeof setTimeout>;
    const prepare = async () => {
      if (disposed || !navigator.onLine) return;
      if (running) { requested = true; return; }
      running = true;
      requested = false;
      setError(false);
      setPreparation('Preparing saved pages for offline use…');
      try {
        await prepareSavedProjectPages(await getAllProjects());
        if (!disposed) setPreparation('Saved pages ready offline');
      } catch (reason) {
        if (!disposed) {
          setError(true);
          setPreparation(reason instanceof Error ? reason.message : 'Offline preparation failed. Stay online and retry.');
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
  }, [retry]);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
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
  }, []);
  if (offline) return <div role="status" className="shrink-0 bg-amber-100 px-4 py-2 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">Offline · Edits save on this device. Team delivery waits for a connection.</div>;
  if (offlineBuild === 'development') return null;
  return <div role="status" className="shrink-0 bg-slate-100 px-4 py-2 text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-200">
    {preparation}
    {error && <button type="button" className="ml-2 underline" onClick={() => setRetry((value) => value + 1)}>Retry</button>}
  </div>;
}
