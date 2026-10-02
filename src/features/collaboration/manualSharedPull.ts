import { mergeCheckpointRules } from '@/lib/checkpointRules';
import { getSharedProjectSnapshot, hasNewerLocalChangesThanSharedSnapshot } from '@/lib/collaboration';
import {
  completePendingSharedAreaSync,
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

    if (localArea.purgedAt && remoteArea.purgedAt
      && new Date(localArea.purgedAt).getTime() === new Date(remoteArea.purgedAt).getTime()
      && localArea.locations.length === 0 && remoteArea.locations.length === 0) {
      appliedRemoteAreaCount += 1;
      return remoteArea;
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
  for (const record of pendingAreas) {
    const remote = sharedProject.areas.find((area) => area.id === record.areaId);
    const local = localProject.areas.find((area) => area.id === record.areaId);
    if (remote?.purgedAt && local?.purgedAt && remote.sharedVersion && remote.sharedPublishedAt
      && new Date(remote.purgedAt).getTime() === new Date(local.purgedAt).getTime()
      && remote.locations.length === 0 && local.locations.length === 0) {
      await completePendingSharedAreaSync({ key: record.key, clientId: record.clientId, revision: record.revision,
        areaVersion: remote.sharedVersion, publishedAt: new Date(remote.sharedPublishedAt).toISOString(),
        confirmedPurgedAt: new Date(remote.purgedAt).toISOString() });
    }
  }
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
  const projectName = pendingPull.localProject.projectName || 'This project';
  const areaNames = pendingPull.localProject.areas
    .filter((area) => pendingPull.preservedLocalAreaIds.includes(area.id))
    .map((area) => `${area.name}${area.purgedAt || area.deletedAt ? ' (pending deletion)' : ''}`);
  const namedAreas = areaNames.slice(0, 5).join(', ')
    + (areaNames.length > 5 ? `, and ${areaNames.length - 5} more` : '');
  const parts = [`${projectName}: team updates are ready.`];
  const changes: string[] = [];
  if (namedAreas) changes.push(`Your work will stay in: ${namedAreas}.`);
  if (pendingPull.appliedRemoteAreaCount > 0) {
    changes.push(`Load team updates for ${namedAreas ? 'the other ' : ''}${pendingPull.appliedRemoteAreaCount} area${pendingPull.appliedRemoteAreaCount === 1 ? '' : 's'}.`);
  }
  if (pendingPull.preservedLocalProjectMetadata) changes.push('Your edited project details will stay.');
  if (changes.length) parts.push(changes.join('\n'));
  if (pendingPull.conflictingAreaNames.length > 0) {
    const names = pendingPull.conflictingAreaNames.slice(0, 5).join(', ')
      + (pendingPull.conflictingAreaNames.length > 5 ? `, and ${pendingPull.conflictingAreaNames.length - 5} more` : '');
    parts.push(`Review: ${names}. Both versions changed; your complete versions will be kept. Team room and item edits in these areas are not combined.`);
  }
  parts.push('Your current copy is saved first. Sync afterward to send your work and release your areas.');
  return parts.join('\n\n');
}

export function formatPendingSharedPullSuccessMessage(pendingPull: PendingSharedPullState) {
  if (pendingPull.conflictingAreaNames.length > 0) {
    return `Team updates loaded. Your versions of ${pendingPull.conflictingAreaNames.slice(0, 5).join(', ')}${pendingPull.conflictingAreaNames.length > 5 ? `, and ${pendingPull.conflictingAreaNames.length - 5} more` : ''} were kept. Review those areas, then tap Sync This Team Project to send your work and release your locks.`;
  }
  if (pendingPull.preservedLocalAreaCount > 0 || pendingPull.preservedLocalProjectMetadata) {
    return 'Team updates loaded. Your local work was kept. Tap Sync This Team Project to send it and release your locks.';
  }
  return 'Team updates loaded.';
}
