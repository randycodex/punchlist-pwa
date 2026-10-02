import { validateProjectIdentity } from '@/lib/projectPayload';
import { repairDuplicateCheckpointIdentities } from '@/lib/checkpointIdentityRepair';
import { acknowledgePublishedSharedProject } from '@/lib/db';
import {
  getAllProjects,
  getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject,
  getProject,
  getProjectMetadata,
  captureLocalProjectSaveToken,
  saveDownloadedProjectIfUnchanged,
} from '@/lib/db';
import {
  getSharedProjectSnapshotMetadata,
  getCollaborationErrorMessage,
  hasNewerLocalChangesThanSharedSnapshot,
  isSharedSnapshotNewer,
  publishSharedProjectSnapshot,
  releaseAllMySharedProjectAreaClaims,
} from '@/lib/collaboration';
import { getPendingSharedPullState, type PendingSharedPullState } from '@/features/collaboration/manualSharedPull';
import { pushQueuedSharedChanges } from '@/features/collaboration/pushQueuedSharedChanges';
import { isCollaborationCapacityError } from '@/lib/collaboration/request';

export type SharedProjectSyncResult =
  | { status: 'synced'; releasedAreaCount: number; sharedUpdatesAvailable?: boolean }
  | { status: 'review'; pull: PendingSharedPullState }
  | { status: 'pending'; message: string };

/** Syncs one linked project. Other local projects and their queues are never touched. */
export async function syncSharedProject(
  localProjectId: string,
  userId: string,
  options: { localCopiesAlreadyChecked?: boolean } = {}
): Promise<SharedProjectSyncResult> {
  let stage = 'checking saved work';
  try {
    return await syncSharedProjectOnce(localProjectId, userId, options, (value) => { stage = value; });
  } catch (error) {
    if (isCollaborationCapacityError(error)) {
      return {
        status: 'pending',
        message: `Sync paused while ${stage}: the team service rejected a connection. Your local changes remain saved. Any locks not yet released are still held.`,
      };
    }
    throw new Error(`Could not finish sync while ${stage}. ${getCollaborationErrorMessage(error)}`, { cause: error });
  }
}

