type Recover = (projectId: string, areaId?: string) => Promise<boolean>;
let recovery: Recover | undefined;
const pending = new Map<string, Promise<boolean>>();

/** The signed-in app registers account-bound recovery; database reads never sign in. */
export function registerLocalMediaRecovery(handler: Recover) {
  recovery = handler;
  return () => { if (recovery === handler) recovery = undefined; };
}

export async function tryLocalMediaRecovery(projectId: string, areaId?: string) {
  if (!recovery || (typeof navigator !== 'undefined' && navigator.onLine === false)) return false;
  const key = `${projectId}:${areaId ?? '*'}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = recovery(projectId, areaId).catch((error) => {
    console.info('Attachment recovery could not finish; local records were retained:', error);
    return false;
  }).finally(() => { pending.delete(key); });
  pending.set(key, operation);
  return operation;
}
