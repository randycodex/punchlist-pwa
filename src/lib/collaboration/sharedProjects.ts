import type { Project } from '@/types';
import type { Json } from './database';
import { getCollaborationSupabaseClient } from './supabaseClient';

type JoinCodeResult = {
  joinCode: string;
  expiresAt: string;
};

type JoinedSharedProjectResult = {
  sharedProjectId: string;
  projectName: string;
};

export function getCollaborationErrorMessage(error: unknown, fallback = 'Failed to share project. Please try again.') {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === 'object') {
    const maybeError = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [maybeError.message, maybeError.details, maybeError.hint, maybeError.code]
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

export async function createSharedProjectFromLocalProject(
  project: Project,
  memberEmail: string,
  memberDisplayName?: string | null
) {
  if (project.sharedProjectId) {
    return project.sharedProjectId;
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const email = memberEmail.trim().toLowerCase();
  if (!email) {
    throw new Error('Your Microsoft account does not include an email address.');
  }

  const displayName = memberDisplayName?.trim() || undefined;

  const { data: existingProject, error: existingProjectError } = await supabase
    .from('shared_projects')
    .select('id')
    .eq('local_project_id', project.id)
    .maybeSingle();

  if (existingProjectError) {
    throw existingProjectError;
  }

  let sharedProjectId = existingProject?.id;

  if (!sharedProjectId) {
    const { data: createdProjectId, error: projectError } = await supabase
      .rpc('create_shared_project', {
        p_local_project_id: project.id,
        p_project_name: project.projectName,
        p_owner_email: email,
        p_owner_display_name: displayName ?? null,
      });

    if (projectError) {
      throw projectError;
    }

    sharedProjectId = createdProjectId;
  }

  if (!sharedProjectId) {
    throw new Error('Unable to create shared project.');
  }

  return sharedProjectId;
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

export async function joinSharedProjectByCode(
  joinCode: string,
  memberEmail: string,
  memberDisplayName?: string | null
): Promise<JoinedSharedProjectResult> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase.rpc('join_shared_project_by_code', {
    p_join_code: joinCode,
    p_member_email: memberEmail,
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
