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

type PcmCapture = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  chunks: Float32Array[];
  sampleRate: number;
};

const TARGET_SAMPLE_RATE = 16_000;
const MAX_RECORDING_MS = 30_000;

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

function concatenateAudioChunks(chunks: Float32Array[]) {
  const totalLength = chunks.reduce((length, chunk) => length + chunk.length, 0);
  const audio = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }

  return audio;
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
  const captureRef = useRef<PcmCapture | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
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

  const transcribeAudio = useCallback((audio: Float32Array) => {
    setVoiceState('processing');
    setStatusText('Preparing offline AI…');

    try {
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

  const finishRecording = useCallback(() => {
    const capture = captureRef.current;
    if (!capture) return;

    captureRef.current = null;
    clearRecordingTimer();
    setVoiceState('processing');
    setStatusText('Finishing recording…');

    capture.processor.onaudioprocess = null;
    capture.source.disconnect();
    capture.processor.disconnect();
    capture.silentGain.disconnect();
    void capture.context.close().catch(() => undefined);
    stopStream();

    const recordedAudio = concatenateAudioChunks(capture.chunks);
    if (recordedAudio.length === 0) {
      setVoiceState('error');
      setStatusText('The recording was empty. Try again.');
      onActivityChangeRef.current?.(false);
      return;
    }

    transcribeAudio(resampleAudio(recordedAudio, capture.sampleRate));
  }, [clearRecordingTimer, stopStream, transcribeAudio]);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      setVoiceState('error');
      setStatusText('Offline voice notes are not supported by this browser.');
      onActivityChangeRef.current?.(false);
      return;
    }

    onActivityChangeRef.current?.(true);
    setVoiceState('requesting');
    setStatusText('Requesting microphone…');

    let audioContext: AudioContext | null = null;

    try {
      audioContext = new AudioContext();
      await audioContext.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const silentGain = audioContext.createGain();
      const chunks: Float32Array[] = [];

      silentGain.gain.value = 0;
      processor.onaudioprocess = (event) => {
        chunks.push(mixChannels(event.inputBuffer));
      };
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      captureRef.current = {
        context: audioContext,
        source,
        processor,
        silentGain,
        chunks,
        sampleRate: audioContext.sampleRate,
      };

      recordingTimerRef.current = window.setTimeout(() => {
        finishRecording();
      }, MAX_RECORDING_MS);
      setVoiceState('recording');
      setStatusText('Recording… tap stop when finished. 30 seconds max.');
    } catch (error) {
      void audioContext?.close().catch(() => undefined);
      stopStream();
      setVoiceState('error');
      setStatusText(getMicrophoneErrorMessage(error));
      onActivityChangeRef.current?.(false);
    }
  }, [finishRecording, stopStream]);

  const handleClick = useCallback(() => {
    if (voiceState === 'recording') {
      finishRecording();
      return;
    }

    if (voiceState === 'idle' || voiceState === 'error') {
      void startRecording();
    }
  }, [finishRecording, startRecording, voiceState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onActivityChangeRef.current?.(false);
      const capture = captureRef.current;
      captureRef.current = null;
      if (capture) {
        capture.processor.onaudioprocess = null;
        capture.source.disconnect();
        capture.processor.disconnect();
        capture.silentGain.disconnect();
        void capture.context.close().catch(() => undefined);
      }
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
