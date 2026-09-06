'use client';
import { useEffect, useRef, useState } from 'react';
import { runVoiceEngine } from './voiceEngine';
import { voiceWav } from './voiceAudio';
import { stageCaptureDraft } from '@/lib/captureJournal';
import type { Area } from '@/types';
import { CAPTURE_CLEARED_EVENT, CAPTURE_RECOVERY_EVENT, listCaptureDrafts, restoreCaptureDraft, type CaptureDraft } from './captureRecovery';

export default function CaptureRecovery({ projectId, area, canEdit, beforeRestore, onRestored }: { projectId: string; area: Area; canEdit: boolean; beforeRestore: () => Promise<void>; onRestored: () => Promise<void> }) {
  const [drafts, setDrafts] = useState<CaptureDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () => void listCaptureDrafts(projectId, area.id).then((items) => { if (!cancelled) setDrafts(items); }).catch(() => { if (!cancelled) setError('Recovery storage could not be read. Keep this page open and retry.'); });
    const clear = (event: Event) => { const { key, revision } = (event as CustomEvent).detail; setDrafts((current) => current.filter((draft) => draft.key !== key || draft.revision !== revision)); };
    load(); window.addEventListener(CAPTURE_RECOVERY_EVENT, load);
    window.addEventListener(CAPTURE_CLEARED_EVENT, clear);
    return () => { cancelled = true; window.removeEventListener(CAPTURE_RECOVERY_EVENT, load); window.removeEventListener(CAPTURE_CLEARED_EVENT, clear); };
  }, [projectId, area.id]);
  async function restore(draft: CaptureDraft) {
    if (!canEdit || busy) return;
    setBusy(true); setError(null);
    try {
      await beforeRestore();
      if (draft.kind === 'voice' && !draft.transcript) {
        const transcript = await runVoiceEngine(draft.audio);
        if (!transcript.trim()) throw new Error('No speech detected. The recording is retained for playback.');
        draft = { ...draft, transcript };
        await stageCaptureDraft(draft);
      }
      await restoreCaptureDraft(draft);
      setDrafts(await listCaptureDrafts(projectId, area.id));
      await onRestored();
    } catch (error) { setError(error instanceof Error ? error.message : 'Recovery failed. The capture is still retained.'); }
    finally { setBusy(false); }
  }
  if (!drafts.length && !error) return null;
  return <section className="mx-auto mb-4 max-w-6xl rounded-2xl border border-amber-400/40 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100" aria-label="Recover inspection captures">
    <p className="font-semibold">{drafts.length} capture{drafts.length === 1 ? '' : 's'} saved for recovery</p>
    <p className="mt-1 text-xs">Review captures interrupted before completion. If a note has changed, restoring appends the recovered text and preserves the current note.</p>
    {!canEdit && <p className="mt-2 text-xs">Reconnect and confirm your team lock before restoring.</p>}
    {drafts.map((draft) => {
      const item = area.locations.flatMap((location) => location.items).find((item) => item.checkpoints.some((checkpoint) => checkpoint.id === draft.checkpointId));
      const checkpoint = item?.checkpoints.find((checkpoint) => checkpoint.id === draft.checkpointId);
      return <div key={draft.key} className="mt-3 border-t border-amber-600/20 pt-3">
        <p className="font-medium">{item?.name ?? 'Original item'} › {checkpoint?.name ?? 'Unavailable checkpoint'}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs">{draft.kind === 'note' ? draft.value || '(Empty note)' : draft.kind === 'voice' ? draft.transcript || 'Voice recording retained on this device' : 'Photo retained on this device'}</p>
        {draft.kind === 'voice' && <VoicePlayback audio={draft.audio} />}
        <button type="button" className="mt-2 min-h-11 rounded-xl px-4 font-semibold accent-bg text-white disabled:opacity-50" disabled={!canEdit || busy} onClick={() => void restore(draft)}>{busy ? 'Restoring…' : draft.kind === 'voice' ? 'Transcribe and restore note' : 'Restore capture'}</button>
      </div>;
    })}
    {error && <p role="alert" className="mt-2">{error}</p>}
  </section>;
}

function VoicePlayback({ audio }: { audio: Float32Array }) {
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => { const next = URL.createObjectURL(voiceWav(audio)); if (player.current) player.current.src = next; return () => URL.revokeObjectURL(next); }, [audio]);
  return <audio ref={player} className="mt-2 w-full" controls aria-label="Play retained voice recording" />;
}
