import { getCollaborationSupabaseClient } from './supabaseClient';

export const COLLABORATION_AVATAR_BUCKET = 'punchlist-avatars';
export const MICROSOFT_PROFILE_PHOTO_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

const AVATAR_SIGNED_URL_LIFETIME_SECONDS = 24 * 60 * 60;
const AVATAR_SIGNED_URL_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const signedAvatarUrlCache = new Map<string, { url: string; expiresAt: number }>();

export function buildCollaborationAvatarPath(userId: string) {
  return `${userId}/microsoft-profile`;
}

export function clearCollaborationAvatarUrlCache(path?: string) {
  if (path) {
    signedAvatarUrlCache.delete(path);
    return;
  }
  signedAvatarUrlCache.clear();
}

export async function getCollaborationAvatarUrl(path: string) {
  const cached = signedAvatarUrlCache.get(path);
  if (cached && cached.expiresAt - AVATAR_SIGNED_URL_REFRESH_BUFFER_MS > Date.now()) {
    return cached.url;
  }

  const supabase = getCollaborationSupabaseClient();
  if (!supabase) return undefined;

  const { data, error } = await supabase.storage
    .from(COLLABORATION_AVATAR_BUCKET)
    .createSignedUrl(path, AVATAR_SIGNED_URL_LIFETIME_SECONDS);
  if (error) throw error;

  signedAvatarUrlCache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + AVATAR_SIGNED_URL_LIFETIME_SECONDS * 1000,
  });
  return data.signedUrl;
}
