import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(
  fileURLToPath(new URL('../src/features/inspection/offlineTranscription.worker.ts', import.meta.url)),
  'utf8'
);

describe('offline transcription worker', () => {
  it('does not pass multilingual generation options to the English-only Whisper model', () => {
    expect(workerSource).toContain("const MODEL_ID = 'onnx-community/whisper-tiny.en';");
    expect(workerSource).toContain('transcriber(event.data.audio)');
    expect(workerSource).not.toMatch(/language\s*:/);
    expect(workerSource).not.toMatch(/task\s*:\s*['"]transcribe['"]/);
  });
});
