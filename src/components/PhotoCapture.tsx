'use client';
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Camera, ChevronLeft, ChevronRight, Paperclip, X, Zap, ZapOff } from 'lucide-react';
import { PhotoAttachment, FileAttachment } from '@/types';

const PHOTO_INPUT_ACCEPT = 'image/*,.heic,.heif,image/heic,image/heif';
const HEIC_EXTENSIONS = new Set(['heic', 'heif']);
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const MAX_SOURCE_PHOTO_SIZE = 25 * 1024 * 1024;

type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean | boolean[] };
type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean };

function getCameraAccessErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : '';

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera permission was blocked. Allow camera access in the browser settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found. Try Photo Library.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is already in use or could not start. Close other camera apps, refresh, then try again.';
  }
  if (name === 'AbortError') {
    return 'The camera stopped before it could start. Refresh, then try again.';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'The requested camera settings are not available. Try Photo Library.';
  }

  return 'Could not access camera. Try Photo Library.';
}

function getVideoTrack(stream: MediaStream | null) {
  return stream?.getVideoTracks()[0] ?? null;
}

function supportsTorch(stream: MediaStream | null) {
  const track = getVideoTrack(stream);
  const capabilities =
    typeof track?.getCapabilities === 'function' ? (track.getCapabilities() as TorchCapabilities) : null;
  const torch = capabilities?.torch;

  return Array.isArray(torch) ? torch.includes(true) && torch.includes(false) : torch === true;
}

async function setStreamTorch(stream: MediaStream | null, enabled: boolean) {
  const track = getVideoTrack(stream);
  if (!track || !supportsTorch(stream)) return false;

  await track.applyConstraints({
    advanced: [{ torch: enabled } as TorchConstraintSet],
  });
  return true;
}

async function configureAutoFocus(stream: MediaStream) {
  type FocusCapabilities = MediaTrackCapabilities & { focusMode?: string[] };
  type FocusConstraintSet = MediaTrackConstraintSet & { focusMode?: string };

  const [track] = stream.getVideoTracks();
  if (!track) return;

  const capabilities =
    typeof track.getCapabilities === 'function' ? (track.getCapabilities() as FocusCapabilities) : null;
  if (!capabilities) return;

  const focusMode = capabilities.focusMode;
  const advanced: FocusConstraintSet[] = [];

  if (Array.isArray(focusMode) && focusMode.includes('continuous')) {
    advanced.push({ focusMode: 'continuous' });
  } else if (Array.isArray(focusMode) && focusMode.includes('single-shot')) {
    advanced.push({ focusMode: 'single-shot' });
  }

  if (advanced.length === 0) return;

  try {
    await track.applyConstraints({ advanced });
  } catch {
    // Some mobile browsers expose focus capabilities but reject the constraint at runtime.
  }
}

interface PhotoCaptureProps {
  photos: PhotoAttachment[];
  files: FileAttachment[];
  onAddPhoto: (imageData: string, thumbnail?: string) => void | Promise<void>;
  onAddPhotos?: (photos: Array<{ imageData: string; thumbnail?: string }>) => void | Promise<void>;
  onAddFiles?: (files: Array<{ data: string; name: string; mimeType: string; size: number }>) => void | Promise<void>;
  onDeletePhoto: (photoId: string) => void;
  onDeleteFile: (fileId: string) => void;
  compactActions?: boolean;
  hideCameraButton?: boolean;
  hideLibraryButton?: boolean;
  openCameraSignal?: number;
  openLibrarySignal?: number;
}

