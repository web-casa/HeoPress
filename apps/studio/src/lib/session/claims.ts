/**
 * Read the claims of a HeoPress session JWT — to file the session under its
 * user, login and site. Not a verification: the server verifies every use.
 */
export interface SessionClaims {
  userId: string;
  sid: string;
  siteId: string;
}

export function sessionClaimsOf(token: string): SessionClaims | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as Record<string, unknown>;
    const { userId, sid, siteId } = claims;
    return typeof userId === 'string' && typeof sid === 'string' && typeof siteId === 'string' ? { userId, sid, siteId } : null;
  } catch {
    return null;
  }
}
