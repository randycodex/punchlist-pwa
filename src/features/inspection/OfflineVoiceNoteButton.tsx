'use client';
import { Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { stageCaptureDraft, clearCaptureDraft, CAPTURE_RECOVERY_EVENT, type CaptureDraft } from '@/lib/captureJournal';
import { getProjectForArea } from '@/lib/db';
import { runVoiceEngine } from './voiceEngine';
import { joinVoice, resampleVoice } from './voiceAudio';

type VoiceDraft = Extract<CaptureDraft, { kind: 'voice' }>;
type Capture = { context: AudioContext; stream: MediaStream; source: MediaStreamAudioSourceNode; node: AudioWorkletNode; gain: GainNode; chunks: Float32Array[]; draft: VoiceDraft; saved: Promise<void>; stop?: () => void; timer?: ReturnType<typeof setTimeout> };
const notifyRecovery = () => window.dispatchEvent(new Event(CAPTURE_RECOVERY_EVENT));
function release(capture: Capture) {
  clearTimeout(capture.timer); capture.stream.getTracks().forEach((track) => track.stop());
  capture.source.disconnect(); capture.node.disconnect(); capture.gain.disconnect(); void capture.context.close().catch(() => {});
}
export default function OfflineVoiceNoteButton({ projectId, areaId, checkpointId, onTranscript, onActivityChange }: {
  projectId: string; areaId: string; checkpointId: string;
  onTranscript: (text: string) => Promise<void>; onActivityChange?: (active: boolean) => void;
}) {
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'processing' | 'error'>('idle');
  const [status, setStatus] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const capture = useRef<Capture | null>(null), retained = useRef<VoiceDraft | null>(null);
  const mounted = useRef(true), callbacks = useRef({ onTranscript, onActivityChange });
  useEffect(() => { callbacks.current = { onTranscript, onActivityChange }; }, [onTranscript, onActivityChange]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; callbacks.current.onActivityChange?.(false); if (capture.current) { release(capture.current); capture.current = null; } notifyRecovery(); };
  }, []);
  const report = (message: string) => { if (mounted.current) setStatus(message); };
  async function process(draft: VoiceDraft) {
    retained.current = draft;
    setState('processing'); callbacks.current.onActivityChange?.(true); report('Saving recording on this device…');
    try {
      await stageCaptureDraft(draft);
      const text = draft.transcript || await runVoiceEngine(draft.audio, report);
      if (!text.trim()) throw new Error('No speech detected. Your audio is saved; listen or retry in capture recovery.');
      draft = { ...draft, transcript: text }; retained.current = draft;
      await stageCaptureDraft(draft);
      if (!mounted.current) { notifyRecovery(); return; }
      await callbacks.current.onTranscript(text);
      const saved = await getProjectForArea(projectId, areaId);
      const note = saved?.areas.find((area) => area.id === areaId)?.locations.flatMap((room) => room.items.flatMap((item) => item.checkpoints)).find((checkpoint) => checkpoint.id === checkpointId)?.comments;
      if (!note?.trimEnd().endsWith(text.trim())) throw new Error('The transcript has not been saved yet. Your recording is retained for retry.');
      await clearCaptureDraft(draft); retained.current = null;
      if (mounted.current) { setState('idle'); report('Voice note saved. Review the text for accuracy.'); }
    } catch (error) {
      if (mounted.current) { setState('error'); report(error instanceof Error ? error.message : 'Voice failed. Keep this page open and retry.'); }
      notifyRecovery();
    } finally { callbacks.current.onActivityChange?.(false); }
  }
  async function finish() {
    const current = capture.current; if (!current) return;
    capture.current = null; setState('processing'); report('Saving recording…');
    // Flush the worklet's final partial second before closing the microphone.
    await new Promise<void>((resolve) => { current.stop = resolve; current.node.port.postMessage('stop'); setTimeout(resolve, 1500); });
    release(current);
    const audio = joinVoice(current.chunks);
    await current.saved.catch(() => {});
    if (!audio.length) { setState('error'); report('No audio was captured. Check microphone access and try again.'); callbacks.current.onActivityChange?.(false); return; }
    const draft = { ...current.draft, audio };
    if (!mounted.current) { await stageCaptureDraft(draft).catch(() => {}); notifyRecovery(); return; }
    await process(draft);
  }
  async function start() {
    if (retained.current) { await process(retained.current); return; }
    setState('starting'); report('Allow microphone access to record.'); callbacks.current.onActivityChange?.(true);
    let context: AudioContext | undefined, stream: MediaStream | undefined;
    try {
      context = new AudioContext(); await context.resume();
      await context.audioWorklet.addModule('/voice-capture-worklet.js');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (!mounted.current) { stream.getTracks().forEach((track) => track.stop()); void context.close(); return; }
      const source = context.createMediaStreamSource(stream), node = new AudioWorkletNode(context, 'inspection-voice-capture'), gain = context.createGain(); gain.gain.value = 0;
      const id = crypto.randomUUID();
      const current: Capture = { context, stream, source, node, gain, chunks: [], saved: Promise.resolve(), draft: { key: `voice:${projectId}:${id}`, revision: id, projectId, areaId, checkpointId, kind: 'voice', audio: new Float32Array(), savedAt: new Date() } };
      capture.current = current;
      node.port.onmessage = ({ data }) => {
        if (data.stopped) { current.stop?.(); return; }
        if (!data.audio) return;
        const audio = resampleVoice(data.audio, current.context.sampleRate); current.chunks.push(audio);
        const snapshot = { ...current.draft, audio: joinVoice(current.chunks) };
        // Serialize snapshots so an older write cannot overwrite a longer recording.
        current.saved = current.saved.catch(() => {}).then(() => stageCaptureDraft(snapshot));
        void current.saved.catch(() => report('Audio storage failed. Keep this page open; stop and retry saving.'));
        if (mounted.current) { setSeconds(Math.floor(snapshot.audio.length / 16000)); setLevel(Math.min(1, Math.sqrt(audio.reduce((sum, n) => sum + n * n, 0) / audio.length) * 5)); }
      };
      source.connect(node); node.connect(gain); gain.connect(context.destination);
      current.timer = setTimeout(() => void finish(), 30_000);
      setSeconds(0); setLevel(0); setState('recording'); report('Recording — tap Stop when finished.');
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop()); void context?.close();
      setState('error'); report(error instanceof Error ? error.message : 'Could not open the microphone.'); callbacks.current.onActivityChange?.(false);
    }
  }
  const busy = state === 'starting' || state === 'processing';
  return <div className="flex flex-col items-end gap-1">
    <button type="button" data-inspection-inline-action="true" aria-label={state === 'recording' ? 'Stop recording voice note' : retained.current ? 'Retry saved voice note' : 'Record offline voice note'} disabled={busy}
      onClick={(event) => { event.stopPropagation(); if (state === 'recording') void finish(); else void start(); }}
      className={`flex min-h-11 min-w-11 items-center justify-center rounded-2xl ${state === 'recording' ? 'bg-red-600 text-white' : 'soft-control disabled:opacity-50'}`}>
      {state === 'recording' ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-5 w-5" />}
    </button>
    {status && <div className="absolute right-0 top-12 z-10 w-64 rounded-xl bg-zinc-100 p-3 text-xs text-zinc-900 shadow-lg dark:bg-zinc-800 dark:text-zinc-100" role="status" aria-live="polite">
      <p>{status}</p>
      {state === 'idle' && <button type="button" className="mt-1 min-h-11 font-semibold" onClick={() => setStatus('')}>Dismiss</button>}
      {state === 'recording' && <><p className="mt-1 tabular-nums">{seconds}s / 30s</p><meter className="mt-1 w-full" min={0} max={1} value={level} aria-label="Microphone activity" /></>}
      {state === 'error' && retained.current && <button type="button" className="mt-2 min-h-11 font-semibold" onClick={() => void process(retained.current!)}>Retry saved recording</button>}
    </div>}
  </div>;
}
