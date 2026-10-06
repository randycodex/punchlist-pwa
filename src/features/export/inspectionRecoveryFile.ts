import {
  captureLocalProjectSaveToken, getSavedProjectMetadata, getPendingSharedAreaSyncsForProject,
  getPendingSharedProjectMetadataSyncForProject,
} from '@/lib/db';
import { listCaptureDrafts, type CaptureDraft } from '@/lib/captureJournal';
import { withBrowserLock } from '@/lib/browserLocks';

/** Read inspection metadata without opening, replacing, or acknowledging media. */
export async function prepareInspectionRecoveryFile(projectId: string) {
  return withBrowserLock('local-persistence', async () => {
    const sourceToken = await captureLocalProjectSaveToken(projectId);
    const project = await getSavedProjectMetadata(projectId);
    if (!project) throw new Error('This saved project is not available on this device.');
    const [pendingAreas, pendingProjectDetails] = await Promise.all([
      getPendingSharedAreaSyncsForProject(projectId),
      getPendingSharedProjectMetadataSyncForProject(projectId),
    ]);
    const captureDrafts: CaptureDraft[] = [];
    const unreadableDraftAreas: string[] = [];
    for (const area of project.areas) {
      try { captureDrafts.push(...await listCaptureDrafts(projectId, area.id)); }
      catch { unreadableDraftAreas.push(area.id); }
    }
    if (await captureLocalProjectSaveToken(projectId) !== sourceToken) {
      throw new Error('The saved inspection changed while preparing this copy. Pause editing and prepare it again. Your current work was kept.');
    }
    // Clear only this detached copy. Even readable media is excluded so a
    // missing Safari backing file cannot prevent safeguarding the inspection.
    const copy = structuredClone(project);
    for (const drawing of copy.facadeElevationDrawings ?? []) drawing.dataUrl = '';
    for (const area of copy.areas) for (const room of area.locations) for (const item of room.items) for (const checkpoint of item.checkpoints) {
      for (const photo of checkpoint.photos) { photo.imageData = ''; delete photo.thumbnail; }
      for (const file of checkpoint.files ?? []) file.data = '';
    }
    const createdAt = new Date().toISOString();
    const recovery = {
      format: 'punchlist-inspection-recovery', version: 1, createdAt,
      limitations: {
        savedPhotoFileAndDrawingBytesIncluded: false,
        voiceDraftAudioIncluded: false,
        unreadableDraftAreas,
        message: 'This copy preserves saved inspection results, comments, attachment references, and readable capture drafts. Saved photo, file and drawing bytes are excluded. This is not a completed Team sync or a complete photo backup. Keep the original browser data intact.',
      },
      project: copy,
      pendingSync: { areas: pendingAreas, projectDetails: pendingProjectDetails ?? null },
      captureDrafts: captureDrafts.map((draft) => draft.kind === 'voice'
        ? { ...draft, audio: undefined, omittedAudioSampleCount: draft.audio.length } : draft),
    };
    const name = project.projectName.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'Punchlist';
    return {
      filename: `${name}_Inspection_Recovery_${createdAt.replace(/[:.]/g, '-')}.json`,
      json: JSON.stringify(recovery, null, 2),
      unreadableDraftAreaCount: unreadableDraftAreas.length,
    };
  });
}
