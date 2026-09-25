/** Coordinate tabs sharing IndexedDB. Older browsers retain in-tab serialization. */
export async function withBrowserLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return await navigator.locks.request(`punchlist:${name}`, operation);
  }
  return operation();
}
