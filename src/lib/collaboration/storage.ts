export const COLLABORATION_ATTACHMENT_BUCKET = 'punchlist-attachments';

function sanitizePathPart(value: string) {
  return value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'attachment';
}

export function buildCollaborationAttachmentPath(input: {
  projectId: string;
  attachmentId: string;
  fileName: string;
}) {
  const safeFileName = sanitizePathPart(input.fileName);
  return `${input.projectId}/${input.attachmentId}/${safeFileName}`;
}
