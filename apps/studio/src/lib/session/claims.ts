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

/**
 * Whether the token says its holder is an instance administrator (the `admin` role the server gives the bootstrap
 * account). A display hint only — for showing site settings on a site whose permissions it cannot read; the server
 * checks every request (HeoPress P07a task 12.1).
 */
export function instanceAdminClaim(token: string | null): boolean {
  const part = token?.split('.')[1];
  if (!part) return false;
  try {
    const roles = (JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { roles?: unknown }).roles;
    return Array.isArray(roles) && roles.some((r) => r === 'admin' || r === 'administrator');
  } catch {
    return false;
  }
}
