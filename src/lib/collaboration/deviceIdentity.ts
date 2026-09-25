const KEY = 'punchlist:collaboration-device-id';

/** Stable across reloads and tabs, distinct between browser/device installations. */
export function getCollaborationDeviceId(): string {
  const stored = globalThis.localStorage?.getItem(KEY);
  if (stored && /^[0-9a-f-]{36}$/i.test(stored)) return stored;
  const id = crypto.randomUUID();
  globalThis.localStorage?.setItem(KEY, id);
  if (globalThis.localStorage?.getItem(KEY) !== id) {
    throw new Error('This browser cannot retain its device identity. Enable local storage before using team locks.');
  }
  return id;
}
