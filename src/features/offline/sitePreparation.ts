import type { Project } from '@/types';

export const offlineBuild = process.env.NEXT_PUBLIC_OFFLINE_BUILD_ID ?? 'development';
export const isOfflinePage = (path: string) => path === '/' || /^\/project\/[a-zA-Z0-9-]+(?:\/area\/[a-zA-Z0-9-]+)?$/.test(path);
let registrationPromise: Promise<ServiceWorkerRegistration> | undefined;

export function registerInspectionWorker() {
  if (offlineBuild === 'development') return Promise.reject(new Error('Offline preparation is available in the production preview.'));
  if (!('serviceWorker' in navigator)) return Promise.reject(new Error('This browser does not support offline preparation.'));
  registrationPromise ??= navigator.serviceWorker.getRegistration('/').then((existing) => {
    if (existing?.active?.scriptURL === new URL('/inspection-sw.js', location.origin).href) {
      if (navigator.onLine) void existing.update().catch(() => {});
      return existing;
    }
    return navigator.serviceWorker.register('/inspection-sw.js', { scope: '/', updateViaCache: 'none' });
  }).catch((error) => {
    registrationPromise = undefined;
    throw error;
  });
  return registrationPromise;
}

export async function checkPreparedPages(paths: string[], prepare = false) {
  const registration = await registerInspectionWorker();
  const ready = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Offline installation is still pending. Stay online and retry.')), 60000)),
  ]);
  if (registration.waiting) throw new Error('An app update is waiting. Finish saving, close all app tabs, reopen online, and prepare again.');
  const worker = ready.active;
  if (!worker) throw new Error('Offline preparation is not installed yet.');
  return new Promise<{ ready: boolean; build: string; missing: string[] }>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Preparation timed out. Reconnect and retry.')); }, 180000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer); channel.port1.close();
      if (data.error) reject(new Error(data.error));
      else if (data.build !== offlineBuild) reject(new Error('The offline copy belongs to an earlier app version. Close all app tabs and reopen online.'));
      else resolve(data);
    };
    worker.postMessage({ type: prepare ? 'PREPARE' : 'CHECK', paths }, [channel.port2]);
  });
}

export function inspectOfflineProject(project: Project) {
  const areas = project.areas.filter((area) => !area.deletedAt);
  const checkpoints = areas.flatMap((area) => area.locations.flatMap((location) => location.items.flatMap((item) => item.checkpoints)));
  const missingMedia = checkpoints.reduce((count, checkpoint) => count
    + checkpoint.photos.filter((photo) => !photo.imageData?.startsWith('data:')).length
    + (checkpoint.files ?? []).filter((file) => !file.data?.startsWith('data:')).length, 0)
    + (project.facadeElevationDrawings ?? []).filter((drawing) => !drawing.dataUrl?.startsWith('data:')).length;
  return {
    paths: ['/', `/project/${project.id}`, ...areas.map((area) => `/project/${project.id}/area/${area.id}`)],
    missingMedia,
    areaCount: areas.length,
    shared: Boolean(project.sharedProjectId),
  };
}
