import { claimSharedProjectArea } from '@/lib/collaboration/areaClaims';
import { refreshSharedProject } from '@/features/sync/refreshSharedProject';

/** Lock first, then refresh only changes relevant to the opening inspection. */
export async function prepareSharedInspectionArea(
  localProjectId: string,
  sharedProjectId: string,
  areaId: string,
  canApply: () => boolean
) {
  await claimSharedProjectArea(sharedProjectId, areaId);
  if (!canApply()) return 'deferred' as const;
  // A teammate's lock fails before any snapshot/attachment download. Edits
  // stay disabled until this unit's freshness check or guarded refresh ends.
  return refreshSharedProject(localProjectId, canApply, areaId);
}
