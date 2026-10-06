import {
  captureLocalProjectSaveToken, getProject, getProjectMetadata,
  getPendingSharedAreaSyncsForProject, getPendingSharedProjectMetadataSyncForProject,
  saveDownloadedProjectIfUnchanged,
} from '@/lib/db';
import { hasProjectCaptureDrafts } from '@/lib/captureJournal';
import { hasNewerSharedProjectRevisions } from '@/lib/collaboration/sharedProjectSnapshots';
import { getPendingSharedPullState } from '@/features/collaboration/manualSharedPull';

/** Download a clean copy without releasing locks or advancing unsent edits' bases. */
export async function refreshSharedProject(
  projectId: string,
  canApply: () => boolean = () => true
): Promise<'current' | 'updated' | 'review' | 'deferred'> {
  const sourceToken = await captureLocalProjectSaveToken(projectId);
  const metadata = await getProjectMetadata(projectId);
  if (!metadata?.sharedProjectId || metadata.deletedAt || !canApply()) return 'deferred';
  if (!await hasNewerSharedProjectRevisions(metadata)) return 'current';
  const [pendingAreas, pendingMetadata, drafts] = await Promise.all([
    getPendingSharedAreaSyncsForProject(projectId),
    getPendingSharedProjectMetadataSyncForProject(projectId),
    hasProjectCaptureDrafts(projectId),
  ]);
  if (pendingAreas.length || pendingMetadata || drafts) return 'review';
  const project = await getProject(projectId);
  if (!project || !canApply()) return 'deferred';
  const pull = await getPendingSharedPullState(project, 'manual-pull');
  if (pull.hasNewerLocalChanges || pull.conflictingAreaNames.length
    || pull.preservedLocalAreaCount || pull.preservedLocalProjectMetadata) return 'review';
  return await saveDownloadedProjectIfUnchanged(pull.resolutionProject, sourceToken, { canApply })
    ? 'updated' : 'deferred';
}
