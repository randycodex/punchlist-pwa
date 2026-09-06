export type VoiceProgress = (status: string) => void;
let worker: Worker | undefined;
let pending: { resolve: (text: string) => void; reject: (error: Error) => void; progress?: VoiceProgress; timer: ReturnType<typeof setTimeout> } | undefined;
function reset(message: string) {
  worker?.terminate(); worker = undefined;
  if (pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); pending = undefined; }
}
export function runVoiceEngine(audio?: Float32Array, progress?: VoiceProgress): Promise<string> {
  if (pending) return Promise.reject(new Error('Another voice task is running. Try again when it finishes.'));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject, progress, timer: setTimeout(() => reset('Voice processing timed out. Your recording is retained; retry when ready.'), 180_000) };
    try {
      worker ??= new Worker(new URL('./offlineTranscription.worker.ts', import.meta.url));
      worker.onmessage = ({ data }) => {
        if (!pending) return;
        if (data.type === 'loading') { pending.progress?.('Preparing voice model… Keep this page open.'); return; }
        if (data.type === 'transcribing') { pending.progress?.('Transcribing on this device…'); return; }
        const task = pending; clearTimeout(task.timer); pending = undefined;
        if (data.type === 'error') task.reject(new Error(data.message));
        else task.resolve(data.text ?? '');
      };
      worker.onerror = (event) => reset(event.message || 'Voice processing could not start. Retry preparation or your saved recording.');
      // Keep the original samples available for recovery instead of transferring ownership.
      worker.postMessage(audio ? { type: 'transcribe', audio } : { type: 'prepare' });
    } catch (error) { reset(error instanceof Error ? error.message : 'Voice processing failed.'); }
  });
}