export default function PhotoCapture({
  photos,
  files,
  onAddPhoto,
  onAddPhotos,
  onDeletePhoto,
  onDeleteFile,
  compactActions = false,
  hideCameraButton = false,
  hideLibraryButton = false,
  openCameraSignal,
  openLibrarySignal,
}: PhotoCaptureProps) {
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [viewerScale, setViewerScale] = useState(1);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStreamToken, setCameraStreamToken] = useState(0);
  const [capturedBatch, setCapturedBatch] = useState<Array<{ imageData: string; thumbnail?: string }>>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchChanging, setTorchChanging] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [capturePending, setCapturePending] = useState(false);
  const [savingPhotos, setSavingPhotos] = useState(false);
  const pinchDistanceRef = useRef<number | null>(null);
  const pinchScaleRef = useRef(1);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraSessionRef = useRef(0);
  const pendingCaptureRef = useRef(false);
  const maxImageSize = 1280;
  const thumbnailSize = 360;

  function isHeicFile(file: File) {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    return HEIC_MIME_TYPES.has(file.type.toLowerCase()) || HEIC_EXTENSIONS.has(extension);
  }

  const openPhotoPicker = useCallback(() => {
    setCameraError(null);
    cameraInputRef.current?.click();
  }, []);

  const createScaledImageData = useCallback((
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    maxSize: number,
    quality: number
  ): string | null => {
    const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', quality);
    } catch {
      return null;
    } finally {
      // Release the backing store promptly on memory-constrained mobile browsers.
      canvas.width = 0;
      canvas.height = 0;
    }
  }, []);

  const getPhotoPayloadFromDataUrl = useCallback((sourceData: string): Promise<{ imageData: string; thumbnail?: string } | null> => {
    return new Promise((resolve) => {
      const img = new window.Image();
      img.onload = () => {
        const sourceWidth = img.naturalWidth || img.width;
        const sourceHeight = img.naturalHeight || img.height;
        const imageData = createScaledImageData(img, sourceWidth, sourceHeight, maxImageSize, 0.72);
        const thumbnail = createScaledImageData(img, sourceWidth, sourceHeight, thumbnailSize, 0.6);
        img.onload = null;
        img.onerror = null;
        img.src = '';
        resolve(imageData && thumbnail ? { imageData, thumbnail } : null);
      };
      img.onerror = () => {
        img.onload = null;
        img.onerror = null;
        resolve(null);
      };
      img.src = sourceData;
    });
  }, [createScaledImageData]);

  const stopCameraStream = useCallback(() => {
    const stream = streamRef.current;
    if (videoRef.current) {
      videoRef.current.pause();
      if (!stream || videoRef.current.srcObject === stream) {
        videoRef.current.srcObject = null;
      }
    }
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const openCamera = useCallback(async () => {
    const sessionId = cameraSessionRef.current + 1;
    cameraSessionRef.current = sessionId;
    stopCameraStream();

    flushSync(() => {
      setCameraError(null);
      setTorchSupported(false);
      setTorchOn(false);
      setTorchChanging(false);
      setVideoReady(false);
      setCapturePending(false);
      setCapturedBatch([]);
      setCameraOpen(true);
    });
    pendingCaptureRef.current = false;

    let requestTimer: number | null = window.setTimeout(() => {
      if (cameraSessionRef.current === sessionId && !streamRef.current) {
        setCameraError('Camera is taking too long to start. Try Photo Library.');
      }
    }, 12_000);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException('Camera API is not available.', 'NotFoundError');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      if (cameraSessionRef.current !== sessionId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      setTorchSupported(supportsTorch(stream));
      setTorchOn(false);
      setCameraStreamToken((token) => token + 1);
      void configureAutoFocus(stream);
    } catch (error) {
      if (cameraSessionRef.current === sessionId) {
        setVideoReady(false);
        setTorchSupported(false);
        setTorchOn(false);
        setCameraError(getCameraAccessErrorMessage(error));
      }
    } finally {
      if (requestTimer) {
        window.clearTimeout(requestTimer);
        requestTimer = null;
      }
    }
  }, [stopCameraStream]);

  function closeCamera(discard = false) {
    cameraSessionRef.current += 1;
    stopCameraStream();
    setCameraOpen(false);
    setVideoReady(false);
    setCapturePending(false);
    setTorchSupported(false);
    setTorchOn(false);
    setTorchChanging(false);
    setCameraStreamToken((token) => token + 1);
    pendingCaptureRef.current = false;
    if (discard) {
      setCapturedBatch([]);
    }
  }

  function openDeviceCameraFallback() {
    cameraSessionRef.current += 1;
    stopCameraStream();
    setCameraOpen(false);
    setVideoReady(false);
    setCapturePending(false);
    setTorchSupported(false);
    setTorchOn(false);
    setTorchChanging(false);
    setCameraStreamToken((token) => token + 1);
    pendingCaptureRef.current = false;
    setCapturedBatch([]);
    setCameraError(null);
    cameraInputRef.current?.click();
  }

  async function toggleTorch() {
    if (torchChanging) return;

    const nextTorchState = !torchOn;
    setTorchChanging(true);
    try {
      const changed = await setStreamTorch(streamRef.current, nextTorchState);
      if (!changed) {
        setTorchSupported(false);
        setTorchOn(false);
        setCameraError('Flash is not available on this camera.');
        return;
      }
      setTorchOn(nextTorchState);
      setCameraError(null);
    } catch {
      setTorchSupported(false);
      setTorchOn(false);
      setCameraError('Flash is not available on this camera.');
    } finally {
      setTorchChanging(false);
    }
  }

  const captureFrameFromVideo = useCallback((video: HTMLVideoElement) => {
    if (!video.videoWidth || !video.videoHeight) {
      return false;
    }

    pendingCaptureRef.current = true;
    setCapturePending(true);
    const imageData = createScaledImageData(
      video,
      video.videoWidth,
      video.videoHeight,
      maxImageSize,
      0.72
    );
    const thumbnail = createScaledImageData(
      video,
      video.videoWidth,
      video.videoHeight,
      thumbnailSize,
      0.6
    );
    pendingCaptureRef.current = false;
    setCapturePending(false);

    if (!imageData || !thumbnail) {
      setCameraError('Could not process this photo. Try again or use Photo Library.');
      return true;
    }

    setCameraError(null);
    setCapturedBatch((prev) => [...prev, { imageData, thumbnail }]);
    return true;
  }, [createScaledImageData]);

  function captureFromVideo() {
    const video = videoRef.current;
    if (!video || !videoReady || !captureFrameFromVideo(video)) {
      pendingCaptureRef.current = true;
      setCapturePending(true);
      setCameraError(null);
    }
  }

  function resetViewer() {
    setSelectedPhoto(null);
    setViewerScale(1);
    pinchDistanceRef.current = null;
    pinchScaleRef.current = 1;
    swipeStartRef.current = null;
  }

  const selectedPhotoIndex = selectedPhoto
    ? photos.findIndex((photo) => photo.imageData === selectedPhoto)
    : -1;

  function showPhotoAt(index: number) {
    const photo = photos[index];
    if (!photo) return;
    setSelectedPhoto(photo.imageData);
    setViewerScale(1);
    pinchDistanceRef.current = null;
    pinchScaleRef.current = 1;
    swipeStartRef.current = null;
  }

  function showAdjacentPhoto(direction: -1 | 1) {
    if (selectedPhotoIndex < 0 || photos.length < 2) return;
    const nextIndex = (selectedPhotoIndex + direction + photos.length) % photos.length;
    showPhotoAt(nextIndex);
  }

  function getTouchDistance(touches: React.TouchList) {
    if (touches.length < 2) return null;
    const [first, second] = [touches[0], touches[1]];
    return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
  }

  function handleViewerTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    const distance = getTouchDistance(event.touches);
    if (distance === null) {
      const touch = event.touches[0];
      swipeStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
      return;
    }
    swipeStartRef.current = null;
    pinchDistanceRef.current = distance;
    pinchScaleRef.current = viewerScale;
  }

  function handleViewerTouchMove(event: React.TouchEvent<HTMLDivElement>) {
    const distance = getTouchDistance(event.touches);
    if (distance === null || pinchDistanceRef.current === null) return;
    event.preventDefault();
    const nextScale = pinchScaleRef.current * (distance / pinchDistanceRef.current);
    setViewerScale(Math.min(4, Math.max(1, nextScale)));
  }

  function handleViewerTouchEnd(event: React.TouchEvent<HTMLDivElement>) {
    if (event.touches.length >= 2) {
      const distance = getTouchDistance(event.touches);
      if (distance !== null) {
        pinchDistanceRef.current = distance;
        pinchScaleRef.current = viewerScale;
      }
      return;
    }
    pinchDistanceRef.current = null;

    const start = swipeStartRef.current;
    const touch = event.changedTouches[0];
    swipeStartRef.current = null;
    if (!start || !touch || viewerScale > 1) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) < 50 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    showAdjacentPhoto(deltaX < 0 ? 1 : -1);
  }

  async function addCapturedBatch() {
    if (capturedBatch.length === 0) return;
    setSavingPhotos(true);
    try {
      if (onAddPhotos) {
        await onAddPhotos(capturedBatch);
      } else {
        for (const photo of capturedBatch) {
          await onAddPhoto(photo.imageData, photo.thumbnail);
        }
      }
      closeCamera(true);
    } finally {
      setSavingPhotos(false);
    }
  }

  function fileToPhotoPayload(file: File): Promise<{ imageData: string; thumbnail?: string } | null> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const sourceData = event.target?.result;
        if (typeof sourceData !== 'string') {
          resolve(null);
          return;
        }
        void getPhotoPayloadFromDataUrl(sourceData).then(resolve, () => resolve(null));
      };
      reader.onerror = () => resolve(null);
      reader.onabort = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  async function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(e.target.files ?? []);
    if (selectedFiles.length === 0) return;
    const selected = selectedFiles.filter((file) => file.size <= MAX_SOURCE_PHOTO_SIZE);
    const oversizedCount = selectedFiles.length - selected.length;

    setCameraError(null);
    setSavingPhotos(true);
    try {
      // Decode and resize one source at a time. Concurrent 12–25 MB phone photos
      // can otherwise multiply canvas and base64 memory until Safari kills the tab.
      const processed: Array<{ imageData: string; thumbnail?: string } | null> = [];
      for (const file of selected) {
        processed.push(await fileToPhotoPayload(file));
      }
      const readyPhotos = processed.filter((photo): photo is { imageData: string; thumbnail?: string } => photo !== null);
      const failedHeicCount = selected.filter((file, index) => processed[index] === null && isHeicFile(file)).length;
      const failedOtherCount = processed.length - readyPhotos.length - failedHeicCount;

      if (readyPhotos.length > 0) {
        if (onAddPhotos) {
          await onAddPhotos(readyPhotos);
        } else {
          for (const photo of readyPhotos) {
            await onAddPhoto(photo.imageData, photo.thumbnail);
          }
        }
      }
      const errors: string[] = [];
      if (oversizedCount > 0) {
        errors.push('Use photos under 25 MB.');
      }
      if (failedHeicCount > 0) {
        errors.push('Could not read one or more HEIC/HEIF photos. Try opening the photo and sharing it as a JPEG if it does not attach.');
      } else if (failedOtherCount > 0) {
        errors.push('Could not read one or more selected photos.');
      }
      if (errors.length > 0) {
        setCameraError(errors.join(' '));
      }
    } catch (error) {
      console.error('Failed to add selected photos:', error);
      setCameraError('Could not save the selected photos. Your existing inspection data is unchanged.');
    } finally {
      setSavingPhotos(false);
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
  }

  useEffect(() => {
    if (!cameraOpen || !videoRef.current) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!stream) return;
    let cancelled = false;
    let ready = false;
    let readinessTimer: number | null = null;
    let startupTimer: number | null = window.setTimeout(() => {
      if (!cancelled && !ready) {
        setCameraError('Camera is taking too long to start. Try Photo Library.');
      }
    }, 12_000);

    function clearStartupTimer() {
      if (!startupTimer) return;
      window.clearTimeout(startupTimer);
      startupTimer = null;
    }

    function clearReadinessTimer() {
      if (!readinessTimer) return;
      window.clearInterval(readinessTimer);
      readinessTimer = null;
    }

    function markVideoReady() {
      if (cancelled || ready || video.videoWidth === 0 || video.videoHeight === 0) return;
      ready = true;
      clearStartupTimer();
      clearReadinessTimer();
      setCameraError(null);
      setVideoReady(true);
      if (pendingCaptureRef.current) {
        captureFrameFromVideo(video);
      }
    }

    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    setVideoReady(false);

    async function playPreview() {
      if (cancelled) return;
      try {
        await video.play();
        markVideoReady();
      } catch {
        clearStartupTimer();
        if (!cancelled) {
          setVideoReady(false);
          setCameraError('Camera preview failed to start. Try Photo Library.');
        }
      }
    }

    function handleVideoReady() {
      markVideoReady();
    }

    video.addEventListener('loadedmetadata', handleVideoReady);
    video.addEventListener('loadeddata', handleVideoReady);
    video.addEventListener('canplay', handleVideoReady);
    void playPreview();
    readinessTimer = window.setInterval(markVideoReady, 200);

    return () => {
      cancelled = true;
      clearStartupTimer();
      clearReadinessTimer();
      video.removeEventListener('loadedmetadata', handleVideoReady);
      video.removeEventListener('loadeddata', handleVideoReady);
      video.removeEventListener('canplay', handleVideoReady);
    };
  }, [cameraOpen, cameraStreamToken, captureFrameFromVideo]);

  useEffect(() => {
    return () => {
      cameraSessionRef.current += 1;
      pendingCaptureRef.current = false;
      stopCameraStream();
    };
  }, [stopCameraStream]);

  useEffect(() => {
    if (!openCameraSignal) return;
    void openCamera();
  }, [openCameraSignal, openCamera]);

  useEffect(() => {
    if (!openLibrarySignal) return;
    openPhotoPicker();
  }, [openLibrarySignal, openPhotoPicker]);

  return (
    <div className="space-y-3">
      {photos.length > 0 && (
        <div className="-mx-1 overflow-x-auto pb-1">
          <div className={`flex gap-2 px-1 ${compactActions ? '' : 'sm:gap-2.5'}`}>
          {photos.map((photo) => (
            <div
              key={photo.id}
              className={`group relative shrink-0 overflow-hidden bg-gray-100 dark:bg-zinc-900 ${
                compactActions ? 'h-16 w-16 rounded-xl' : 'h-24 w-24 rounded-[1.1rem] sm:h-28 sm:w-28'
              }`}
              onClick={() => {
                setSelectedPhoto(photo.imageData);
                setViewerScale(1);
              }}
            >
              <img
                src={photo.thumbnail || photo.imageData}
                alt="Checkpoint photo"
                className="w-full h-full object-cover"
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDeletePhoto(photo.id);
                }}
                className={`absolute flex items-center justify-center rounded-full bg-black/55 text-white transition ${
                  compactActions ? 'right-1 top-1 h-5 w-5' : 'right-1.5 top-1.5 h-6 w-6'
                }`}
              >
                <X className={compactActions ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
              </button>
            </div>
          ))}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file) => (
            <div
              key={file.id}
              className={`flex items-center gap-2 rounded-full bg-gray-100 text-xs dark:bg-zinc-900 ${compactActions ? 'pr-1 pl-2 py-1.5' : 'border border-gray-200 dark:border-zinc-700 px-3 py-2'}`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <a
                  href={file.data}
                  download={file.name}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-gray-700 underline-offset-2 hover:underline dark:text-gray-300"
                  onClick={(e) => e.stopPropagation()}
                >
                  {file.name}
                </a>
              </div>
              <button
                onClick={() => onDeleteFile(file.id)}
                className={`flex items-center justify-center rounded-full text-gray-400 transition hover:bg-black/[0.04] hover:text-[var(--accent)] dark:hover:bg-white/[0.06] ${compactActions ? 'h-5 w-5' : 'ml-2 h-7 w-7'}`}
                aria-label={`Delete ${file.name}`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={`flex items-center gap-3 ${hideCameraButton ? 'justify-end' : ''}`}>
        {!hideCameraButton && (
          <button
            onClick={() => void openCamera()}
            disabled={savingPhotos}
            className={`flex items-center justify-center rounded-[1rem] bg-gray-100 text-gray-700 transition hover:bg-gray-200 dark:bg-zinc-800 dark:text-gray-100 dark:hover:bg-zinc-700 ${
              compactActions ? 'h-10 w-10' : 'h-11 w-11'
            }`}
            aria-label="Take multiple photos"
          >
            <Camera className={compactActions ? 'h-4 w-4' : 'h-4.5 w-4.5'} />
          </button>
        )}
        {!hideLibraryButton && (
          <button
            onClick={openPhotoPicker}
            disabled={savingPhotos}
            className={`flex items-center justify-center rounded-[1rem] bg-gray-100 text-gray-700 transition hover:bg-gray-200 dark:bg-zinc-800 dark:text-gray-100 dark:hover:bg-zinc-700 ${
              compactActions ? 'h-10 w-10' : 'h-11 w-11'
            }`}
            aria-label="Open photo library"
          >
            <Paperclip className={compactActions ? 'h-4 w-4' : 'h-4.5 w-4.5'} />
          </button>
        )}
        <input
          ref={cameraInputRef}
          type="file"
          accept={PHOTO_INPUT_ACCEPT}
          multiple
          onChange={handlePhotoSelect}
          disabled={savingPhotos}
          className="hidden"
        />
      </div>
      {cameraError && <p className="text-xs text-gray-500 dark:text-gray-400">{cameraError}</p>}

      {cameraOpen && (
        <div
          data-inspection-inline-action="true"
          className="fixed inset-0 z-50 overflow-hidden bg-black"
          onClick={(event) => event.stopPropagation()}
        >
          <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 h-full w-full object-cover" />

          <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pb-4 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
            <button
              onClick={() => closeCamera(true)}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm"
              aria-label="Close camera"
            >
              <X className="h-5 w-5" />
            </button>
            {torchSupported ? (
              <button
                onClick={() => void toggleTorch()}
                disabled={torchChanging}
                className={`flex h-10 w-10 items-center justify-center rounded-full backdrop-blur-sm transition disabled:opacity-55 ${
                  torchOn ? 'bg-white text-gray-950' : 'bg-black/40 text-white'
                }`}
                aria-label={torchOn ? 'Turn flash off' : 'Turn flash on'}
                title={torchOn ? 'Turn flash off' : 'Turn flash on'}
              >
                {torchOn ? <ZapOff className="h-5 w-5" /> : <Zap className="h-5 w-5" />}
              </button>
            ) : (
              <div className="h-10 w-10" />
            )}
          </div>

          <div className="absolute inset-x-0 bottom-0 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-6">
            <div className="grid grid-cols-[64px_1fr_64px] items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center">
                {capturedBatch.length > 0 ? (
                  <button
                    onClick={() => {
                      const latest = capturedBatch[capturedBatch.length - 1];
                      setSelectedPhoto(latest.imageData);
                      setViewerScale(1);
                    }}
                    className="h-14 w-14 overflow-hidden rounded-[1rem] bg-white/10 backdrop-blur-sm"
                    aria-label="Open last captured photo"
                  >
                    <img
                      src={capturedBatch[capturedBatch.length - 1]?.thumbnail || capturedBatch[capturedBatch.length - 1]?.imageData}
                      alt="Last captured photo"
                      className="h-full w-full object-cover"
                    />
                  </button>
                ) : null}
              </div>

              <div className="flex items-center justify-center">
                <button
                  onClick={captureFromVideo}
                  disabled={savingPhotos || capturePending}
                  className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-white bg-white/20 shadow-[0_0_0_1px_rgba(255,255,255,0.34)] backdrop-blur-sm transition active:scale-95 disabled:opacity-55"
                  aria-label="Capture photo"
                >
                  <span className="h-14 w-14 rounded-full bg-white shadow-[inset_0_0_0_1px_rgba(15,23,42,0.08)]" />
                </button>
              </div>

              <div className="flex h-16 w-16 items-center justify-center">
                {capturedBatch.length > 0 ? (
                  <button
                    onClick={() => {
                      void addCapturedBatch();
                    }}
                    disabled={savingPhotos}
                    className="rounded-full bg-white px-4 py-2 text-sm font-medium text-gray-900"
                  >
                    {savingPhotos ? 'Saving...' : 'Done'}
                  </button>
                ) : null}
              </div>
            </div>
            <p className="mt-3 text-center text-xs text-white/65">
              {cameraError
                ? cameraError
                : capturePending
                ? 'Capturing as soon as the camera is ready...'
                : !videoReady
                ? 'Starting camera...'
                : capturedBatch.length > 0
                ? `${capturedBatch.length} photo${capturedBatch.length === 1 ? '' : 's'} ready`
                : 'Take as many photos as needed, then tap Done.'}
            </p>
            {cameraError && (
              <div className="mt-3 flex justify-center">
                <button
                  onClick={openDeviceCameraFallback}
                  className="rounded-full bg-white px-4 py-2 text-sm font-medium text-gray-900"
                >
                  Photo Library
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Full photo viewer */}
      {selectedPhoto && (
        <div
          data-inspection-inline-action="true"
          className="fixed inset-0 z-50 bg-black/95"
          onClick={(event) => {
            event.stopPropagation();
            resetViewer();
          }}
        >
          <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
            <button
              onClick={(event) => {
                event.stopPropagation();
                resetViewer();
              }}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white"
              aria-label="Close photo viewer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {selectedPhotoIndex >= 0 && photos.length > 1 && (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  showAdjacentPhoto(-1);
                }}
                className="absolute left-3 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm"
                aria-label="Previous photo"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  showAdjacentPhoto(1);
                }}
                className="absolute right-3 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm"
                aria-label="Next photo"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
              <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-10 text-center text-sm text-white/75">
                {selectedPhotoIndex + 1} / {photos.length}
              </div>
            </>
          )}
          <div
            className="h-full overflow-auto p-6"
            onClick={(event) => event.stopPropagation()}
            onTouchStart={handleViewerTouchStart}
            onTouchMove={handleViewerTouchMove}
            onTouchEnd={handleViewerTouchEnd}
            onTouchCancel={handleViewerTouchEnd}
          >
            <div className="flex min-h-full items-center justify-center">
              <img
                src={selectedPhoto}
                alt="Full size"
                className="rounded-2xl object-contain"
                style={{
                  width: viewerScale === 1 ? 'auto' : `${viewerScale * 100}vw`,
                  maxWidth: viewerScale === 1 ? '100%' : 'none',
                  maxHeight: viewerScale === 1 ? '88vh' : 'none',
                  touchAction: 'none',
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
