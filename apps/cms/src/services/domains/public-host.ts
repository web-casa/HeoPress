/**
 * Public host → site (HeoPress P04, spec sites/domain-routing "主域名规范化",
 * "域名归属与可信 Host"), for the rendering layer (P06).
 *
 * - Only an **active** domain resolves; an unknown, pending or disabled host
 *   resolves to nothing — there is no fallback to a default site.
 * - The host is the request's `Host`; `X-Forwarded-Host` counts only from a
 *   trusted proxy (middleware/public-site.ts), so a client cannot point the
 *   request at another site with a header.
 * - A plain alias (active, not primary, not a language entry) answers 301 to
 *   the primary domain with the same path and query. A language entry keeps
 *   its own host and carries its locale.
 */
import { eq } from 'drizzle-orm';
import { publicHosts, type Database } from '@heopress/database';
import type { PublicHostResolution } from '@heopress/public-site';

export type { PublicHostResolution } from '@heopress/public-site';

/**
 * Read from the public projection's hosts (`lumibase_public_hosts`: the active domains, each with its site's primary
 * one), kept in step with the domains in their own transaction: the site is not known yet, and the domains themselves
 * are site-isolated (HeoPress P14); the hosts table is the registry's pre-site lookup.
 */
export async function resolvePublicHost(db: Database, host: string): Promise<PublicHostResolution | null> {
  const [row] = await db.select().from(publicHosts).where(eq(publicHosts.hostname, host)).limit(1);
  if (!row) return null;
  return {
    siteId: row.siteId,
    hostname: row.hostname,
    isPrimary: row.isPrimary,
    entryLocale: row.entryLocale ?? null,
    primaryHostname: row.isPrimary ? row.hostname : (row.primaryHostname ?? null),
  };
}
