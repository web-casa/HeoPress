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
import { and, eq } from 'drizzle-orm';
import { siteDomains, type Database } from '@heopress/database';
import type { PublicHostResolution } from '@heopress/public-site';

export type { PublicHostResolution } from '@heopress/public-site';

export async function resolvePublicHost(db: Database, host: string): Promise<PublicHostResolution | null> {
  const [row] = await db
    .select()
    .from(siteDomains)
    .where(and(eq(siteDomains.hostname, host), eq(siteDomains.status, 'active')))
    .limit(1);
  if (!row) return null;
  const [primary] = row.isPrimary
    ? [row]
    : await db
        .select({ hostname: siteDomains.hostname })
        .from(siteDomains)
        .where(and(eq(siteDomains.siteId, row.siteId), eq(siteDomains.isPrimary, true), eq(siteDomains.status, 'active')))
        .limit(1);
  return {
    siteId: row.siteId,
    hostname: row.hostname,
    isPrimary: row.isPrimary,
    entryLocale: row.entryLocale ?? null,
    primaryHostname: primary?.hostname ?? null,
  };
}
