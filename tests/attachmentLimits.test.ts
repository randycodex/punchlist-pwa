import { describe, expect, it } from 'vitest';
import { MAX_SHARED_ATTACHMENT_BYTES, validateSharedAttachmentUpload } from '@/lib/collaboration/attachmentLimits';

describe('shared attachment upload limits', () => {
  it('allows exactly 25 MiB and rejects one byte more', () => {
    expect(() => validateSharedAttachmentUpload({ kind: 'drawing', mimeType: 'application/pdf', sizeBytes: MAX_SHARED_ATTACHMENT_BYTES })).not.toThrow();
    expect(() => validateSharedAttachmentUpload({ kind: 'drawing', mimeType: 'application/pdf', sizeBytes: MAX_SHARED_ATTACHMENT_BYTES + 1 })).toThrow('25 MiB');
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid or empty sizes: %s', (sizeBytes) => {
    expect(() => validateSharedAttachmentUpload({ kind: 'photo', mimeType: 'image/jpeg', sizeBytes })).toThrow();
  });
  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'image/gif'])('allows photo workflows: %s', (mimeType) => {
    expect(() => validateSharedAttachmentUpload({ kind: 'photo', mimeType, sizeBytes: 100 })).not.toThrow();
  });
  it('rejects nonimages as photos and unsupported elevations', () => {
    expect(() => validateSharedAttachmentUpload({ kind: 'photo', mimeType: 'text/html', sizeBytes: 100 })).toThrow('Unsupported');
    expect(() => validateSharedAttachmentUpload({ kind: 'drawing', mimeType: 'image/heic', sizeBytes: 100 })).toThrow('Unsupported');
  });
  it('preserves generic imported files while rejecting malformed MIME', () => {
    expect(() => validateSharedAttachmentUpload({ kind: 'file', mimeType: 'application/octet-stream', sizeBytes: 100 })).not.toThrow();
    expect(() => validateSharedAttachmentUpload({ kind: 'file', mimeType: 'text/plain; charset=utf-8', sizeBytes: 100 })).toThrow('Unsupported');
  });
});
