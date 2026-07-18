export type CheckpointStatus = 'pending' | 'ok' | 'needsReview';
export type FixStatus = 'pending' | 'fixed' | 'verified';
export type IssueState = 'none' | 'open' | 'resolved' | 'verified';

export interface PhotoAttachment {
  id: string;
  checkpointId: string;
  imageData: string; // Base64 encoded
  thumbnail?: string; // Legacy optional thumbnail
  createdAt: Date;
}

export interface FileAttachment {
  id: string;
  checkpointId: string;
  name: string;
  mimeType: string;
  size: number;
  data: string; // Base64 encoded
  createdAt: Date;
}

export interface ElevationMarker {
  drawingId: string;
  xPercent: number;
  yPercent: number;
}

export interface Checkpoint {
  id: string;
  itemId: string;
  name: string;
  isCustom?: boolean;
  isElevationIssue?: boolean;
  sourceCheckpointId?: string;
  status: CheckpointStatus;
  fixStatus: FixStatus;
  issueState?: IssueState;
  comments: string;
  sortOrder: number;
  photos: PhotoAttachment[];
  files: FileAttachment[];
  elevationMarker?: ElevationMarker;
  createdAt: Date;
  updatedAt: Date;
}

export function getCheckpointIssueState(checkpoint: Pick<Checkpoint, 'status' | 'fixStatus' | 'issueState'>): IssueState {
  if (checkpoint.issueState) {
    return checkpoint.issueState;
  }
  if (checkpoint.status !== 'needsReview') {
    return 'none';
  }
  if (checkpoint.fixStatus === 'verified') {
    return 'verified';
  }
  if (checkpoint.fixStatus === 'fixed') {
    return 'resolved';
  }
  return 'open';
}

export function checkpointHasIssue(checkpoint: Pick<Checkpoint, 'status' | 'fixStatus' | 'issueState'>) {
  return getCheckpointIssueState(checkpoint) !== 'none';
}

export function isCheckpointReviewed(checkpoint: Pick<Checkpoint, 'status' | 'fixStatus' | 'issueState'>) {
  return checkpoint.status === 'ok' || checkpointHasIssue(checkpoint);
}

export function isAreaInspectionComplete(area: Pick<Area, 'locations'>) {
  let total = 0;

  for (const location of area.locations) {
    for (const item of location.items) {
      for (const checkpoint of item.checkpoints) {
        total += 1;
        if (!isCheckpointReviewed(checkpoint)) {
          return false;
        }
      }
    }
  }

  return total > 0;
}

export interface Item {
  id: string;
  locationId: string;
  name: string;
  isCustom?: boolean;
  sortOrder: number;
  checkpoints: Checkpoint[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Location {
  id: string;
  areaId: string;
  name: string;
  isCustom?: boolean;
  sectionLabel?: string;
  sortOrder: number;
  items: Item[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Area {
  id: string;
  projectId: string;
  sharedVersion?: number;
  sharedPublishedAt?: Date;
  name: string;
  areaTypeKey?: string;
  unitType?: string;
  customAreaName?: string;
  areaNumber?: string;
  facadeLevel?: string;
  elevationDrawingId?: string;
  sortOrder: number;
  isComplete: boolean;
  notes: string;
  locations: Location[];
  deletedAt?: Date;
  purgedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FacadeElevationDrawing {
  id: string;
  orientation: string;
  name: string;
  fileName: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  sharedProjectId?: string;
  sharedProjectLinkedAt?: Date;
  sharedSnapshotPublishedAt?: Date;
  sharedBaselinePublishedAt?: Date;
  sharedMetadataVersion?: number;
  sharedMetadataPublishedAt?: Date;
  detachedSharedProjectId?: string;
  detachedSharedProjectAt?: Date;
  detachedSharedSnapshotPublishedAt?: Date;
  projectName: string;
  oneDriveFolderName?: string;
  address: string;
  date: Date;
  inspector: string;
  gcName: string;
  gcSignoff: string;
  facadeLevelStart?: number;
  facadeLevelEnd?: number;
  facadeElevationDrawings?: FacadeElevationDrawing[];
  deletedAt?: Date;
  areas: Area[];
  createdAt: Date;
  updatedAt: Date;
}

// Helper functions for calculating stats
export function getAreaStats(area: Area) {
  let total = 0;
  let ok = 0;
  let issues = 0;

  for (const location of area.locations) {
    for (const item of location.items) {
      for (const checkpoint of item.checkpoints) {
        total += 1;
        if (checkpoint.status === 'ok') ok += 1;
        else if (checkpointHasIssue(checkpoint)) issues += 1;
      }
    }
  }

  return {
    total,
    ok,
    issues,
  };
}

export function getReviewMetrics(total: number, ok: number, issues: number) {
  const pending = Math.max(total - ok - issues, 0);
  const reviewed = ok + issues;
  const reviewedPercent = total > 0 ? (reviewed / total) * 100 : 0;
  const okPercent = reviewed > 0 ? (ok / reviewed) * 100 : 0;
  const issuePercent = reviewed > 0 ? (issues / reviewed) * 100 : 0;

  return {
    pending,
    reviewed,
    reviewedPercent,
    okPercent,
    issuePercent,
  };
}

export function getLocationStats(location: Location) {
  let total = 0;
  let ok = 0;
  let issues = 0;

  for (const item of location.items) {
    for (const checkpoint of item.checkpoints) {
      total += 1;
      if (checkpoint.status === 'ok') ok += 1;
      else if (checkpointHasIssue(checkpoint)) issues += 1;
    }
  }

  return {
    total,
    ok,
    issues,
  };
}

export function getItemStats(item: Item) {
  let total = 0;
  let ok = 0;
  let issues = 0;

  for (const checkpoint of item.checkpoints) {
    total += 1;
    if (checkpoint.status === 'ok') ok += 1;
    else if (checkpointHasIssue(checkpoint)) issues += 1;
  }

  return {
    total,
    ok,
    issues,
  };
}

export function getProjectStats(project: Project) {
  let total = 0;
  let ok = 0;
  let issues = 0;
  let activeAreaCount = 0;

  for (const area of project.areas) {
    if (area.deletedAt) continue;
    activeAreaCount += 1;
    for (const location of area.locations) {
      for (const item of location.items) {
        for (const checkpoint of item.checkpoints) {
          total += 1;
          if (checkpoint.status === 'ok') ok += 1;
          else if (checkpointHasIssue(checkpoint)) issues += 1;
        }
      }
    }
  }

  return {
    total,
    ok,
    issues,
    areas: activeAreaCount,
  };
}
