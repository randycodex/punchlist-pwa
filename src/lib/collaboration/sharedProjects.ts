import type { Project } from '@/types';
import type { Json } from './database';
import type { CollaborationProjectMember, CollaborationSharedProjectDirectoryEntry } from './types';
import { getCollaborationSupabaseClient } from './supabaseClient';
import { collaborationEmailsMatch, normalizeCollaborationEmail } from './config';

type JoinCodeResult = {
  joinCode: string;
  expiresAt: string;
};

type JoinedSharedProjectResult = {
  sharedProjectId: string;
  projectName: string;
};

type OwnershipTransferResult = {
  projectId: string;
  ownerUserId: string;
  ownerEmail: string;
};

type DisconnectSharedProjectResult = {
  action: 'archived' | 'left';
  projectId: string;
};

export type SharedProjectAccess = {
  isActiveMember: boolean;
  isOwner: boolean;
};

async function requireMatchingCollaborationIdentity(
  expectedEmail: string,
  fallbackMessage: string
) {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;

  if (!data.user?.email || !collaborationEmailsMatch(data.user.email, expectedEmail)) {
    throw new Error(fallbackMessage);
  }

  return supabase;
}

export function getCollaborationErrorMessage(error: unknown, fallback = 'Failed to share project. Please try again.') {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object') {
    const maybeError = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
    if (
      typeof maybeError.message === 'string'
      && maybeError.message.toLowerCase().includes('statement timeout')
    ) {
      return 'The shared database took too long to process this project. Please try again.';
    }
    if (
      typeof maybeError.message === 'string'
      && maybeError.message.startsWith('CollaborationRequestTimeoutError:')
    ) {
      return maybeError.message.replace(/^CollaborationRequestTimeoutError:\s*/, '');
    }
    if (typeof maybeError.code === 'string' && maybeError.code.startsWith('23')) {
      return fallback;
    }
    const parts = [maybeError.message, maybeError.details, maybeError.hint]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);

    if (parts.length > 0) {
      return parts.join(' ');
    }
  }

  return fallback;
}

function getStringFromJsonObject(value: Json, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const entry = value[key];
  return typeof entry === 'string' ? entry : null;
}

function reviveProjectMember(
  row: {
    project_id: string;
    user_id: string | null;
    email: string;
    display_name: string | null;
    access_state: CollaborationProjectMember['accessState'];
    joined_by: CollaborationProjectMember['joinedBy'];
    invited_by_user_id: string | null;
    invited_at: string;
    joined_at: string | null;
    removed_at: string | null;
  },
  ownerUserId?: string | null
): CollaborationProjectMember {
  return {
    projectId: row.project_id,
    userId: row.user_id ?? '',
    email: row.email,
    displayName: row.display_name ?? undefined,
    isOwner: !!row.user_id && row.user_id === ownerUserId,
    accessState: row.access_state,
    joinedBy: row.joined_by,
    invitedByUserId: row.invited_by_user_id ?? undefined,
    invitedAt: new Date(row.invited_at),
    joinedAt: row.joined_at ? new Date(row.joined_at) : undefined,
    removedAt: row.removed_at ? new Date(row.removed_at) : undefined,
  };
}

export async function createSharedProjectFromLocalProject(
  project: Project,
  memberEmail: string,
  memberDisplayName?: string | null
) {
  if (project.sharedProjectId) {
    return project.sharedProjectId;
  }

  const email = normalizeCollaborationEmail(memberEmail) ?? '';
  if (!email) {
    throw new Error('Your Microsoft account does not include an email address.');
  }

  const supabase = await requireMatchingCollaborationIdentity(
    email,
    'Your Microsoft and shared-project accounts do not match. Re-enable shared projects with the same account.'
  );

  const displayName = memberDisplayName?.trim() || undefined;

  const { data: sharedProjectId, error: projectError } = await supabase
    .rpc('create_shared_project', {
      p_local_project_id: project.id,
      p_project_name: project.projectName,
      p_owner_email: email,
      p_owner_display_name: displayName ?? null,
    });

  if (projectError) {
    throw projectError;
  }

  if (!sharedProjectId) {
    throw new Error('Unable to create shared project.');
  }

  return sharedProjectId;
}

