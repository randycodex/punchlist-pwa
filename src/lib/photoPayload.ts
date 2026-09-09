export function createScaledImageData(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxSize: number,
  quality: number
): string | null {
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
}

export function getPhotoPayloadFromDataUrl(sourceData: string): Promise<{ imageData: string; thumbnail?: string } | null> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const sourceWidth = img.naturalWidth || img.width;
      const sourceHeight = img.naturalHeight || img.height;
      const imageData = createScaledImageData(img, sourceWidth, sourceHeight, 1280, 0.72);
      const thumbnail = createScaledImageData(img, sourceWidth, sourceHeight, 360, 0.6);
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
}

export function fileToPhotoPayload(file: File): Promise<{ imageData: string; thumbnail?: string } | null> {
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
