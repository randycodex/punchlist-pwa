'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { readAreaReturnTarget, clearAreaReturnTarget } from '@/lib/areaReturnPosition';

// The app scrolls its main panel, not the document, so browser scroll restoration
// alone cannot restore the area list after the data has loaded.
export default function AreaListReturnPosition({ projectId }: { projectId?: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (!projectId) return;
    const areaId = readAreaReturnTarget(projectId);
    const scroller = marker.current?.parentElement;
    if (!areaId || !scroller) return;
    let frame = 0;
    let stopped = false;
    const observer = new MutationObserver(schedule);

    function stop() {
      stopped = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller?.removeEventListener('wheel', stopForUser);
      scroller?.removeEventListener('touchstart', stopForUser);
      scroller?.removeEventListener('keydown', stopForUser);
    }
    function stopForUser() {
      clearAreaReturnTarget(projectId!, areaId!);
      stop();
    }
    function restore() {
      if (stopped || !scroller) return;
      const card = Array.from(scroller.querySelectorAll<HTMLElement>('[data-area-id]'))
        .find((node) => node.dataset.areaId === areaId);
      if (!card || !card.getClientRects().length) return;
      const bounds = scroller.getBoundingClientRect();
      const target = card.getBoundingClientRect();
      scroller.scrollTop += target.top - bounds.top - Math.max(0, (scroller.clientHeight - target.height) / 2);
      clearAreaReturnTarget(projectId!, areaId!);
      stop();
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(restore); });
    }
    observer.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener('wheel', stopForUser, { passive: true });
    scroller.addEventListener('touchstart', stopForUser, { passive: true });
    scroller.addEventListener('keydown', stopForUser);
    schedule();
    return stop;
  }, [projectId, pathname]);

  return <span ref={marker} hidden aria-hidden="true" />;
}
