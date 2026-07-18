import type { CollaborationUserProfile, CollaborationUserProfileInput } from './types';
import { fetchMicrosoftProfilePhoto } from '@/lib/microsoftProfilePhoto';
import {
  buildCollaborationAvatarPath,
  clearCollaborationAvatarUrlCache,
  COLLABORATION_AVATAR_BUCKET,
  getCollaborationAvatarUrl,
} from './profileAvatars';
import { getCollaborationSupabaseClient } from './supabaseClient';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,29}$/;

function reviveUserProfile(row: {
  user_id: string;
  username: string;
  first_name: string;
  last_name: string;
  job_title: string;
  avatar_path: string | null;
  avatar_synced_at: string | null;
  created_at: string;
  updated_at: string;
}): CollaborationUserProfile {
  return {
    userId: row.user_id,
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    jobTitle: row.job_title,
    avatarPath: row.avatar_path ?? undefined,
    avatarSyncedAt: row.avatar_synced_at ? new Date(row.avatar_synced_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

async function addProfileAvatarUrl(profile: CollaborationUserProfile) {
  if (!profile.avatarPath) return profile;

  try {
    return {
      ...profile,
      avatarUrl: await getCollaborationAvatarUrl(profile.avatarPath),
    };
  } catch (error) {
    console.info('Profile avatar is temporarily unavailable:', error);
    return profile;
  }
}

export function getCollaborationProfileDisplayName(
  profile?: Pick<CollaborationUserProfile, 'firstName' | 'lastName'> | null
) {
  return [profile?.firstName.trim(), profile?.lastName.trim()].filter(Boolean).join(' ');
}

export function getCollaborationProfileInitials(
  profile?: Pick<CollaborationUserProfile, 'firstName' | 'lastName'> | null
) {
  const firstInitial = profile?.firstName.trim().charAt(0) ?? '';
  const lastInitial = profile?.lastName.trim().charAt(0) ?? '';
  return `${firstInitial}${lastInitial}`.toUpperCase();
}

export async function getMyCollaborationProfile(): Promise<CollaborationUserProfile | null> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) return null;

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) return null;

  const { data, error } = await supabase
    .from('user_profiles')
    .select('user_id, username, first_name, last_name, job_title, avatar_path, avatar_synced_at, created_at, updated_at')
    .eq('user_id', authData.user.id)
    .maybeSingle();

  if (error) throw error;
  return data ? addProfileAvatarUrl(reviveUserProfile(data)) : null;
}

export async function saveMyCollaborationProfile(
  input: CollaborationUserProfileInput
): Promise<CollaborationUserProfile> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const username = input.username.trim().toLowerCase();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const jobTitle = input.jobTitle.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error('Username must be 3–30 characters using letters, numbers, periods, underscores, or hyphens.');
  }
  if (!firstName || !lastName || !jobTitle) {
    throw new Error('First name, last name, and job title are required.');
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) throw new Error('Sign in before saving your profile.');

  const { data, error } = await supabase
    .from('user_profiles')
    .upsert(
      {
        user_id: authData.user.id,
        username,
        first_name: firstName,
        last_name: lastName,
        job_title: jobTitle,
      },
      { onConflict: 'user_id' }
    )
    .select('user_id, username, first_name, last_name, job_title, avatar_path, avatar_synced_at, created_at, updated_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error('That username is already in use.');
    }
    throw error;
  }
  return addProfileAvatarUrl(reviveUserProfile(data));
}

export async function syncMyMicrosoftProfilePhoto(
  accessToken: string
): Promise<CollaborationUserProfile> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) throw new Error('Sign in before syncing your profile photo.');

  const userId = authData.user.id;
  const avatarPath = buildCollaborationAvatarPath(userId);
  const photo = await fetchMicrosoftProfilePhoto(accessToken);
  const avatarSyncedAt = new Date().toISOString();

  if (photo) {
    const { error: uploadError } = await supabase.storage
      .from(COLLABORATION_AVATAR_BUCKET)
      .upload(avatarPath, photo, {
        cacheControl: '3600',
        contentType: photo.type,
        upsert: true,
      });
    if (uploadError) throw uploadError;
    clearCollaborationAvatarUrlCache(avatarPath);
  }

  const { data, error } = await supabase
    .from('user_profiles')
    .update({
      avatar_path: photo ? avatarPath : null,
      avatar_synced_at: avatarSyncedAt,
    })
    .eq('user_id', userId)
    .select('user_id, username, first_name, last_name, job_title, avatar_path, avatar_synced_at, created_at, updated_at')
    .single();

  if (error) throw error;

  if (!photo) {
    clearCollaborationAvatarUrlCache(avatarPath);
    const { error: removeError } = await supabase.storage
      .from(COLLABORATION_AVATAR_BUCKET)
      .remove([avatarPath]);
    if (removeError) {
      console.info('Old Microsoft profile photo could not be removed:', removeError);
    }
  }

  return addProfileAvatarUrl(reviveUserProfile(data));
}
