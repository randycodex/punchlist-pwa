export type CollaborationAccessState = 'invited' | 'active' | 'removed';

export type CollaborationJoinMethod = 'emailInvite' | 'joinCode';

export interface CollaborationUserProfile {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CollaborationUserProfileInput = Pick<
  CollaborationUserProfile,
  'username' | 'firstName' | 'lastName' | 'jobTitle'
>;

export type CollaborationEntityType =
  | 'project'
  | 'area'
  | 'location'
  | 'item'
  | 'checkpoint'
  | 'photoAttachment'
  | 'fileAttachment';

export type CollaborationMutationAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'attach'
  | 'detach';

export type CollaborationMutationStatus =
  | 'queued'
  | 'sending'
  | 'accepted'
  | 'rejected'
  | 'conflicted';

export type CollaborationAreaClaimStatus =
  | 'active'
  | 'released'
  | 'transferred'
  | 'expired';

export interface CollaborationSharedProject {
  projectId: string;
  ownerUserId: string;
  createdByUserId: string;
  joinCode?: string;
  joinCodeExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CollaborationSharedProjectDirectoryEntry {
  projectId: string;
  projectName: string;
  ownerUserId: string;
  ownerEmail?: string;
  joinedAt?: Date;
  publishedAt?: Date;
  updatedAt: Date;
}

export interface CollaborationProjectMember {
  projectId: string;
  userId: string;
  email: string;
  displayName?: string;
  isOwner?: boolean;
  accessState: CollaborationAccessState;
  joinedBy: CollaborationJoinMethod;
  invitedByUserId?: string;
  invitedAt: Date;
  joinedAt?: Date;
  removedAt?: Date;
}

export type CollaborationSnapshotBackupReason =
  | 'publish'
  | 'before_publish'
  | 'before_pull'
  | 'manual'
  | 'restore';

export interface CollaborationSnapshotBackup {
  id: string;
  projectId: string;
  projectName: string;
  capturedByUserId: string;
  capturedAt: Date;
  reason: CollaborationSnapshotBackupReason;
  note?: string;
}

export interface CollaborationOwnershipTransfer {
  id: string;
  projectId: string;
  fromUserId: string;
  toUserId: string;
  transferredAt: Date;
}

export interface CollaborationAreaClaim {
  id: string;
  projectId: string;
  areaId: string;
  claimedByUserId: string;
  status: CollaborationAreaClaimStatus;
  claimedAt: Date;
  expiresAt?: Date;
  releasedAt?: Date;
  transferredToUserId?: string;
}

export interface CollaborationAreaClaimSummary extends CollaborationAreaClaim {
  claimedByEmail?: string;
  claimedByDisplayName?: string;
}

export interface CollaborationMutation {
  id: string;
  projectId: string;
  entityType: CollaborationEntityType;
  entityId: string;
  parentEntityId?: string;
  action: CollaborationMutationAction;
  patch: Record<string, unknown>;
  baseVersion?: number;
  authorUserId: string;
  clientId: string;
  status: CollaborationMutationStatus;
  createdAt: Date;
  sentAt?: Date;
  acceptedAt?: Date;
  rejectedAt?: Date;
  errorMessage?: string;
}

export interface CollaborationPresence {
  projectId: string;
  userId: string;
  displayName?: string;
  activeEntityType?: CollaborationEntityType;
  activeEntityId?: string;
  lastSeenAt: Date;
}
