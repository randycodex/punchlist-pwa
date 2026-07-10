import type { Project } from '@/types';

export function sanitizeOneDriveProjectFolderPart(value: string | undefined, fallback: string) {
  const cleaned = (value ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

export function getOneDriveProjectFolderName(
  project: Pick<Project, 'projectName' | 'oneDriveFolderName'>
) {
  return sanitizeOneDriveProjectFolderPart(
    project.oneDriveFolderName,
    sanitizeOneDriveProjectFolderPart(project.projectName, 'project')
  );
}

export function sanitizeExportNamePart(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/gi, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'Project';
}

export function formatDateForExport(now = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd}`;
}
