import { localAccountKey } from '@/lib/localAccount';
import { openDB, type DBSchema } from 'idb';
import type { PhotoAttachment } from '@/types';
import { withBrowserLock } from '@/lib/browserLocks';

type CaptureIdentity = {
  key: string; revision: string; projectId: string; areaId: string; checkpointId: string; savedAt: Date;
};
export type CaptureDraft = CaptureIdentity & ({ kind: 'area-note'; value: string; baseValue: string } | { kind: 'note'; value: string; baseValue: string } | { kind: 'photo'; photo: PhotoAttachment });
// Read compatibility only: older clients may have left an interrupted recording.
// New captures cannot create these records; never purge them during an app update.
export type LegacyRecordingDraft = CaptureIdentity & { kind: 'voice'; audio?: Float32Array; transcript?: string };
export type StoredCaptureDraft = CaptureDraft | LegacyRecordingDraft;
interface CaptureDB extends DBSchema {
  drafts: { key: string; value: StoredCaptureDraft; indexes: { 'by-area': [string, string] } };
}
const journal = () => openDB<CaptureDB>(localAccountKey('punchlist-capture-recovery'), 1, {
  upgrade(db) { db.createObjectStore('drafts', { keyPath: 'key' }).createIndex('by-area', ['projectId', 'areaId']); },
});
export const CAPTURE_CLEARED_EVENT = 'punchlist-capture-cleared';
export const CAPTURE_RECOVERY_EVENT = 'punchlist-capture-recovery-needed';

export async function stageCaptureDraft(draft: CaptureDraft) {
  await withBrowserLock('local-persistence', async () => {
    const db = await journal();
    try { await db.put('drafts', draft); } finally { db.close(); }
  });
}

export async function hasProjectCaptureDrafts(projectId: string): Promise<boolean> {
  const db = await journal();
  try {
    const cursor = await db.transaction('drafts').store.index('by-area')
      .openKeyCursor(IDBKeyRange.lowerBound([projectId]));
    return cursor?.key[0] === projectId;
  } finally { db.close(); }
}
export async function listCaptureDrafts(projectId: string, areaId: string) {
  const db = await journal();
  try { return await db.getAllFromIndex('drafts', 'by-area', [projectId, areaId]); } finally { db.close(); }
}
export async function clearCaptureDraft(draft: StoredCaptureDraft) {
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
    let cursor = await tx.store.index('by-area').openKeyCursor(IDBKeyRange.lowerBound([projectId]));
    while (cursor?.key[0] === projectId) {
      await tx.store.delete(cursor.primaryKey);
      cursor = await cursor.continue();
    }
    await tx.done;
  } finally { db.close(); }
}
