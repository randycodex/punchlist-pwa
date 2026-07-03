import type { CollaborationAreaClaim } from './types';
import type { Json } from './database';
import { getCollaborationRuntimeConfig } from './config';
import { getCollaborationSupabaseClient } from './supabaseClient';

export function isAreaClaimActive(
  claim: Pick<CollaborationAreaClaim, 'status' | 'expiresAt'>,
  now = new Date()
) {
  if (claim.status !== 'active') return false;
  if (!claim.expiresAt) return true;
  return claim.expiresAt.getTime() > now.getTime();
}

export function canUserEditClaimedArea(
  claim: Pick<CollaborationAreaClaim, 'claimedByUserId' | 'status' | 'expiresAt'> | null | undefined,
  userId: string,
  now = new Date()
) {
  if (!claim) return true;
  if (!isAreaClaimActive(claim, now)) return true;
  return claim.claimedByUserId === userId;
}

export function getAreaClaimExpiry(claimTimeoutMs: number, now = new Date()) {
  return new Date(now.getTime() + claimTimeoutMs);
}

function getStringFromJsonObject(value: Json, key: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const entry = value[key];
  return typeof entry === 'string' ? entry : null;
}

export async function claimSharedProjectArea(sharedProjectId: string, areaId: string) {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const config = getCollaborationRuntimeConfig();
  const expiresAt = getAreaClaimExpiry(config?.areaClaimTimeoutMs ?? 4 * 60 * 60 * 1000);
  const { data, error } = await supabase.rpc('claim_shared_project_area', {
    p_project_id: sharedProjectId,
    p_area_id: areaId,
    p_expires_at: expiresAt.toISOString(),
  });

  if (error) {
    throw error;
  }

  const claimId = getStringFromJsonObject(data, 'id');
  const claimedByUserId = getStringFromJsonObject(data, 'claimed_by_user_id');
  if (!claimId || !claimedByUserId) {
    throw new Error('Unable to claim this shared area.');
  }

  return {
    id: claimId,
    projectId: sharedProjectId,
    areaId,
    claimedByUserId,
    status: 'active' as const,
    expiresAt,
  };
}

export async function releaseSharedProjectArea(sharedProjectId: string, areaId: string) {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    return;
  }

  const { error } = await supabase.rpc('release_shared_project_area', {
    p_project_id: sharedProjectId,
    p_area_id: areaId,
  });

  if (error) {
    throw error;
  }
}
