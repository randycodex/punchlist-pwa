/** Keep OAuth callbacks independent of the page's query, hash, and prior auth codes. */
export function getCollaborationOAuthRedirectUrl(currentUrl: string): string {
  return new URL('/', currentUrl).toString();
}
