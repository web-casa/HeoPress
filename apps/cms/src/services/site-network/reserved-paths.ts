import { eq } from 'drizzle-orm';
import { systemState } from '@heopress/database';
import { isSystemPathSegment } from '@heopress/public-site';
import type { SiteTransaction } from '../rls-transaction';

/** Top-level paths no content path and no language prefix may take (routes of this instance and its public surface). */
const RESERVED_TOP_LEVEL_PATHS = new Set([
  'api', 'admin', 'internal', 'assets', 'media', 'static', 'uploads', 'files', 'health', 'metrics',
  'sitemap.xml', 'robots.txt', 'feed', 'rss', 'llms.txt', 'favicon.ico', 'well-known', '.well-known',
]);

/**
 * Whether a first path segment is reserved (design B): the fixed set above, anything starting
 * with `_` (internal routes), the first segment of the instance's admin path, and the public site's
 * own discovery and root-file names (HeoPress P07 task 1.5, `isSystemPathSegment`).
 */
export function isReservedSegment(segment: string, adminSegment: string | null): boolean {
  const s = segment.toLowerCase();
  return (
    RESERVED_TOP_LEVEL_PATHS.has(s) || s.startsWith('_') || isSystemPathSegment(s) || (adminSegment !== null && s === adminSegment.toLowerCase())
  );
}

/** The first segment of the admin path the operator chose at setup (null before setup). */
export async function readAdminSegment(tx: SiteTransaction): Promise<string | null> {
  const [row] = await tx.select({ adminPath: systemState.adminPath }).from(systemState).where(eq(systemState.id, 'singleton'));
  const first = row?.adminPath?.replace(/^\/+/, '').split('/')[0];
  return first ? first : null;
}
