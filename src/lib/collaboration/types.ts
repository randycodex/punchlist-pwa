export type CollaborationRole = 'owner' | 'editor' | 'viewer';

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

export interface CollaborationProjectMember {
  projectId: string;
  userId: string;
  email: string;
  displayName?: string;
  role: CollaborationRole;
  invitedAt: Date;
  joinedAt?: Date;
  removedAt?: Date;
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
