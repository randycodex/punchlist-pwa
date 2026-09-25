import { localAccountKey } from '@/lib/localAccount';
function getLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readLocalStorage(key: string) {
  try {
    return getLocalStorage()?.getItem(localAccountKey(key)) ?? null;
  } catch {
    return null;
  }
}

export function writeLocalStorage(key: string, value: string) {
  try {
    const storage = getLocalStorage();
    if (!storage) return false;
    storage.setItem(localAccountKey(key), value);
    return true;
  } catch {
    return false;
  }
}
