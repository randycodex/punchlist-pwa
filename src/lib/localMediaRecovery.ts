type Recover = (projectId: string, areaId?: string) => Promise<boolean>;
let recovery: Recover | undefined;
const pending = new Map<string, Promise<boolean>>();
const messages = new Map<string, string>();

export function getLocalMediaRecoveryMessage(projectId: string, areaId?: string) {
  return messages.get(`${projectId}:${areaId ?? '*'}`);
}

/** The signed-in app registers account-bound recovery; database reads never sign in. */
export function registerLocalMediaRecovery(handler: Recover) {
  recovery = handler;
  messages.clear();
  return () => { if (recovery === handler) { recovery = undefined; messages.clear(); } };
}

export async function tryLocalMediaRecovery(projectId: string, areaId?: string) {
  const key = `${projectId}:${areaId ?? '*'}`;
  if (messages.size > 64) messages.clear();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    messages.set(key, 'Attachment recovery needs an internet connection.');
    return false;
  }
  if (!recovery) {
    messages.set(key, 'Team attachment recovery is not ready. Check that Team Projects is signed in with the same account, then retry.');
    return false;
  }
  const existing = pending.get(key);
  if (existing) return existing;
  messages.delete(key);
  const operation = recovery(projectId, areaId).then((recovered) => {
    if (!recovered) messages.set(key, 'No matching attachment could be recovered. The local records and pending changes were kept.');
    return recovered;
  }).catch((error) => {
    const detail = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message : 'The recovery request did not finish.';
    messages.set(key, `Attachment recovery: ${detail}`);
    console.info('Attachment recovery could not finish; local records were retained:', error);
    return false;
  }).finally(() => { pending.delete(key); });
  pending.set(key, operation);
  return operation;
}
