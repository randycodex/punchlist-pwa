import type { CollaborationAreaClaim } from './types';

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
