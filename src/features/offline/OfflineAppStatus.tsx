'use client';

import { useEffect, useState } from 'react';
import { isOfflinePage, offlineBuild, registerInspectionWorker } from './sitePreparation';

export default function OfflineAppStatus() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    if (offlineBuild !== 'development') void registerInspectionWorker().catch(() => { /* Preparation UI provides the recovery action. */ });
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
  return offline ? <div role="status" className="shrink-0 bg-amber-100 px-4 py-2 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">Offline · Edits save on this device. Team delivery waits for a connection.</div> : null;
}
