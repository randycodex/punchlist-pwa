import { getSharedProjectSnapshot, hasNewerLocalChangesThanSharedSnapshot } from '@/lib/collaboration';
import type { Area, Project } from '@/types';

export type PendingSharedPullReason = 'manual-pull' | 'publish-conflict' | 'area-create-conflict';

export type PendingSharedPullState = {
  localProject: Project;
  sharedProject: Project;
  resolutionProject: Project;
  publishedAt: string;
  hasNewerLocalChanges: boolean;
  conflictingAreaNames: string[];
  preservedLocalAreaCount: number;
  appliedRemoteAreaCount: number;
  reason: PendingSharedPullReason;
};

const CLOCK_SKEW_MS = 2_000;

function entityChangedAt(entity: Pick<Area, 'updatedAt' | 'deletedAt'>) {
  return Math.max(
    new Date(entity.updatedAt).getTime(),
    entity.deletedAt ? new Date(entity.deletedAt).getTime() : 0
  );
}

function changedAfter(area: Area, baselineMs: number) {
  return entityChangedAt(area) > baselineMs + CLOCK_SKEW_MS;
}

function maxDate(left: Date, right: Date) {
  return new Date(Math.max(new Date(left).getTime(), new Date(right).getTime()));
}

export function mergeSharedProjectAreas(
  localProject: Project,
  sharedProject: Project
): Pick<PendingSharedPullState, 'resolutionProject' | 'conflictingAreaNames' | 'preservedLocalAreaCount' | 'appliedRemoteAreaCount'> {
  const baselineMs = localProject.sharedSnapshotPublishedAt
    ? new Date(localProject.sharedSnapshotPublishedAt).getTime()
    : 0;
  const localById = new Map(localProject.areas.map((area) => [area.id, area]));
  const remoteById = new Map(sharedProject.areas.map((area) => [area.id, area]));
  const orderedAreaIds = [
    ...sharedProject.areas.map((area) => area.id),
    ...localProject.areas.map((area) => area.id).filter((id) => !remoteById.has(id)),
  ];
  const conflictingAreaNames: string[] = [];
  let preservedLocalAreaCount = 0;
  let appliedRemoteAreaCount = 0;

  const areas = orderedAreaIds.map((areaId) => {
    const localArea = localById.get(areaId);
    const remoteArea = remoteById.get(areaId);
    if (!localArea) {
      appliedRemoteAreaCount += 1;
      return remoteArea!;
    }
    if (!remoteArea) {
      preservedLocalAreaCount += 1;
      return localArea;
    }

    const localChanged = changedAfter(localArea, baselineMs);
    const remoteChanged = changedAfter(remoteArea, baselineMs);
    if (localChanged && remoteChanged) {
      conflictingAreaNames.push(localArea.name || remoteArea.name);
      preservedLocalAreaCount += 1;
      return localArea;
    }
    if (localChanged) {
      preservedLocalAreaCount += 1;
      return localArea;
    }

    appliedRemoteAreaCount += 1;
    return remoteArea;
  });

  return {
    resolutionProject: {
      ...sharedProject,
      id: localProject.id,
      oneDriveFolderName: localProject.oneDriveFolderName || sharedProject.oneDriveFolderName,
      sharedProjectId: localProject.sharedProjectId,
      sharedProjectLinkedAt: localProject.sharedProjectLinkedAt,
      sharedSnapshotPublishedAt: sharedProject.sharedSnapshotPublishedAt,
      updatedAt: maxDate(localProject.updatedAt, sharedProject.updatedAt),
      areas,
    },
    conflictingAreaNames: [...new Set(conflictingAreaNames)],
    preservedLocalAreaCount,
    appliedRemoteAreaCount,
  };
}

export async function getPendingSharedPullState(
  localProject: Project,
  reason: PendingSharedPullReason
): Promise<PendingSharedPullState> {
  const result = await getSharedProjectSnapshot(localProject);
  const merge = mergeSharedProjectAreas(localProject, result.project);
  return {
    localProject,
    sharedProject: result.project,
    ...merge,
    publishedAt: result.publishedAt,
    hasNewerLocalChanges: hasNewerLocalChangesThanSharedSnapshot(localProject, result.publishedAt),
    reason,
  };
}

export function formatPendingSharedPullMessage(pendingPull: PendingSharedPullState) {
  const sourceTime = new Date(pendingPull.publishedAt).toLocaleString();
  const mergeSummary = `The app will save a local backup, keep ${pendingPull.preservedLocalAreaCount} locally changed area${pendingPull.preservedLocalAreaCount === 1 ? '' : 's'}, and apply ${pendingPull.appliedRemoteAreaCount} team area${pendingPull.appliedRemoteAreaCount === 1 ? '' : 's'}.`;
  const conflictSummary = pendingPull.conflictingAreaNames.length > 0
    ? `\n\nChanged on both sides and kept local: ${pendingPull.conflictingAreaNames.join(', ')}. Review these areas before publishing.`
    : '';

  if (pendingPull.reason === 'publish-conflict') {
    return `Publishing now would overwrite newer team data from ${sourceTime}.\n\n${mergeSummary}${conflictSummary}`;
  }
  if (pendingPull.reason === 'area-create-conflict') {
    return `Team data changed before this area could be added.\n\n${mergeSummary}${conflictSummary}`;
  }
  return `Team data from ${sourceTime} is ready.\n\n${mergeSummary}${conflictSummary}`;
}
