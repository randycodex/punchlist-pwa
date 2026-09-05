import { openDB, type DBSchema } from 'idb';
import type { PhotoAttachment } from '@/types';

export type CaptureDraft = {
  key: string; revision: string; projectId: string; areaId: string; checkpointId: string; savedAt: Date;
} & ({ kind: 'note'; value: string; baseValue: string } | { kind: 'photo'; photo: PhotoAttachment });
interface CaptureDB extends DBSchema {
  drafts: { key: string; value: CaptureDraft; indexes: { 'by-area': [string, string] } };
}
const journal = () => openDB<CaptureDB>('punchlist-capture-recovery', 1, {
  upgrade(db) { db.createObjectStore('drafts', { keyPath: 'key' }).createIndex('by-area', ['projectId', 'areaId']); },
});
export const CAPTURE_CLEARED_EVENT = 'punchlist-capture-cleared';
export const CAPTURE_RECOVERY_EVENT = 'punchlist-capture-recovery-needed';

export async function stageCaptureDraft(draft: CaptureDraft) {
  const db = await journal();
  try { await db.put('drafts', draft); } finally { db.close(); }
}
export async function listCaptureDrafts(projectId: string, areaId: string) {
  const db = await journal();
  try { return await db.getAllFromIndex('drafts', 'by-area', [projectId, areaId]); } finally { db.close(); }
}
export async function clearCaptureDraft(draft: CaptureDraft) {
  const db = await journal();
  try {
    const tx = db.transaction('drafts', 'readwrite');
    const matches = (await tx.store.get(draft.key))?.revision === draft.revision;
    if (matches) await tx.store.delete(draft.key);
    await tx.done;
    if (matches && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CAPTURE_CLEARED_EVENT, { detail: { key: draft.key, revision: draft.revision } }));
  } finally { db.close(); }
}

export async function deleteProjectCaptureDrafts(projectId: string) {
  const db = await journal();
  try {
    const tx = db.transaction('drafts', 'readwrite');
    const keys = await tx.store.getAllKeys();
    for (const key of keys) if (key.startsWith(`note:${projectId}:`) || key.startsWith(`photo:${projectId}:`)) await tx.store.delete(key);
    await tx.done;
  } finally { db.close(); }
}
