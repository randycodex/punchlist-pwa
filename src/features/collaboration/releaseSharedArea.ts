import {
  getPendingSharedAreaSyncsForProject,
  getProjectMetadata,
  resumeReviewedPendingSharedAreaSyncs,
} from '@/lib/db';
import { releaseSharedProjectArea } from '@/lib/collaboration/areaClaims';
import { flushPendingSharedAreaSyncs } from '@/lib/collaboration/sharedAreaSyncQueue';
import { getCollaborationErrorMessage } from '@/lib/collaboration/sharedProjects';

/** An explicit release sends only this area's reviewed work before releasing its lock. */
export async function releaseSharedArea({ localProjectId, sharedProjectId, areaId }: {
  localProjectId: string;
  sharedProjectId: string;
  areaId: string;
}) {
  const project = await getProjectMetadata(localProjectId);
  if (!project || project.deletedAt || project.sharedProjectId !== sharedProjectId
    || !project.areas.some((area) => area.id === areaId)) {
    throw new Error('The local area or team link changed. Reopen this area before releasing it.');
  }
  await resumeReviewedPendingSharedAreaSyncs(localProjectId, areaId);
  await flushPendingSharedAreaSyncs(localProjectId, areaId);
  const remaining = (await getPendingSharedAreaSyncsForProject(localProjectId))
    .find((record) => record.areaId === areaId);
  if (remaining) {
    const fallback = typeof navigator !== 'undefined' && navigator.onLine === false
      ? 'The device is offline. Your work is saved here; try again when connected.'
      : 'Its changes are still waiting to reach the team. Please try again.';
    const detail = remaining.lastError
      ? getCollaborationErrorMessage({ message: remaining.lastError, code: remaining.lastErrorCode }, fallback)
      : fallback;
    throw new Error(`This area stayed locked. ${detail}`);
  }
  // This rechecks retained drafts, the durable queue, device ownership and the
  // confirmed area version while holding the local persistence lock.
  await releaseSharedProjectArea(sharedProjectId, areaId, localProjectId);
}