export async function listMySharedProjects(): Promise<CollaborationSharedProjectDirectoryEntry[]> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase.rpc('list_my_shared_projects');

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    ownerUserId: row.owner_user_id,
    ownerEmail: row.owner_email ?? undefined,
    joinedAt: row.joined_at ? new Date(row.joined_at) : undefined,
    publishedAt: row.published_at ? new Date(row.published_at) : undefined,
    updatedAt: new Date(row.updated_at),
  }));
}

export async function generateSharedProjectJoinCode(sharedProjectId: string): Promise<JoinCodeResult> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase.rpc('generate_shared_project_join_code', {
    p_project_id: sharedProjectId,
  });

  if (error) {
    throw error;
  }

  const joinCode = getStringFromJsonObject(data, 'join_code');
  const expiresAt = getStringFromJsonObject(data, 'expires_at');
  if (!joinCode || !expiresAt) {
    throw new Error('Unable to create a shared project code.');
  }

  return { joinCode, expiresAt };
}

export async function getSharedProjectMembers(sharedProjectId: string): Promise<CollaborationProjectMember[]> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data: projectRow, error: projectError } = await supabase
    .from('shared_projects')
    .select('owner_user_id')
    .eq('id', sharedProjectId)
    .maybeSingle();

  if (projectError) {
    throw projectError;
  }

  const { data, error } = await supabase
    .from('project_members')
    .select('project_id, user_id, email, display_name, access_state, joined_by, invited_by_user_id, invited_at, joined_at, removed_at')
    .eq('project_id', sharedProjectId)
    .neq('access_state', 'removed')
    .order('email', { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => reviveProjectMember(row, projectRow?.owner_user_id));
}

export async function getSharedProjectAccess(
  sharedProjectId: string,
  signedInUserId?: string
): Promise<SharedProjectAccess> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  let userId = signedInUserId;
  if (!userId) {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    userId = userData.user?.id;
  }
  if (!userId) {
    return { isActiveMember: false, isOwner: false };
  }

  const projects = await listMySharedProjects();
  const project = projects.find((entry) => entry.projectId === sharedProjectId);

  return {
    isActiveMember: !!project,
    isOwner: project?.ownerUserId === userId,
  };
}

export async function joinSharedProjectByCode(
  joinCode: string,
  memberEmail: string,
  memberDisplayName?: string | null
): Promise<JoinedSharedProjectResult> {
  const email = normalizeCollaborationEmail(memberEmail) ?? '';
  const supabase = await requireMatchingCollaborationIdentity(
    email,
    'Your Microsoft and shared-project accounts do not match. Re-enable shared projects with the same account.'
  );

  const { data, error } = await supabase.rpc('join_shared_project_by_code', {
    p_join_code: joinCode,
    p_member_email: email,
    p_member_display_name: memberDisplayName ?? null,
  });

  if (error) {
    throw error;
  }

  const sharedProjectId = getStringFromJsonObject(data, 'shared_project_id');
  const projectName = getStringFromJsonObject(data, 'project_name');
  if (!sharedProjectId || !projectName) {
    throw new Error('Unable to join shared project.');
  }

  return { sharedProjectId, projectName };
}

export async function transferSharedProjectOwnership(
  sharedProjectId: string,
  newOwnerEmail: string
): Promise<OwnershipTransferResult> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const email = newOwnerEmail.trim().toLowerCase();
  if (!email) {
    throw new Error('Enter the email for the new owner.');
  }

  const { data, error } = await supabase.rpc('transfer_shared_project_ownership', {
    p_project_id: sharedProjectId,
    p_new_owner_email: email,
  });

  if (error) {
    throw error;
  }

  const projectId = getStringFromJsonObject(data, 'project_id');
  const ownerUserId = getStringFromJsonObject(data, 'owner_user_id');
  const ownerEmail = getStringFromJsonObject(data, 'owner_email');
  if (!projectId || !ownerUserId || !ownerEmail) {
    throw new Error('Ownership transfer did not return the new owner.');
  }

  return { projectId, ownerUserId, ownerEmail };
}

export async function disconnectSharedProject(sharedProjectId: string): Promise<DisconnectSharedProjectResult> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase.rpc('disconnect_shared_project', {
    p_project_id: sharedProjectId,
  });

  if (error) {
    throw error;
  }

  const action = getStringFromJsonObject(data, 'action');
  const projectId = getStringFromJsonObject(data, 'project_id');
  if ((action !== 'archived' && action !== 'left') || !projectId) {
    throw new Error('Shared project disconnect did not return a valid result.');
  }

  return { action, projectId };
}
