import { mergeCheckpointRules } from '@/lib/checkpointRules';
import { getSharedProjectSnapshot, hasNewerLocalChangesThanSharedSnapshot } from '@/lib/collaboration';
import {
  getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject,
} from '@/lib/db';
import type { Area, Project } from '@/types';

export type PendingSharedPullReason = 'manual-pull' | 'publish-conflict';

export type PendingSharedPullState = {
  localProject: Project;
  sharedProject: Project;
  resolutionProject: Project;
  publishedAt: string;
  hasNewerLocalChanges: boolean;
  conflictingAreaNames: string[];
  preservedLocalAreaIds: string[];
  preservedLocalAreaCount: number;
  preservedLocalProjectMetadata: boolean;
  appliedRemoteAreaCount: number;
  reason: PendingSharedPullReason;
};

const CLOCK_SKEW_MS = 2_000;

function entityChangedAt(entity: Pick<Area, 'updatedAt' | 'deletedAt' | 'purgedAt'>) {
  return Math.max(
    new Date(entity.updatedAt).getTime(),
    entity.deletedAt ? new Date(entity.deletedAt).getTime() : 0,
    entity.purgedAt ? new Date(entity.purgedAt).getTime() : 0
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
  options: {
    preserveLocalProjectMetadata?: boolean;
    preserveLocalAreaIds?: Iterable<string>;
  } = {}
): Pick<PendingSharedPullState, 'resolutionProject' | 'conflictingAreaNames' | 'preservedLocalAreaIds' | 'preservedLocalAreaCount' | 'appliedRemoteAreaCount' | 'preservedLocalProjectMetadata'> {
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
  const preservedLocalAreaIds: string[] = [];
  const forcedLocalAreaIds = new Set(options.preserveLocalAreaIds ?? []);
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
      preservedLocalAreaIds.push(localArea.id);
      return localArea;
    }

    if (forcedLocalAreaIds.has(areaId)) {
      const localVersion = localArea.sharedVersion ?? 0;
      const remoteVersion = remoteArea.sharedVersion ?? 0;
      if (remoteVersion > localVersion) {
        conflictingAreaNames.push(localArea.name || remoteArea.name);
      }
      preservedLocalAreaCount += 1;
      preservedLocalAreaIds.push(localArea.id);
      return preserveLocalAreaWithRemoteRevision(localArea, remoteArea);
    }

    if (localArea.purgedAt || remoteArea.purgedAt) {
      if (!localArea.purgedAt) {
        appliedRemoteAreaCount += 1;
        return remoteArea;
      }
      if (!remoteArea.purgedAt) {
        preservedLocalAreaCount += 1;
        preservedLocalAreaIds.push(localArea.id);
        return preserveLocalAreaWithRemoteRevision(localArea, remoteArea);
      }
      if (new Date(remoteArea.purgedAt).getTime() > new Date(localArea.purgedAt).getTime()) {
        appliedRemoteAreaCount += 1;
        return remoteArea;
      }
      preservedLocalAreaCount += 1;
      preservedLocalAreaIds.push(localArea.id);
      return preserveLocalAreaWithRemoteRevision(localArea, remoteArea);
    }

    const localChanged = changedAfter(localArea, baselineMs);
    const remoteChanged = changedAfter(remoteArea, baselineMs);
    if (localChanged && remoteChanged) {
      conflictingAreaNames.push(localArea.name || remoteArea.name);
      preservedLocalAreaCount += 1;
      preservedLocalAreaIds.push(localArea.id);
      return preserveLocalAreaWithRemoteRevision(localArea, remoteArea);
    }
    if (localChanged) {
      preservedLocalAreaCount += 1;
      preservedLocalAreaIds.push(localArea.id);
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
      checkpointRules: mergeCheckpointRules(sharedProject.checkpointRules, localProject.checkpointRules),
      unitFloorNumbering: localProject.unitFloorNumbering,
      facadeLevelStart: localProject.facadeLevelStart,
      facadeLevelEnd: localProject.facadeLevelEnd,
      sharedMetadataVersion: sharedProject.sharedMetadataVersion,
      sharedMetadataPublishedAt: sharedProject.sharedMetadataPublishedAt,
    });
  }

  return {
    resolutionProject,
    conflictingAreaNames: [...new Set(conflictingAreaNames)],
    preservedLocalAreaIds: [...new Set(preservedLocalAreaIds)],
    preservedLocalAreaCount,
    appliedRemoteAreaCount,
    preservedLocalProjectMetadata: options.preserveLocalProjectMetadata ?? false,
  };
}

