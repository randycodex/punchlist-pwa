const SHARED_PROJECT_JOIN_PARAM = 'join';

export function buildSharedProjectInviteUrl(joinCode: string, origin: string): string {
  const inviteUrl = new URL('/', origin);
  inviteUrl.searchParams.set(SHARED_PROJECT_JOIN_PARAM, joinCode.trim().toUpperCase());
  return inviteUrl.toString();
}

export function getSharedProjectJoinCodeFromSearch(search: string): string | null {
  const code = new URLSearchParams(search).get(SHARED_PROJECT_JOIN_PARAM)?.trim().toUpperCase();
  return code || null;
}
