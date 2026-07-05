import type { CollaborationAreaClaim, CollaborationAreaClaimSummary } from './types';
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

function reviveAreaClaim(
  row: {
    id: string;
    project_id: string;
    area_id: string;
    claimed_by_user_id: string;
    status: CollaborationAreaClaim['status'];
    claimed_at: string;
    expires_at: string | null;
    released_at: string | null;
    transferred_to_user_id: string | null;
  }
): CollaborationAreaClaim {
  return {
    id: row.id,
    projectId: row.project_id,
    areaId: row.area_id,
    claimedByUserId: row.claimed_by_user_id,
    status: row.status,
    claimedAt: new Date(row.claimed_at),
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    releasedAt: row.released_at ? new Date(row.released_at) : undefined,
    transferredToUserId: row.transferred_to_user_id ?? undefined,
  };
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

export async function getActiveSharedProjectAreaClaims(sharedProjectId: string) {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const { data, error } = await supabase
    .from('area_claims')
    .select('id, project_id, area_id, claimed_by_user_id, status, claimed_at, expires_at, released_at, transferred_to_user_id')
    .eq('project_id', sharedProjectId)
    .eq('status', 'active');

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map(reviveAreaClaim)
    .filter((claim) => isAreaClaimActive(claim));
}

export async function getActiveSharedProjectAreaClaimSummaries(sharedProjectId: string): Promise<CollaborationAreaClaimSummary[]> {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) {
    throw new Error('Collaboration is not configured.');
  }

  const [claimsResult, membersResult] = await Promise.all([
    supabase
      .from('area_claims')
      .select('id, project_id, area_id, claimed_by_user_id, status, claimed_at, expires_at, released_at, transferred_to_user_id')
      .eq('project_id', sharedProjectId)
      .eq('status', 'active'),
    supabase
      .from('project_members')
      .select('user_id, email, display_name')
      .eq('project_id', sharedProjectId)
      .eq('access_state', 'active'),
  ]);

  if (claimsResult.error) {
    throw claimsResult.error;
  }

  if (membersResult.error) {
    throw membersResult.error;
  }

  const membersByUserId = new Map(
    (membersResult.data ?? [])
      .filter((member) => member.user_id)
      .map((member) => [
        member.user_id as string,
        {
          email: member.email,
          displayName: member.display_name ?? undefined,
        },
      ])
  );

  return (claimsResult.data ?? [])
    .map(reviveAreaClaim)
    .filter((claim) => isAreaClaimActive(claim))
    .map((claim) => {
      const member = membersByUserId.get(claim.claimedByUserId);
      return {
        ...claim,
        claimedByEmail: member?.email,
        claimedByDisplayName: member?.displayName,
      };
    });
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
