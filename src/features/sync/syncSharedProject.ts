import {
  getAllProjects,
  getPendingSharedAreaSyncsForProject,
  getProject,
  saveProjectMetadataOnly,
  saveProjectPreserveTimestamps,
} from '@/lib/db';
import {
  getSharedProjectSnapshotMetadata,
  hasNewerLocalChangesThanSharedSnapshot,
  isSharedSnapshotNewer,
  publishSharedProjectSnapshot,
  releaseAllMySharedProjectAreaClaims,
} from '@/lib/collaboration';
import { getPendingSharedPullState, type PendingSharedPullState } from '@/features/collaboration/manualSharedPull';
import { pushQueuedSharedChanges } from '@/features/collaboration/pushQueuedSharedChanges';
import { isCollaborationCapacityError } from '@/lib/collaboration/request';

export type SharedProjectSyncResult =
  | { status: 'synced'; releasedAreaCount: number }
  | { status: 'review'; pull: PendingSharedPullState }
  | { status: 'pending'; message: string };

/** Syncs one linked project. Other local projects and their queues are never touched. */
export async function syncSharedProject(
  localProjectId: string,
  userId: string,
  options: { localCopiesAlreadyChecked?: boolean } = {}
): Promise<SharedProjectSyncResult> {
  try {
    return await syncSharedProjectOnce(localProjectId, userId, options);
  } catch (error) {
    if (!isCollaborationCapacityError(error)) throw error;
    return {
      status: 'pending',
      message: 'The team service is busy. Your changes remain saved on this device. Sync This Project again in a minute to finish sending and release any remaining area locks.',
    };
  }
}

async function syncSharedProjectOnce(
  localProjectId: string,
  userId: string,
  options: { localCopiesAlreadyChecked?: boolean }
): Promise<SharedProjectSyncResult> {
  let project = await getProject(localProjectId);
  if (!project?.sharedProjectId) throw new Error('This project is not linked to team data.');
  const sharedProjectId = project.sharedProjectId;
  if (!options.localCopiesAlreadyChecked) {
    const activeCopies = (await getAllProjects()).filter((candidate) =>
      !candidate.deletedAt && candidate.sharedProjectId === sharedProjectId
    );
    if (activeCopies.length > 1) {
      return { status: 'pending', message: `This team project has ${activeCopies.length} copies on this device. Compare and merge them before syncing; its areas stayed locked.` };
    }
  }

  const metadata = await getSharedProjectSnapshotMetadata(sharedProjectId);
  if (metadata && isSharedSnapshotNewer(project, metadata.publishedAt)) {
    const pull = await getPendingSharedPullState(project, 'manual-pull');
    const pendingAreas = await getPendingSharedAreaSyncsForProject(localProjectId);
    if (pendingAreas.length > 0 || pull.hasNewerLocalChanges || pull.preservedLocalAreaCount > 0 || pull.preservedLocalProjectMetadata) {
      return { status: 'review', pull };
    }
    await saveProjectPreserveTimestamps(pull.resolutionProject);
    project = pull.resolutionProject;
  }

  if (!project.sharedSnapshotPublishedAt) {
    await publishSharedProjectSnapshot(project, userId);
    await saveProjectMetadataOnly(project, { touch: false });
  } else {
    const pushed = await pushQueuedSharedChanges(localProjectId);
    if (pushed.remainingAreaCount > 0 || pushed.metadataRemaining) {
      if (pushed.conflictedAreaCount > 0 || pushed.metadataConflicted) {
        return { status: 'review', pull: await getPendingSharedPullState(project, 'publish-conflict') };
      }
      return { status: 'pending', message: 'This project still has team changes waiting to send. Its areas stayed locked.' };
    }
  }

  const verifiedProject = await getProject(localProjectId);
  const latestMetadata = await getSharedProjectSnapshotMetadata(sharedProjectId);
  if (!latestMetadata) {
    return { status: 'pending', message: 'Could not verify the team copy after sending. Its areas stayed locked; sync this project again.' };
  }
  if (verifiedProject && latestMetadata && isSharedSnapshotNewer(verifiedProject, latestMetadata.publishedAt)) {
    return { status: 'pending', message: 'A newer team update arrived. Areas stayed locked; sync this project again to review it.' };
  }
  if (verifiedProject && latestMetadata && hasNewerLocalChangesThanSharedSnapshot(verifiedProject, latestMetadata.publishedAt)) {
    return { status: 'pending', message: 'This project still has local changes to send. Its areas stayed locked.' };
  }

  const released = await releaseAllMySharedProjectAreaClaims(sharedProjectId);
  return { status: 'synced', releasedAreaCount: released.releasedCount };
}
