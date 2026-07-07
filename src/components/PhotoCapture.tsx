'use client';
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Paperclip, X } from 'lucide-react';
import { PhotoAttachment, FileAttachment } from '@/types';

const PHOTO_INPUT_ACCEPT = 'image/*,.heic,.heif,image/heic,image/heif';
const HEIC_EXTENSIONS = new Set(['heic', 'heif']);
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif']);
const MAX_SOURCE_PHOTO_SIZE = 25 * 1024 * 1024;
const MAX_FILE_ATTACHMENT_SIZE = 25 * 1024 * 1024;

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
  openCameraSignal?: number;
}

export default function PhotoCapture({
  photos,
  files,
  onAddPhoto,
  onAddPhotos,
  onAddFiles,
  onDeletePhoto,
  onDeleteFile,
  compactActions = false,
  hideCameraButton = false,
  openCameraSignal,
}: PhotoCaptureProps) {
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [viewerScale, setViewerScale] = useState(1);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStreamToken, setCameraStreamToken] = useState(0);
  const [capturedBatch, setCapturedBatch] = useState<Array<{ imageData: string; thumbnail?: string }>>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [savingPhotos, setSavingPhotos] = useState(false);
  const [savingFiles, setSavingFiles] = useState(false);
  const [showPhotoSourceSheet, setShowPhotoSourceSheet] = useState(false);
  const pinchDistanceRef = useRef<number | null>(null);
  const pinchScaleRef = useRef(1);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraSessionRef = useRef(0);
  const maxImageSize = 1280;
  const thumbnailSize = 360;

  function isHeicFile(file: File) {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    return HEIC_MIME_TYPES.has(file.type.toLowerCase()) || HEIC_EXTENSIONS.has(extension);
  }

  const openPhotoPicker = useCallback(() => {
    setCameraError(null);
    setShowPhotoSourceSheet(false);
    cameraInputRef.current?.click();
  }, []);

  const openPhotoOptions = useCallback(() => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      openPhotoPicker();
      return;
    }
    setShowPhotoSourceSheet(true);
  }, [openPhotoPicker]);

  function createScaledImageData(img: HTMLImageElement, maxSize: number, quality: number) {
    const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return img.src;
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', quality);
  }

  function getPhotoPayloadFromDataUrl(sourceData: string): Promise<{ imageData: string; thumbnail?: string } | null> {
    return new Promise((resolve) => {
      const img = new window.Image();
      img.onload = () => {
        const imageData = createScaledImageData(img, maxImageSize, 0.72);
        const thumbnail = createScaledImageData(img, thumbnailSize, 0.6);
        resolve({ imageData, thumbnail });
      };
      img.onerror = () => resolve(null);
      img.src = sourceData;
    });
  }

  function stopCameraStream() {
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
  }

  const requestCameraStream = useCallback(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(new Error('Camera unavailable'));
    }
    return navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
      },
      audio: false,
    });
  }, []);

  async function beginCameraStartup(sessionId: number) {
    let requestTimer: number | null = window.setTimeout(() => {
      if (cameraSessionRef.current === sessionId && !streamRef.current) {
        setCameraError('Camera is taking too long to start. Try Device Camera or Library.');
      }
    }, 12_000);

    try {
      const stream = await requestCameraStream();
      if (cameraSessionRef.current !== sessionId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      setCameraStreamToken((token) => token + 1);
    } catch {
      if (cameraSessionRef.current === sessionId) {
        setVideoReady(false);
        setCameraError('Could not access camera. Try Device Camera or Library.');
      }
    } finally {
      if (requestTimer) {
        window.clearTimeout(requestTimer);
        requestTimer = null;
      }
    }
  }

  function openCamera() {
    const sessionId = cameraSessionRef.current + 1;
    cameraSessionRef.current = sessionId;
    setCameraError(null);
    setShowPhotoSourceSheet(false);
    setVideoReady(false);
    setCapturedBatch([]);
    stopCameraStream();
    setCameraOpen(true);
    void beginCameraStartup(sessionId);
  }

  function closeCamera(discard = false) {
    cameraSessionRef.current += 1;
    stopCameraStream();
    setCameraOpen(false);
    setVideoReady(false);
    if (discard) {
      setCapturedBatch([]);
    }
  }

  function openDeviceCameraFallback() {
    cameraSessionRef.current += 1;
    stopCameraStream();
    setCameraOpen(false);
    setVideoReady(false);
    setCapturedBatch([]);
    setCameraError(null);
    setShowPhotoSourceSheet(false);
    cameraInputRef.current?.click();
  }

  function captureFromVideo() {
    if (!videoRef.current || !videoReady) {
      setCameraError('Camera is still starting. Try again in a moment.');
      return;
    }
    const video = videoRef.current;
    if (!video.videoWidth || !video.videoHeight) {
      setCameraError('Camera is still starting. Try again in a moment.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const frameData = canvas.toDataURL('image/jpeg', 0.92);
    void getPhotoPayloadFromDataUrl(frameData).then((payload) => {
      if (!payload) return;
      setCapturedBatch((prev) => [...prev, payload]);
    });
  }

  function resetViewer() {
    setSelectedPhoto(null);
    setViewerScale(1);
    pinchDistanceRef.current = null;
    pinchScaleRef.current = 1;
  }

  function getTouchDistance(touches: React.TouchList) {
    if (touches.length < 2) return null;
    const [first, second] = [touches[0], touches[1]];
    return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
  }

  function handleViewerTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    const distance = getTouchDistance(event.touches);
    if (distance === null) return;
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
    pinchScaleRef.current = viewerScale;
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
        const sourceData = event.target?.result as string;
        void getPhotoPayloadFromDataUrl(sourceData).then(resolve);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  function fileToAttachmentPayload(file: File): Promise<{ data: string; name: string; mimeType: string; size: number } | null> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const data = event.target?.result;
        if (typeof data !== 'string') {
          resolve(null);
          return;
        }
        resolve({
          data,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
        });
      };
      reader.onerror = () => resolve(null);
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
    const processed: Array<{ imageData: string; thumbnail?: string } | null> = [];
    for (const file of selected) {
      processed.push(await fileToPhotoPayload(file));
    }
    const readyPhotos = processed.filter((photo): photo is { imageData: string; thumbnail?: string } => photo !== null);
    const failedHeicCount = selected.filter((file, index) => processed[index] === null && isHeicFile(file)).length;
    const failedOtherCount = processed.length - readyPhotos.length - failedHeicCount;
    try {
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
    } finally {
      setSavingPhotos(false);
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (!onAddFiles) return;
    const selectedFiles = Array.from(e.target.files ?? []);
    if (selectedFiles.length === 0) return;
    const selected = selectedFiles.filter((file) => file.size <= MAX_FILE_ATTACHMENT_SIZE);
    const oversizedCount = selectedFiles.length - selected.length;

    setCameraError(null);
    setSavingFiles(true);
    const processed: Array<{ data: string; name: string; mimeType: string; size: number } | null> = [];
    for (const file of selected) {
      processed.push(await fileToAttachmentPayload(file));
    }
    const readyFiles = processed.filter(
      (file): file is { data: string; name: string; mimeType: string; size: number } => file !== null
    );
    try {
      if (readyFiles.length > 0) {
        await onAddFiles(readyFiles);
      }
      const errors: string[] = [];
      if (oversizedCount > 0) {
        errors.push('Use files under 25 MB.');
      }
      if (readyFiles.length < selected.length) {
        errors.push('Could not read one or more selected files.');
      }
      if (errors.length > 0) {
        setCameraError(errors.join(' '));
      }
    } finally {
      setSavingFiles(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
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
        setCameraError('Camera is taking too long to start. Try Device Camera or Library.');
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
          setCameraError('Camera preview failed to start. Try Device Camera or Library.');
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
  }, [cameraOpen, cameraStreamToken]);

  useEffect(() => {
    return () => {
      stopCameraStream();
    };
  }, []);

  useEffect(() => {
    if (!openCameraSignal) return;
    openPhotoOptions();
  }, [openCameraSignal, openPhotoOptions]);

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

      <div className="flex items-center gap-3">
        {!hideCameraButton && (
          <button
            onClick={openPhotoOptions}
            disabled={savingPhotos || savingFiles}
            className={`flex items-center justify-center rounded-[1rem] bg-gray-100 text-gray-700 transition hover:bg-gray-200 dark:bg-zinc-800 dark:text-gray-100 dark:hover:bg-zinc-700 ${
              compactActions ? 'h-10 w-10' : 'h-11 w-11'
            }`}
            aria-label="Add photos"
          >
            <Camera className={compactActions ? 'h-4 w-4' : 'h-4.5 w-4.5'} />
          </button>
        )}
        {onAddFiles && (
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={savingPhotos || savingFiles}
            className={`flex items-center justify-center rounded-[1rem] bg-gray-100 text-gray-700 transition hover:bg-gray-200 dark:bg-zinc-800 dark:text-gray-100 dark:hover:bg-zinc-700 ${
              compactActions ? 'h-10 w-10' : 'h-11 w-11'
            }`}
            aria-label="Attach files"
          >
            <Paperclip className={compactActions ? 'h-4 w-4' : 'h-4.5 w-4.5'} />
          </button>
        )}
        {cameraError && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{cameraError}</p>}
        <input
          ref={cameraInputRef}
          type="file"
          accept={PHOTO_INPUT_ACCEPT}
          multiple
          onChange={handlePhotoSelect}
          disabled={savingPhotos}
          className="hidden"
        />
        {onAddFiles && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            disabled={savingFiles}
            className="hidden"
          />
        )}
      </div>

      {showPhotoSourceSheet && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <div className="modal-panel overflow-hidden rounded-[1.8rem] p-2">
              <div className="px-4 pb-2 pt-3 text-center">
                <div className="text-sm font-semibold text-gray-900 dark:text-white">Add Photos</div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Use multi-photo mode for a batch, or device camera/library if focus is better there.
                </div>
              </div>
              <button
                onClick={() => void openCamera()}
                className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] font-medium text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
              >
                Take Multiple Photos
              </button>
              <button
                onClick={openPhotoPicker}
                className="w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
              >
                Device Camera or Library
              </button>
              <button
                onClick={() => setShowPhotoSourceSheet(false)}
                className="mt-1 w-full rounded-[1.1rem] px-4 py-3 text-center text-[17px] text-gray-900 transition hover:bg-black/[0.04] dark:text-white dark:hover:bg-white/[0.05]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {cameraOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black">
          <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 h-full w-full object-cover" />

          <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pb-4 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
            <button
              onClick={() => closeCamera(true)}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm"
              aria-label="Close camera"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="h-10 w-10" />
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
                  disabled={savingPhotos || !videoReady}
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
                  Device Camera or Library
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Full photo viewer */}
      {selectedPhoto && (
        <div
          className="fixed inset-0 z-50 bg-black/95"
          onClick={resetViewer}
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
