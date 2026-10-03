// Matches the existing photo-source and elevation picker limits.
export const MAX_SHARED_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export type SharedAttachmentKind = 'photo' | 'drawing' | 'file';
const DRAWING_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

export function validateSharedAttachmentUpload(input: {
  kind: SharedAttachmentKind;
  mimeType: string;
  sizeBytes: number;
}) {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new Error('Shared attachment is empty or has an invalid size. Restore its content before syncing.');
  }
  if (input.sizeBytes > MAX_SHARED_ATTACHMENT_BYTES) {
    throw new Error('Shared attachments must be 25 MiB or smaller. Resize or replace this attachment before syncing.');
  }
  const mime = input.mimeType.toLowerCase();
  // Generic files can come from imported backups. Do not silently narrow that
  // supported format to PDF, or accept header parameters as a MIME type.
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    || (input.kind === 'photo' && !mime.startsWith('image/'))
    || (input.kind === 'drawing' && !DRAWING_MIME_TYPES.has(mime))) {
    throw new Error(`Unsupported ${input.kind} attachment type: ${input.mimeType}. Replace this attachment before syncing.`);
  }
}
