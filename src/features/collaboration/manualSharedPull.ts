import { getSharedProjectSnapshot, hasNewerLocalChangesThanSharedSnapshot } from '@/lib/collaboration';
import { getPendingSharedProjectMetadataSyncForProject } from '@/lib/db';
import type { Area, Project } from '@/types';

export type PendingSharedPullReason = 'manual-pull' | 'publish-conflict';

export type PendingSharedPullState = {
  localProject: Project;
  sharedProject: Project;
  resolutionProject: Project;
  publishedAt: string;
  hasNewerLocalChanges: boolean;
  conflictingAreaNames: string[];
  preservedLocalAreaCount: number;
  preservedLocalProjectMetadata: boolean;
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

function preserveLocalAreaWithRemoteRevision(localArea: Area, remoteArea: Area) {
  return {
    ...localArea,
    sharedVersion: remoteArea.sharedVersion,
    sharedPublishedAt: remoteArea.sharedPublishedAt,
  };
}

export function mergeSharedProjectAreas(
  localProject: Project,
  sharedProject: Project,
  options: { preserveLocalProjectMetadata?: boolean } = {}
): Pick<PendingSharedPullState, 'resolutionProject' | 'conflictingAreaNames' | 'preservedLocalAreaCount' | 'appliedRemoteAreaCount' | 'preservedLocalProjectMetadata'> {
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
      return preserveLocalAreaWithRemoteRevision(localArea, remoteArea);
    }
    if (localChanged) {
      preservedLocalAreaCount += 1;
      return preserveLocalAreaWithRemoteRevision(localArea, remoteArea);
    }

    appliedRemoteAreaCount += 1;
    return remoteArea;
  });

  const resolutionProject: Project = {
    ...sharedProject,
    id: localProject.id,
    oneDriveFolderName: localProject.oneDriveFolderName || sharedProject.oneDriveFolderName,
    sharedProjectId: localProject.sharedProjectId,
    sharedProjectLinkedAt: localProject.sharedProjectLinkedAt,
    sharedSnapshotPublishedAt: sharedProject.sharedSnapshotPublishedAt,
    sharedBaselinePublishedAt: sharedProject.sharedBaselinePublishedAt,
    updatedAt: maxDate(localProject.updatedAt, sharedProject.updatedAt),
    areas,
  };
  if (options.preserveLocalProjectMetadata) {
    Object.assign(resolutionProject, {
      projectName: localProject.projectName,
      address: localProject.address,
      date: localProject.date,
      inspector: localProject.inspector,
      gcName: localProject.gcName,
      gcSignoff: localProject.gcSignoff,
      facadeLevelStart: localProject.facadeLevelStart,
      facadeLevelEnd: localProject.facadeLevelEnd,
      sharedMetadataVersion: sharedProject.sharedMetadataVersion,
      sharedMetadataPublishedAt: sharedProject.sharedMetadataPublishedAt,
    });
  }

  return {
    resolutionProject,
    conflictingAreaNames: [...new Set(conflictingAreaNames)],
    preservedLocalAreaCount,
    appliedRemoteAreaCount,
    preservedLocalProjectMetadata: options.preserveLocalProjectMetadata ?? false,
  };
}

export async function mergeSharedProjectAreasWithPendingMetadata(
  localProject: Project,
  sharedProject: Project
) {
  const pendingMetadata = await getPendingSharedProjectMetadataSyncForProject(localProject.id);
  return mergeSharedProjectAreas(localProject, sharedProject, {
    preserveLocalProjectMetadata: Boolean(pendingMetadata),
  });
}

export async function getPendingSharedPullState(
  localProject: Project,
  reason: PendingSharedPullReason
): Promise<PendingSharedPullState> {
  const result = await getSharedProjectSnapshot(localProject);
  const merge = await mergeSharedProjectAreasWithPendingMetadata(localProject, result.project);
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
  const metadataSummary = pendingPull.preservedLocalProjectMetadata
    ? '\n\nYour locally edited project details will also be kept and synced against the latest team version.'
    : '';
  const conflictSummary = pendingPull.conflictingAreaNames.length > 0
    ? `\n\nChanged on both sides and kept local: ${pendingPull.conflictingAreaNames.join(', ')}. Review these areas before publishing.`
    : '';

  if (pendingPull.reason === 'publish-conflict') {
    return `Publishing now would overwrite newer team data from ${sourceTime}.\n\n${mergeSummary}${metadataSummary}${conflictSummary}`;
  }
  return `Team data from ${sourceTime} is ready.\n\n${mergeSummary}${metadataSummary}${conflictSummary}`;
}

export function formatPendingSharedPullSuccessMessage(pendingPull: PendingSharedPullState) {
  const preserved: string[] = [];
  if (pendingPull.conflictingAreaNames.length > 0) {
    const count = pendingPull.conflictingAreaNames.length;
    preserved.push(`${count} area${count === 1 ? '' : 's'} changed on both sides and kept the local version.`);
  }
  if (pendingPull.preservedLocalProjectMetadata) {
    preserved.push('Local project details were also kept and requeued.');
  }
  return preserved.length > 0
    ? `Team data merged. ${preserved.join(' ')}`
    : `Team data merged from ${new Date(pendingPull.publishedAt).toLocaleString()}.`;
}
