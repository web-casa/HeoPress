import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The branch preview cookie (HeoPress P10 task 4.2; spec agents/content-branches "分支预览"): signed by the CMS when a
 * browser exchanges a one-time preview link, checked by the rendering service before it asks the CMS anything, and
 * checked again by the CMS (with the grant, the branch and the creator's current permission) on every request.
 *
 * `v1.<payload>.<signature>`, base64url: the payload names the site, the grant, the branch and the expiry (Unix
 * seconds); the signature is HMAC-SHA256 under a key derived from `HEOPRESS_INTERNAL_SECRET` for this purpose only.
 * A cookie of site A presented on site B, expired, altered or signed with another key is not a preview.
 */

export const BRANCH_PREVIEW_COOKIE = 'heopress_branch_preview';
/** The exchange path on a site's public host: `/_heopress/branch-preview/<link token>`. */
export const BRANCH_PREVIEW_EXCHANGE_PREFIX = '/_heopress/branch-preview/';

export interface BranchPreviewClaims {
  siteId: string;
  grantId: string;
  versionId: string;
  /** Expiry, Unix seconds. */
  expiresAt: number;
}

const keyOf = (secret: string) => createHmac('sha256', secret).update('heopress/branch-preview-cookie/v1').digest();
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signBranchPreviewCookie(secret: string, claims: BranchPreviewClaims): string {
  const payload = b64(JSON.stringify({ s: claims.siteId, g: claims.grantId, b: claims.versionId, e: claims.expiresAt }));
  const sig = b64(createHmac('sha256', keyOf(secret)).update(`v1.${payload}`).digest());
  return `v1.${payload}.${sig}`;
}

/** The claims of a valid cookie for `siteId` at `nowMs`; null for anything else. */
export function verifyBranchPreviewCookie(secret: string, value: string | null | undefined, siteId: string, nowMs: number): BranchPreviewClaims | null {
  if (!value || value.length > 512) return null;
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return null;
  const expected = createHmac('sha256', keyOf(secret)).update(`v1.${m[1]}`).digest();
  const given = Buffer.from(m[2]!, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const p = raw as { s?: unknown; g?: unknown; b?: unknown; e?: unknown };
  if (typeof p.s !== 'string' || typeof p.g !== 'string' || typeof p.b !== 'string' || typeof p.e !== 'number') return null;
  if (p.s !== siteId || p.e * 1000 <= nowMs) return null;
  return { siteId: p.s, grantId: p.g, versionId: p.b, expiresAt: p.e };
}

/** The cookie's value from a `Cookie` header. */
export function branchPreviewCookieOf(cookieHeader: string | undefined): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === BRANCH_PREVIEW_COOKIE) return rest.join('=') || null;
  }
  return null;
}
