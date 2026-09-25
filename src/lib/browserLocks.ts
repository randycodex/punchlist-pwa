const pending = new Map<string, Promise<unknown>>();

/** Coordinate tabs sharing IndexedDB. Older browsers retain in-tab serialization. */
export async function withBrowserLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return await navigator.locks.request(`punchlist:${name}`, operation);
  }
  const previous = pending.get(name) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pending.set(name, current);
  try { return await current; }
  finally { if (pending.get(name) === current) pending.delete(name); }
}
