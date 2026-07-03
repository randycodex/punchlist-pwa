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
    const { data: createdProject, error: projectError } = await supabase
      .from('shared_projects')
      .insert({
        local_project_id: project.id,
        project_name: project.projectName,
        owner_user_id: user.id,
        created_by_user_id: user.id,
      })
      .select('id')
      .single();

    if (projectError) {
      throw projectError;
    }

    sharedProjectId = createdProject?.id;
  }

  if (!sharedProjectId) {
    throw new Error('Unable to create shared project.');
  }

  const { error: memberError } = await supabase
    .from('project_members')
    .insert({
      project_id: sharedProjectId,
      user_id: user.id,
      email,
      display_name: displayName,
      access_state: 'active',
      joined_by: 'emailInvite',
      joined_at: new Date().toISOString(),
    });

  if (memberError && memberError.code !== '23505') {
    throw memberError;
  }

  return sharedProjectId;
}
