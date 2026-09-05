import type { PhotoAttachment } from '@/types';
import { getProjectForArea, saveCheckpointInspectionChange } from '@/lib/db';
import { stageCaptureDraft, listCaptureDrafts, clearCaptureDraft, CAPTURE_RECOVERY_EVENT, type CaptureDraft } from '@/lib/captureJournal';
export { stageCaptureDraft, listCaptureDrafts, clearCaptureDraft, CAPTURE_RECOVERY_EVENT, CAPTURE_CLEARED_EVENT, type CaptureDraft } from '@/lib/captureJournal';
function notify() { if (typeof window !== 'undefined') window.dispatchEvent(new Event(CAPTURE_RECOVERY_EVENT)); }

const latestNoteRevision = new Map<string, string>();

export async function saveRecoverableNote(projectId: string, areaId: string, checkpointId: string, value: string, baseValue: string) {
  const draft: CaptureDraft = { key: `note:${projectId}:${checkpointId}`, revision: crypto.randomUUID(), projectId, areaId, checkpointId, kind: 'note', value, baseValue, savedAt: new Date() };
  latestNoteRevision.set(draft.key, draft.revision);
  await stageCaptureDraft(draft);
  // Every input is journaled, but bursts do not rewrite the whole project for each key.
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (latestNoteRevision.get(draft.key) !== draft.revision) return false;
  try {
    await saveCheckpointInspectionChange(projectId, areaId, checkpointId, { comments: value });
    await clearCaptureDraft(draft);
    if (latestNoteRevision.get(draft.key) === draft.revision) latestNoteRevision.delete(draft.key);
    return true;
  } catch (error) { notify(); throw error; }
}
export async function saveRecoverablePhotos(projectId: string, areaId: string, checkpointId: string, photos: PhotoAttachment[]) {
  const drafts: CaptureDraft[] = photos.map((photo) => ({ key: `photo:${projectId}:${photo.id}`, revision: photo.id, projectId, areaId, checkpointId, kind: 'photo', photo, savedAt: new Date() }));
  let recoveryStored = false;
  try {
    for (const draft of drafts) await stageCaptureDraft(draft);
    recoveryStored = true;
    await saveCheckpointInspectionChange(projectId, areaId, checkpointId, {}, photos);
    for (const draft of drafts) await clearCaptureDraft(draft);
  } catch (error) {
    notify();
    throw Object.assign(new Error(error instanceof Error ? error.message : 'Photo save failed.'), { recoveryStored });
  }
}

// Called only after the screen's current edit/claim gate succeeds. Recovery never
// silently overwrites notes received from another inspector or a later local edit.
export async function restoreCaptureDraft(draft: CaptureDraft) {
  const currentDrafts = await listCaptureDrafts(draft.projectId, draft.areaId);
  if (currentDrafts.find((entry) => entry.key === draft.key)?.revision !== draft.revision) throw new Error('This capture has already been saved or changed. Reopen the area to refresh recovery.');
  const project = await getProjectForArea(draft.projectId, draft.areaId);
  const area = project?.areas.find((entry) => entry.id === draft.areaId && !entry.deletedAt);
  const checkpoint = area?.locations.flatMap((location) => location.items.flatMap((item) => item.checkpoints)).find((entry) => entry.id === draft.checkpointId);
  if (!project || project.deletedAt || !checkpoint) throw new Error('The original checkpoint is unavailable. Keep this recovery record until the project or area is restored.');
  if (draft.kind === 'photo') {
    await saveCheckpointInspectionChange(draft.projectId, draft.areaId, draft.checkpointId, {}, [draft.photo]);
  } else {
    await saveCheckpointInspectionChange(draft.projectId, draft.areaId, draft.checkpointId, {}, [], { recoveredNote: draft });
  }
  await clearCaptureDraft(draft);
}
