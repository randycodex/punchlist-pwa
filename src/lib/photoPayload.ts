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
      resolve(imageData ? { imageData, ...(thumbnail ? { thumbnail } : {}) } : null);
    };
    img.onerror = () => {
      img.onload = null;
      img.onerror = null;
      resolve(null);
    };
    img.src = sourceData;
  });
}

export async function fileToPhotoPayload(file: File): Promise<{ imageData: string; thumbnail?: string } | null> {
  // Decode the file directly without creating a second, base64 copy of the source.
  // This also avoids relying on a missing or incorrect file MIME type.
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file);
      const imageData = createScaledImageData(bitmap, bitmap.width, bitmap.height, 1280, 0.72);
      const thumbnail = createScaledImageData(bitmap, bitmap.width, bitmap.height, 360, 0.6);
      if (imageData) return { imageData, ...(thumbnail ? { thumbnail } : {}) };
    } catch {
      // Some browser/format combinations need the image-element decoder below.
    } finally {
      bitmap?.close();
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await getPhotoPayloadFromDataUrl(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
