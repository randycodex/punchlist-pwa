/// <reference lib="webworker" />

import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressCallback,
} from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/whisper-tiny.en';

type TranscribeRequest = {
  type: 'transcribe';
  audio: Float32Array;
};

type WorkerResponse =
  | { type: 'loading'; progress?: number }
  | { type: 'transcribing' }
  | { type: 'complete'; text: string }
  | { type: 'error'; message: string };

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function postMessageToClient(message: WorkerResponse) {
  self.postMessage(message);
}

function getTranscriber() {
  if (transcriberPromise) return transcriberPromise;

  const supportsWebGpu = 'gpu' in navigator;
  const progressCallback: ProgressCallback = (progressInfo) => {
    if (progressInfo.status === 'progress') {
      postMessageToClient({ type: 'loading', progress: Math.round(progressInfo.progress) });
      return;
    }
    if (progressInfo.status === 'initiate' || progressInfo.status === 'download') {
      postMessageToClient({ type: 'loading' });
    }
  };

  async function loadTranscriber() {
    if (supportsWebGpu) {
      try {
        return await pipeline('automatic-speech-recognition', MODEL_ID, {
          device: 'webgpu',
          dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
          progress_callback: progressCallback,
        }) as AutomaticSpeechRecognitionPipeline;
      } catch {
        postMessageToClient({ type: 'loading' });
      }
    }

    return await pipeline('automatic-speech-recognition', MODEL_ID, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: progressCallback,
    }) as AutomaticSpeechRecognitionPipeline;
  }

  transcriberPromise = loadTranscriber();

  transcriberPromise.catch(() => {
    transcriberPromise = null;
  });

  return transcriberPromise;
}

self.addEventListener('message', async (event: MessageEvent<TranscribeRequest>) => {
  if (event.data.type !== 'transcribe') return;

  try {
    postMessageToClient({ type: 'loading' });
    const transcriber = await getTranscriber();
    postMessageToClient({ type: 'transcribing' });

    const result = await transcriber(event.data.audio, {
      language: 'en',
      task: 'transcribe',
    });
    const text = Array.isArray(result) ? result.map((entry) => entry.text).join(' ') : result.text;

    postMessageToClient({ type: 'complete', text: text.trim() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Offline transcription failed.';
    postMessageToClient({ type: 'error', message });
  }
});

export {};
