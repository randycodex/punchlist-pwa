import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { joinVoice, resampleVoice, voiceWav } from '@/features/inspection/voiceAudio';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  respond(data: unknown) { this.onmessage?.({ data }); }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); FakeWorker.instances = []; });
describe('voice engine reliability', () => {
  it('reuses its worker across notes and rejects concurrent tasks without replacing the first callback', async () => {
    vi.resetModules(); vi.stubGlobal('Worker', FakeWorker);
    const { runVoiceEngine } = await import('@/features/inspection/voiceEngine');
    const first = runVoiceEngine(); const worker = FakeWorker.instances[0];
    await expect(runVoiceEngine(new Float32Array(4))).rejects.toThrow('Another voice task');
    worker.respond({ type: 'complete', text: '' }); await first;
    const audio = new Float32Array([1, 2]); const second = runVoiceEngine(audio);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'transcribe', audio });
    worker.respond({ type: 'complete', text: 'Adjust hinge' }); await expect(second).resolves.toBe('Adjust hinge');
    expect(audio.length).toBe(2);
  });
  it('terminates a hung worker and permits retry with a fresh worker', async () => {
    vi.useFakeTimers(); vi.resetModules(); vi.stubGlobal('Worker', FakeWorker);
    const { runVoiceEngine } = await import('@/features/inspection/voiceEngine');
    const first = runVoiceEngine(); const rejected = expect(first).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(180_000); await rejected;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalled();
    const retry = runVoiceEngine(); expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].respond({ type: 'complete', text: '' }); await retry;
  });
  it('flushes a partial audio block when Stop is requested', () => {
    let Processor: new () => { process: (inputs: Float32Array[][]) => boolean; port: { onmessage: (event: { data: string }) => void; postMessage: ReturnType<typeof vi.fn> } };
    class Base { port = { postMessage: vi.fn(), onmessage: () => {} }; }
    runInNewContext(readFileSync('public/voice-capture-worklet.js', 'utf8'), { AudioWorkletProcessor: Base, sampleRate: 48000, Float32Array, registerProcessor: (_name: string, processor: typeof Processor) => { Processor = processor; } });
    const capture = new Processor!();
    capture.process([[new Float32Array([0.2, 0.4]), new Float32Array([0.4, 0.6])]]);
    expect(capture.port.postMessage).not.toHaveBeenCalled();
    capture.port.onmessage({ data: 'stop' });
    expect(capture.port.postMessage.mock.calls[0][0].audio[0]).toBeCloseTo(0.3);
    expect(capture.port.postMessage.mock.calls[0][0].audio).toHaveLength(2);
    expect(capture.port.postMessage).toHaveBeenLastCalledWith({ stopped: true });
  });
  it('keeps audio duration when resampling and emits a playable mono WAV', async () => {
    const audio = resampleVoice(new Float32Array(48000).fill(0.5), 48000);
    expect(audio).toHaveLength(16000);
    expect(joinVoice([audio, audio])).toHaveLength(32000);
    const wav = await voiceWav(audio).arrayBuffer();
    expect(new DataView(wav).getUint32(24, true)).toBe(16000);
    expect(wav.byteLength).toBe(32044);
  });
});
