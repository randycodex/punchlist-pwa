'use client';

import { Mic, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type VoiceState = 'idle' | 'requesting' | 'recording' | 'processing' | 'error';

type TranscriptionWorkerMessage =
  | { type: 'loading'; progress?: number }
  | { type: 'transcribing' }
  | { type: 'complete'; text: string }
  | { type: 'error'; message: string };

type OfflineVoiceNoteButtonProps = {
  onTranscript: (text: string) => void;
  onActivityChange?: (active: boolean) => void;
};

const TARGET_SAMPLE_RATE = 16_000;
const MAX_RECORDING_MS = 30_000;

function getPreferredAudioMimeType() {
  if (typeof MediaRecorder === 'undefined') return undefined;

  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function mixChannels(audioBuffer: AudioBuffer) {
  const mono = new Float32Array(audioBuffer.length);

  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    const channel = audioBuffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < channel.length; sampleIndex += 1) {
      mono[sampleIndex] += channel[sampleIndex] / audioBuffer.numberOfChannels;
    }
  }

  return mono;
}

function resampleAudio(input: Float32Array, inputSampleRate: number) {
  if (inputSampleRate === TARGET_SAMPLE_RATE) return input.slice();

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourceStart = outputIndex * ratio;
    const sourceEnd = Math.min((outputIndex + 1) * ratio, input.length);
    const firstSample = Math.floor(sourceStart);
    const lastSample = Math.max(firstSample + 1, Math.ceil(sourceEnd));
    let sum = 0;
    let count = 0;

    for (let sourceIndex = firstSample; sourceIndex < lastSample && sourceIndex < input.length; sourceIndex += 1) {
      sum += input[sourceIndex];
      count += 1;
    }

    output[outputIndex] = count > 0 ? sum / count : 0;
  }

  return output;
}

async function decodeRecording(blob: Blob) {
  const audioContext = new AudioContext();

  try {
    const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    return resampleAudio(mixChannels(audioBuffer), audioBuffer.sampleRate);
  } finally {
    await audioContext.close();
  }
}

function getMicrophoneErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : '';

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone permission was blocked.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is unavailable or already in use.';
  }

  return error instanceof Error ? error.message : 'Could not start the microphone.';
}

export default function OfflineVoiceNoteButton({
  onTranscript,
  onActivityChange,
}: OfflineVoiceNoteButtonProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [statusText, setStatusText] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const onTranscriptRef = useRef(onTranscript);
  const onActivityChangeRef = useRef(onActivityChange);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onActivityChangeRef.current = onActivityChange;
  }, [onActivityChange, onTranscript]);

  const clearRecordingTimer = useCallback(() => {
    if (recordingTimerRef.current === null) return;
    window.clearTimeout(recordingTimerRef.current);
    recordingTimerRef.current = null;
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const getWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;

    const worker = new Worker(new URL('./offlineTranscription.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;
    return worker;
  }, []);

  const transcribeRecording = useCallback(async (blob: Blob) => {
    setVoiceState('processing');
    setStatusText('Preparing voice note…');

    try {
      const audio = await decodeRecording(blob);
      if (!mountedRef.current) return;
      const worker = getWorker();

      worker.onmessage = (event: MessageEvent<TranscriptionWorkerMessage>) => {
        const message = event.data;

        if (message.type === 'loading') {
          setStatusText(
            typeof message.progress === 'number'
              ? `Preparing offline AI ${message.progress}%`
              : 'Preparing offline AI…'
          );
          return;
        }
        if (message.type === 'transcribing') {
          setStatusText('Transcribing on this device…');
          return;
        }
        if (message.type === 'complete') {
          if (message.text) {
            onTranscriptRef.current(message.text);
            setVoiceState('idle');
            setStatusText('');
            onActivityChangeRef.current?.(false);
          } else {
            setVoiceState('error');
            setStatusText('No speech was detected.');
            onActivityChangeRef.current?.(false);
          }
          return;
        }

        setVoiceState('error');
        setStatusText(message.message || 'Offline transcription failed.');
        onActivityChangeRef.current?.(false);
      };

      worker.onerror = () => {
        setVoiceState('error');
        setStatusText('Offline transcription could not start on this device.');
        onActivityChangeRef.current?.(false);
      };

      worker.postMessage({ type: 'transcribe', audio }, [audio.buffer]);
    } catch (error) {
      setVoiceState('error');
      setStatusText(error instanceof Error ? error.message : 'The recording could not be processed.');
      onActivityChangeRef.current?.(false);
    }
  }, [getWorker]);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceState('error');
      setStatusText('Offline voice notes are not supported by this browser.');
      onActivityChangeRef.current?.(false);
      return;
    }

    onActivityChangeRef.current?.(true);
    setVoiceState('requesting');
    setStatusText('Requesting microphone…');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const mimeType = getPreferredAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener('stop', () => {
        clearRecordingTimer();
        const recording = new Blob(chunksRef.current, { type: recorder.mimeType });
        recorderRef.current = null;
        chunksRef.current = [];
        stopStream();
        if (!mountedRef.current) return;
        if (recording.size === 0) {
          setVoiceState('error');
          setStatusText('The recording was empty. Try again.');
          onActivityChangeRef.current?.(false);
          return;
        }
        void transcribeRecording(recording);
      }, { once: true });

      recorder.start();
      recordingTimerRef.current = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, MAX_RECORDING_MS);
      setVoiceState('recording');
      setStatusText('Recording… tap stop when finished. 30 seconds max.');
    } catch (error) {
      stopStream();
      setVoiceState('error');
      setStatusText(getMicrophoneErrorMessage(error));
      onActivityChangeRef.current?.(false);
    }
  }, [clearRecordingTimer, stopStream, transcribeRecording]);

  const handleClick = useCallback(() => {
    if (voiceState === 'recording') {
      recorderRef.current?.stop();
      setVoiceState('processing');
      setStatusText('Finishing recording…');
      return;
    }

    if (voiceState === 'idle' || voiceState === 'error') {
      void startRecording();
    }
  }, [startRecording, voiceState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onActivityChangeRef.current?.(false);
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      clearRecordingTimer();
      stopStream();
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [clearRecordingTimer, stopStream]);

  const isBusy = voiceState === 'requesting' || voiceState === 'processing';
  const isRecording = voiceState === 'recording';
  const buttonLabel = isRecording
    ? 'Stop recording voice note'
    : isBusy
      ? statusText
      : 'Record offline voice note';

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-inspection-inline-action="true"
        onClick={(event) => {
          event.stopPropagation();
          handleClick();
        }}
        disabled={isBusy}
        className={`flex h-10 w-10 items-center justify-center rounded-[1rem] transition ${
          isRecording
            ? 'bg-red-600 text-white shadow-sm hover:bg-red-700'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:cursor-wait disabled:opacity-60 dark:bg-zinc-800 dark:text-gray-100 dark:hover:bg-zinc-700'
        }`}
        aria-label={buttonLabel}
        title={buttonLabel}
      >
        {isRecording ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-4.5 w-4.5" />}
      </button>
      {statusText && (
        <span
          className={`pointer-events-none absolute right-0 top-12 z-10 w-56 rounded-xl px-3 py-2 text-right text-[0.68rem] shadow-lg ${
            voiceState === 'error'
              ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200'
              : 'bg-white text-gray-600 dark:bg-zinc-900 dark:text-gray-300'
          }`}
          role="status"
          aria-live="polite"
        >
          {statusText}
        </span>
      )}
    </div>
  );
}
