import type { User } from '@supabase/supabase-js';
import type { Project } from '@/types';
import { getCollaborationSupabaseClient } from './supabaseClient';

export async function createSharedProjectFromLocalProject(project: Project, user: User) {
  if (project.sharedProjectId) {
    return project.sharedProjectId;
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const email = user.email?.trim().toLowerCase();
  if (!email) {
    throw new Error('Your shared-project account does not include an email address.');
  }

  const displayName =
    typeof user.user_metadata?.name === 'string'
      ? user.user_metadata.name
      : typeof user.user_metadata?.full_name === 'string'
        ? user.user_metadata.full_name
        : undefined;

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
