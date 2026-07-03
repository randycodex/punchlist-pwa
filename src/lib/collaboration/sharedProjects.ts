import type { User } from '@supabase/supabase-js';
import type { Project } from '@/types';
import { getCollaborationSupabaseClient } from './supabaseClient';

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

export async function createSharedProjectFromLocalProject(
  project: Project,
  user: User,
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

  const displayName =
    memberDisplayName?.trim() ||
    (typeof user.user_metadata?.name === 'string'
      ? user.user_metadata.name
      : typeof user.user_metadata?.full_name === 'string'
        ? user.user_metadata.full_name
        : undefined);

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
