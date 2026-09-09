import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileToPhotoPayload } from '@/lib/photoPayload';

afterEach(() => vi.unstubAllGlobals());
function canvas() {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => 'data:image/jpeg;base64,AA==' }) });
}
describe('photo file decoding', () => {
  it('decodes a JPG directly and releases the bitmap', async () => {
    canvas();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 4000, height: 3000, close }));
    const file = new File(['jpg'], 'photo.jpg', { type: '' });
    expect(await fileToPhotoPayload(file)).toMatchObject({ imageData: 'data:image/jpeg;base64,AA==' });
    expect(close).toHaveBeenCalledOnce();
  });
  it('falls back to the image decoder and releases its object URL', async () => {
    canvas();
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('Decode failed')));
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL });
    vi.stubGlobal('window', { Image: class {
      naturalWidth = 100; naturalHeight = 100;
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
    } });
    expect(await fileToPhotoPayload(new File(['jpg'], 'photo.jpg'))).not.toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });
});
