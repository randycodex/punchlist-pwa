/** Debounce bursts and keep one follow-up when an update arrives during a refresh. */
export function createRefreshScheduler(run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let running = false;
  let requested = false;
  function schedule(delayMs = 250) {
    if (!active) return;
    requested = true;
    if (running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void flush(); }, delayMs);
  }
  async function flush() {
    if (!active || running) return;
    requested = false;
    running = true;
    try { await run(); }
    finally {
      running = false;
      if (requested) schedule();
    }
  }
  return { schedule, dispose() { active = false; if (timer) clearTimeout(timer); } };
}