async function syncSharedProjectOnce(
  localProjectId: string,
  userId: string,
  options: { localCopiesAlreadyChecked?: boolean },
  setStage: (stage: string) => void
): Promise<SharedProjectSyncResult> {
  const sourceToken = await captureLocalProjectSaveToken(localProjectId);
  let project = await getProjectMetadata(localProjectId);
  if (!project?.sharedProjectId) throw new Error('This project is not linked to team data.');
  const sharedProjectId = project.sharedProjectId;
  if (repairDuplicateCheckpointIdentities(project).changed) {
    // Identity repairs need the original media records; ordinary sync reads
    // metadata and hydrates photos only for the areas actually being sent.
    project = await getProject(localProjectId);
    if (!project || project.sharedProjectId !== sharedProjectId) {
      return { status: 'pending', message: 'The local project or team link changed during sync. No area locks were released.' };
    }
    repairDuplicateCheckpointIdentities(project);
    validateProjectIdentity(project);
    if (!await saveDownloadedProjectIfUnchanged(project, sourceToken)) {
      return { status: 'pending', message: 'Local work changed while repairing checkpoint identities. Your latest work was kept. Sync again when editing has stopped.' };
    }
    return syncSharedProjectOnce(localProjectId, userId, options, setStage);
  }

  if (!options.localCopiesAlreadyChecked) {
    const activeCopies = (await getAllProjects()).filter((candidate) =>
      !candidate.deletedAt && candidate.sharedProjectId === sharedProjectId
    );
    if (activeCopies.length > 1) {
      return { status: 'pending', message: `This team project has ${activeCopies.length} copies on this device. Compare and merge them before syncing; its areas stayed locked.` };
    }
  }

  setStage('checking for team updates');
  const metadata = await getSharedProjectSnapshotMetadata(sharedProjectId);
  const sharedUpdatesAvailableAtStart = Boolean(metadata && isSharedSnapshotNewer(project, metadata.publishedAt));

  // The versioned area and metadata writes detect conflicts in the edits being
  // sent. Updates elsewhere in a large project must not require downloading
  // every area and photo before this device can send and release its own areas.
  // A new project still needs the full publish/pull baseline checks.
  if (!project.sharedSnapshotPublishedAt) {
    project = await getProject(localProjectId);
    if (!project || project.sharedProjectId !== sharedProjectId) {
      return { status: 'pending', message: 'The local project or team link changed during sync. No area locks were released.' };
    }
    if (metadata && sharedUpdatesAvailableAtStart) {
      setStage('downloading team updates and photos');
      const pull = await getPendingSharedPullState(project, 'manual-pull');
      const pendingAreas = await getPendingSharedAreaSyncsForProject(localProjectId);
      if (pendingAreas.length > 0 || pull.hasNewerLocalChanges || pull.preservedLocalAreaCount > 0 || pull.preservedLocalProjectMetadata) {
        return { status: 'review', pull };
      }
      if (!await saveDownloadedProjectIfUnchanged(pull.resolutionProject, sourceToken)) {
        return { status: 'pending', message: 'Local work changed while team updates were downloading. Your current copy was kept. Sync this project again to review the latest changes.' };
      }
      project = pull.resolutionProject;
    }
  }

  setStage('sending saved changes and photos');
  if (!project.sharedSnapshotPublishedAt) {
    await publishSharedProjectSnapshot(project, userId);
    await acknowledgePublishedSharedProject(project);
  } else {
    const pushed = await pushQueuedSharedChanges(localProjectId);
    if (pushed.remainingAreaCount > 0 || pushed.metadataRemaining) {
      if (pushed.lockedAreaIds?.length) {
        const names = pushed.lockedAreaIds.map((id) => project!.areas.find((area) => area.id === id)?.name ?? id);
        return { status: 'pending', message: `These areas are held on another device: ${names.join(', ')}. Your work is saved here. Sync and release them on that device, then try again here.` };
      }
      if (pushed.conflictedAreaCount > 0 || pushed.metadataConflicted) {
        setStage('loading conflicting team changes for review');
        const currentProject = await getProject(localProjectId);
        if (!currentProject || currentProject.sharedProjectId !== sharedProjectId) {
          return { status: 'pending', message: 'The local project or team link changed during sync. No area locks were released.' };
        }
        return { status: 'review', pull: await getPendingSharedPullState(currentProject, 'publish-conflict') };
      }
      return { status: 'pending', message: 'This project still has team changes waiting to send. Its areas stayed locked.' };
    }
  }

  const verifiedProject = await getProjectMetadata(localProjectId);
  if (!verifiedProject || verifiedProject.deletedAt || verifiedProject.sharedProjectId !== sharedProjectId) {
    return { status: 'pending', message: 'The local project or team link changed during sync. No area locks were released.' };
  }
  const [remainingAreas, remainingMetadata] = await Promise.all([
    getPendingSharedAreaSyncsForProject(localProjectId),
    getPendingSharedProjectMetadataSyncForProject(localProjectId),
  ]);
  if (remainingAreas.length || remainingMetadata) {
    return { status: 'pending', message: 'New local changes arrived during sync. Sync this project again to send them before releasing its areas.' };
  }
  setStage('confirming the saved team copy');
  const latestMetadata = await getSharedProjectSnapshotMetadata(sharedProjectId);
  if (!latestMetadata) {
    return { status: 'pending', message: 'Could not verify the team copy after sending. Its areas stayed locked; sync this project again.' };
  }
  if (verifiedProject && latestMetadata && hasNewerLocalChangesThanSharedSnapshot(verifiedProject, latestMetadata.publishedAt)) {
    return { status: 'pending', message: 'This project still has local changes to send. Its areas stayed locked.' };
  }

  setStage('releasing saved areas');
  const released = await releaseAllMySharedProjectAreaClaims(sharedProjectId, localProjectId);
  return {
    status: 'synced',
    releasedAreaCount: released.releasedCount,
    ...((sharedUpdatesAvailableAtStart || isSharedSnapshotNewer(verifiedProject, latestMetadata.publishedAt)) ? { sharedUpdatesAvailable: true } : {}),
  };
}