export async function mergeSharedProjectAreasWithPendingMetadata(
  localProject: Project,
  sharedProject: Project
) {
  const [pendingMetadata, pendingAreas] = await Promise.all([
    getPendingSharedProjectMetadataSyncForProject(localProject.id),
    getPendingSharedAreaSyncsForProject(localProject.id),
  ]);
  return mergeSharedProjectAreas(localProject, sharedProject, {
    preserveLocalProjectMetadata: Boolean(pendingMetadata),
    preserveLocalAreaIds: pendingAreas.map((record) => record.areaId),
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
  const projectName = pendingPull.localProject.projectName || 'This project';
  const preservedAreaNames = pendingPull.localProject.areas
    .filter((area) => pendingPull.preservedLocalAreaIds.includes(area.id))
    .map((area) => area.name);
  const preservedAreaSummary = preservedAreaNames.length > 0
    ? `\n\nYour local areas: ${preservedAreaNames.slice(0, 5).join(', ')}${preservedAreaNames.length > 5 ? `, and ${preservedAreaNames.length - 5} more` : ''}.`
    : '';
  const mergeSummary = `Next step: back up this device's project, keep your version of ${pendingPull.preservedLocalAreaCount} area${pendingPull.preservedLocalAreaCount === 1 ? '' : 's'}, and load the team's versions of the other ${pendingPull.appliedRemoteAreaCount} area${pendingPull.appliedRemoteAreaCount === 1 ? '' : 's'}.`;
  const metadataSummary = pendingPull.preservedLocalProjectMetadata
    ? '\n\nYour edited project name/details on this device will stay and be re-sent to the team afterward.'
    : '';
  const conflictSummary = pendingPull.conflictingAreaNames.length > 0
    ? `\n\nChanged on both sides: ${pendingPull.conflictingAreaNames.join(', ')}. Your device's complete version of each named area will be kept. Individual room and item edits from the team in those areas are not combined. Review them before syncing again; their locks stay with you until your changes are sent.`
    : '';

  if (pendingPull.reason === 'publish-conflict') {
    return `${projectName}: the team has newer work from ${sourceTime}. Get those updates before sending yours.\n\n${mergeSummary}${preservedAreaSummary}${metadataSummary}${conflictSummary}`;
  }
  return `${projectName}: team updates from ${sourceTime} are ready.\n\n${mergeSummary}${preservedAreaSummary}${metadataSummary}${conflictSummary}`;
}

export function formatPendingSharedPullSuccessMessage(pendingPull: PendingSharedPullState) {
  const preserved: string[] = [];
  if (pendingPull.conflictingAreaNames.length > 0) {
    const count = pendingPull.conflictingAreaNames.length;
    preserved.push(`${count} area${count === 1 ? '' : 's'} had changes on both sides. Your device's versions were kept; review them before sending to the team.`);
  }
  if (pendingPull.preservedLocalProjectMetadata) {
    preserved.push('Your project details on this device were kept and will re-send to the team.');
  }
  return preserved.length > 0
    ? `Team copies for the other areas were loaded. ${preserved.join(' ')} After review, tap Sync Team Projects again to send your changes and release their locks.`
    : `Team updates applied from ${new Date(pendingPull.publishedAt).toLocaleString()}.`;
}
