import { v5 as uuidv5 } from 'uuid';
import type { Project } from '@/types';

export type AttachmentIdentityChange = { kind: 'photos' | 'files'; oldId: string; newId: string };

/** Preserve legacy sibling checkpoints that accidentally reused an ID. Never merge their content. */
export function repairDuplicateCheckpointIdentities(project: Project) {
  const attachments: AttachmentIdentityChange[] = [];
  let changed = false;
  const reserved = new Set(project.areas.flatMap((area) => area.locations.flatMap((location) =>
    location.items.flatMap((item) => item.checkpoints.map((checkpoint) => checkpoint.id)))));
  for (const area of project.areas) for (const location of area.locations) for (const item of location.items) {
    const seen = new Set<string>();
    for (const checkpoint of item.checkpoints) {
      const oldId = checkpoint.id;
      if (!seen.has(oldId)) { seen.add(oldId); continue; }
      // Leave malformed parent references for strict validation to reject.
      if (checkpoint.itemId !== item.id) continue;
      let ordinal = 0;
      let id: string;
      do {
        id = uuidv5(JSON.stringify(['legacy-sibling-checkpoint', item.id, oldId, checkpoint.name, ordinal++]), uuidv5.URL);
      } while (reserved.has(id));
      reserved.add(id);
      // Hydration can attach the same media object to both legacy entries.
      // Copy before rekeying so the original checkpoint keeps its references.
      checkpoint.photos = checkpoint.photos.map((photo) => ({ ...photo }));
      if (checkpoint.files) checkpoint.files = checkpoint.files.map((file) => ({ ...file }));
      checkpoint.id = id;
      changed = true;
      for (const kind of ['photos', 'files'] as const) {
        const rekey = (attachmentId: string) => uuidv5(JSON.stringify(['legacy-checkpoint-media', id, kind, attachmentId]), uuidv5.URL);
        for (const attachment of checkpoint[kind] ?? []) {
          if (attachment.checkpointId !== oldId) continue;
          const newId = rekey(attachment.id);
          attachments.push({ kind, oldId: attachment.id, newId });
          attachment.id = newId;
          attachment.checkpointId = id;
        }
        if (kind === 'photos' && checkpoint.deletedPhotoIds) checkpoint.deletedPhotoIds = checkpoint.deletedPhotoIds.map(rekey);
        if (kind === 'files' && checkpoint.deletedFileIds) checkpoint.deletedFileIds = checkpoint.deletedFileIds.map(rekey);
      }
    }
  }
  return { changed, attachments };
}
