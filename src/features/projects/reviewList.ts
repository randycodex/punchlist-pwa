import { getCheckpointIssueState, type IssueState, type Project } from '@/types';
import { formatFloorLabel, getAreaFloor } from '@/lib/unitFloors';

export type ProjectReviewEntry = {
  id: string;
  kind: 'checkpoint' | 'area-note';
  areaId: string;
  checkpointId?: string;
  path: string[];
  title: string;
  comment: string;
  photoCount: number;
  fileCount: number;
  issueState: IssueState;
};

/** Metadata only: photo bodies are loaded for the one open row. */
export function buildProjectReviewList(project: Project): ProjectReviewEntry[] {
  const entries: ProjectReviewEntry[] = [];
  for (const area of [...project.areas].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (area.deletedAt || area.purgedAt) continue;
    const floor = getAreaFloor(area, project.unitFloorNumbering);
    const areaPath = floor ? [formatFloorLabel(floor), area.name] : [area.name];
    if (area.notes.trim()) {
      entries.push({
        id: `area-note:${area.id}`,
        kind: 'area-note',
        areaId: area.id,
        path: areaPath,
        title: 'Area notes',
        comment: area.notes,
        photoCount: 0,
        fileCount: 0,
        issueState: 'none',
      });
    }
    for (const location of [...area.locations].sort((a, b) => a.sortOrder - b.sortOrder)) {
      for (const item of [...location.items].sort((a, b) => a.sortOrder - b.sortOrder)) {
        for (const checkpoint of [...item.checkpoints].sort((a, b) => a.sortOrder - b.sortOrder)) {
          const issueState = getCheckpointIssueState(checkpoint);
          const photoCount = checkpoint.photos.length;
          const fileCount = checkpoint.files?.length ?? 0;
          if (!checkpoint.comments.trim() && photoCount === 0 && fileCount === 0 && issueState === 'none') continue;
          entries.push({
            id: checkpoint.id,
            kind: 'checkpoint',
            areaId: area.id,
            checkpointId: checkpoint.id,
            path: [...areaPath, location.name, item.name],
            title: checkpoint.name,
            comment: checkpoint.comments,
            photoCount,
            fileCount,
            issueState,
          });
        }
      }
    }
  }
  return entries;
}
