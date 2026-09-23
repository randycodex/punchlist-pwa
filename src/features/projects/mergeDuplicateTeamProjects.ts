import type { Project } from '@/types';
import { mergeProjects } from '@/lib/oneDriveSync';
import { compareProjectCopies, isLikelyPersonalProjectCopy } from './compareProjectCopies';

export function projectCheckpointCount(project: Project) {
  return project.areas.reduce((total, area) => total + (
    area.deletedAt || area.purgedAt ? 0 : area.locations.reduce((areaTotal, location) => areaTotal + (
      location.items.reduce((locationTotal, item) => locationTotal + item.checkpoints.length, 0)
    ), 0)
  ), 0);
}

export function mergeDuplicateTeamProjects(primary: Project, duplicates: Project[]): Project {
  if (!primary.sharedProjectId || duplicates.some((project) =>
    project.sharedProjectId !== primary.sharedProjectId
  )) {
    throw new Error('Only copies of the same team project can be merged.');
  }

  let result = primary;
  for (const duplicate of duplicates) {
    const merged = mergeProjects(result, duplicate);
    const drawings = new Map((result.facadeElevationDrawings ?? []).map((drawing) => [drawing.id, drawing]));
    for (const drawing of duplicate.facadeElevationDrawings ?? []) {
      const existing = drawings.get(drawing.id);
      if (!existing || (!existing.dataUrl && drawing.dataUrl)) drawings.set(drawing.id, drawing);
    }
    const rules = new Map((result.checkpointRules ?? []).map((rule) =>
      [`${rule.room}\u0000${rule.item}\u0000${rule.name}`, rule]
    ));
    for (const rule of duplicate.checkpointRules ?? []) {
      rules.set(`${rule.room}\u0000${rule.item}\u0000${rule.name}`, rule);
    }
    result = {
      ...result,
      updatedAt: merged.updatedAt,
      areas: merged.areas.map((area) => ({ ...area, projectId: primary.id })),
      facadeElevationDrawings: [...drawings.values()],
      checkpointRules: [...rules.values()],
    };
  }
  return result;
}

export function mergeDuplicatePersonalProjects(primary: Project, copies: Project[]): Project {
  if (primary.sharedProjectId || copies.some((copy) =>
    copy.id !== primary.id && !isLikelyPersonalProjectCopy(primary, copy)
  )) {
    throw new Error('These are not verified copies of the same personal project.');
  }

  // The usual sync merge can filter facade locations to the older copy's selected
  // facade levels. When the retained copy already contains all saved work, keep
  // it intact instead of letting that filter discard locations and checkpoints.
  const primaryContainsEveryCopy = copies.every((copy) => {
    if (copy.id === primary.id) return true;
    const comparison = compareProjectCopies(copy, primary);
    const drawings = new Map((primary.facadeElevationDrawings ?? []).map((drawing) => [drawing.id, drawing]));
    const rules = new Map((primary.checkpointRules ?? []).map((rule) =>
      [`${rule.room}\u0000${rule.item}\u0000${rule.name}`, rule]
    ));
    return !comparison.firstOnlyAreaIds.length
      && !comparison.firstOnlyCheckpointIds.length
      && !comparison.firstOnlyPhotoIds.length
      && !comparison.firstOnlyPhotoDataIds.length
      && !comparison.firstOnlyFileIds.length
      && !comparison.firstOnlyFileDataIds.length
      && !comparison.differingCheckpointIds.length
      && (copy.facadeElevationDrawings ?? []).every((drawing) => {
        const retained = drawings.get(drawing.id);
        return retained && (!drawing.dataUrl || retained.dataUrl);
      })
      && (copy.checkpointRules ?? []).every((rule) =>
        JSON.stringify(rules.get(`${rule.room}\u0000${rule.item}\u0000${rule.name}`)) === JSON.stringify(rule)
      );
  });
  if (primaryContainsEveryCopy) return primary;

  let result = primary;
  for (const copy of copies) {
    if (copy.id === primary.id) continue;
    // A stale personal backup can carry an area deletion marker for an area
    // that remains active in another copy. Keep the active area and its work;
    // the older copy remains recoverable in Trash after the merge.
    const activeResultAreaIds = new Set(result.areas.filter((area) =>
      !area.deletedAt && !area.purgedAt).map((area) => area.id));
    const activeCopyAreaIds = new Set(copy.areas.filter((area) =>
      !area.deletedAt && !area.purgedAt).map((area) => area.id));
    const merged = mergeProjects({
      ...result,
      areas: result.areas.filter((area) =>
        (!area.deletedAt && !area.purgedAt) || !activeCopyAreaIds.has(area.id)),
    }, {
      ...copy,
      areas: copy.areas.filter((area) =>
        (!area.deletedAt && !area.purgedAt) || !activeResultAreaIds.has(area.id)),
    });
    const drawings = new Map((result.facadeElevationDrawings ?? []).map((drawing) => [drawing.id, drawing]));
    for (const drawing of copy.facadeElevationDrawings ?? []) {
      const existing = drawings.get(drawing.id);
      if (!existing || (!existing.dataUrl && drawing.dataUrl)) drawings.set(drawing.id, drawing);
    }
    const rules = new Map((result.checkpointRules ?? []).map((rule) =>
      [`${rule.room}\u0000${rule.item}\u0000${rule.name}`, rule]
    ));
    for (const rule of copy.checkpointRules ?? []) {
      rules.set(`${rule.room}\u0000${rule.item}\u0000${rule.name}`, rule);
    }
    result = {
      ...result,
      id: primary.id,
      oneDriveFolderName: primary.oneDriveFolderName,
      areas: merged.areas.map((area) => ({ ...area, projectId: primary.id })),
      facadeElevationDrawings: [...drawings.values()],
      checkpointRules: [...rules.values()],
    };
  }
  return result;
}

function areaSyncFingerprint(area: Project['areas'][number]) {
  return JSON.stringify(area, (key, value) => {
    if (key === 'projectId' || key === 'sharedVersion' || key === 'sharedPublishedAt'
      || key === 'updatedAt' || key === 'createdAt') return undefined;
    if (key === 'imageData' || key === 'thumbnail' || key === 'data') return Boolean(value);
    return value;
  });
}

export function areasChangedSinceTeamCopy(teamCopy: Project, merged: Project) {
  const teamAreas = new Map(teamCopy.areas.map((area) => [area.id, area]));
  return merged.areas.filter((area) => {
    const teamArea = teamAreas.get(area.id);
    return !teamArea || areaSyncFingerprint(area) !== areaSyncFingerprint(teamArea);
  }).map((area) => area.id);
}

export function areasWithMissingMedia(project: Project, areaIds: Iterable<string>) {
  const included = new Set(areaIds);
  return project.areas.filter((area) => included.has(area.id) && area.locations.some((location) =>
    location.items.some((item) => item.checkpoints.some((checkpoint) =>
      checkpoint.photos.some((photo) => !photo.imageData)
      || (checkpoint.files ?? []).some((file) => !file.data)
    ))
  )).map((area) => area.id);
}
