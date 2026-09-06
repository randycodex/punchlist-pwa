import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const componentSource = readFileSync(
  fileURLToPath(new URL('../src/features/inspection/OfflineVoiceNoteButton.tsx', import.meta.url)),
  'utf8'
);

describe('offline voice note capture', () => {
  it('captures microphone PCM without decoding a compressed recording container', () => {
    expect(componentSource).toContain('createMediaStreamSource');
    expect(componentSource).toContain('AudioWorkletNode');
    expect(componentSource).not.toContain('createScriptProcessor');
    expect(componentSource).not.toContain('MediaRecorder');
    expect(componentSource).not.toContain('decodeAudioData');
  });
});
