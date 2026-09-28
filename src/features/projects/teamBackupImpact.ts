import { getAreaStats, type Project } from '@/types';
import { compareProjectCopies } from './compareProjectCopies';

type ProjectTotals = { areas: number; issues: number; photos: number; files: number };

export type TeamBackupImpact = {
  device: ProjectTotals;
  backup: ProjectTotals;
  deviceOnlyAreas: string[];
  backupOnlyAreas: string[];
  changedAreas: string[];
  changedCheckpoints: number;
  deviceOnlyCheckpoints: number;
  backupOnlyCheckpoints: number;
  deviceOnlyPhotos: number;
  backupOnlyPhotos: number;
  deviceOnlyFiles: number;
  backupOnlyFiles: number;
  projectDetailsChanged: boolean;
};

function activeAreas(project: Project) {
  return project.areas.filter((area) => !area.deletedAt && !area.purgedAt);
}

function totals(project: Project): ProjectTotals {
  const areas = activeAreas(project);
  let issues = 0;
  let photos = 0;
  let files = 0;
  for (const area of areas) {
    issues += getAreaStats(area).issues;
    for (const location of area.locations) {
      for (const item of location.items) {
        for (const checkpoint of item.checkpoints) {
          photos += checkpoint.photos.length;
          files += checkpoint.files?.length ?? 0;
        }
      }
    }
  }
  return { areas: areas.length, issues, photos, files };
}

function contentOwners(project: Project) {
  const owners = new Map<string, string>();
  for (const area of activeAreas(project)) {
    owners.set(area.id, area.id);
    for (const location of area.locations) {
      owners.set(location.id, area.id);
      for (const item of location.items) {
        owners.set(item.id, area.id);
        for (const checkpoint of item.checkpoints) {
          owners.set(checkpoint.id, area.id);
          for (const photo of checkpoint.photos) owners.set(photo.id, area.id);
          for (const file of checkpoint.files ?? []) owners.set(file.id, area.id);
        }
      }
    }
  }
  return owners;
}

function projectDetails(project: Project) {
  return JSON.stringify([
    project.projectName, project.address, project.inspector, project.gcName, project.gcSignoff,
    project.facadeLevelStart, project.facadeLevelEnd, project.unitFloorNumbering,
    project.checkpointRules,
    project.facadeElevationDrawings?.map(({ id, name, orientation, fileName }) => [id, name, orientation, fileName]),
  ]);
}

export function summarizeTeamBackupImpact(device: Project, backup: Project): TeamBackupImpact {
  const difference = compareProjectCopies(device, backup);
  const deviceAreas = new Map(activeAreas(device).map((area) => [area.id, area]));
  const backupAreas = new Map(activeAreas(backup).map((area) => [area.id, area]));
  const deviceOwners = contentOwners(device);
  const backupOwners = contentOwners(backup);
  const changedAreaIds = new Set(difference.differingAreaIds);
  const nestedDifferenceIds = [
    ...difference.firstOnlyLocationIds, ...difference.secondOnlyLocationIds, ...difference.differingLocationIds,
    ...difference.firstOnlyItemIds, ...difference.secondOnlyItemIds, ...difference.differingItemIds,
    ...difference.firstOnlyCheckpointIds, ...difference.secondOnlyCheckpointIds, ...difference.differingCheckpointIds,
    ...difference.firstOnlyPhotoIds, ...difference.secondOnlyPhotoIds,
    ...difference.firstOnlyFileIds, ...difference.secondOnlyFileIds,
  ];
  for (const id of nestedDifferenceIds) {
    const areaId = deviceOwners.get(id) ?? backupOwners.get(id);
    if (areaId && deviceAreas.has(areaId) && backupAreas.has(areaId)) changedAreaIds.add(areaId);
  }
  for (const [id, area] of deviceAreas) {
    if (backupAreas.has(id) && area.sortOrder !== backupAreas.get(id)?.sortOrder) changedAreaIds.add(id);
  }

  return {
    device: totals(device),
    backup: totals(backup),
    deviceOnlyAreas: difference.firstOnlyAreaIds.map((id) => deviceAreas.get(id)?.name ?? 'Unnamed area'),
    backupOnlyAreas: difference.secondOnlyAreaIds.map((id) => backupAreas.get(id)?.name ?? 'Unnamed area'),
    changedAreas: [...changedAreaIds].map((id) => deviceAreas.get(id)?.name ?? backupAreas.get(id)?.name ?? 'Unnamed area'),
    changedCheckpoints: difference.differingCheckpointIds.length,
    deviceOnlyCheckpoints: difference.firstOnlyCheckpointIds.length,
    backupOnlyCheckpoints: difference.secondOnlyCheckpointIds.length,
    deviceOnlyPhotos: difference.firstOnlyPhotoIds.length,
    backupOnlyPhotos: difference.secondOnlyPhotoIds.length,
    deviceOnlyFiles: difference.firstOnlyFileIds.length,
    backupOnlyFiles: difference.secondOnlyFileIds.length,
    projectDetailsChanged: projectDetails(device) !== projectDetails(backup),
  };
}

function namesPreview(names: string[]) {
  return `${names.slice(0, 4).join(', ')}${names.length > 4 ? `, +${names.length - 4} more` : ''}`;
}

export function formatTeamBackupImpact(impact: TeamBackupImpact): string[] {
  const lines = [
    `Backup contains ${impact.backup.areas} areas, ${impact.backup.issues} issues, ${impact.backup.photos} photos, and ${impact.backup.files} files.`,
    `This device has ${impact.device.areas} areas, ${impact.device.issues} issues, ${impact.device.photos} photos, and ${impact.device.files} files.`,
  ];
  if (impact.deviceOnlyAreas.length) lines.push(`${impact.deviceOnlyAreas.length} area(s) only on this device would be removed: ${namesPreview(impact.deviceOnlyAreas)}.`);
  if (impact.backupOnlyAreas.length) lines.push(`${impact.backupOnlyAreas.length} area(s) from the backup would be added: ${namesPreview(impact.backupOnlyAreas)}.`);
  if (impact.changedAreas.length) lines.push(`${impact.changedAreas.length} existing area(s) have differences: ${namesPreview(impact.changedAreas)}.`);
  if (impact.changedCheckpoints || impact.deviceOnlyCheckpoints || impact.backupOnlyCheckpoints) {
    lines.push(`Checkpoints: ${impact.changedCheckpoints} changed, ${impact.deviceOnlyCheckpoints} only on this device, ${impact.backupOnlyCheckpoints} only in the backup.`);
  }
  if (impact.deviceOnlyPhotos || impact.backupOnlyPhotos || impact.deviceOnlyFiles || impact.backupOnlyFiles) {
    lines.push(`Attachments: ${impact.deviceOnlyPhotos} photos and ${impact.deviceOnlyFiles} files only on this device; ${impact.backupOnlyPhotos} photos and ${impact.backupOnlyFiles} files only in the backup.`);
  }
  if (impact.projectDetailsChanged) lines.push('Project details or settings differ.');
  if (lines.length === 2 && impact.device.areas === impact.backup.areas && impact.device.issues === impact.backup.issues
    && impact.device.photos === impact.backup.photos && impact.device.files === impact.backup.files) {
    lines.push('Counts match; other details may still differ.');
  }
  return lines;
}
