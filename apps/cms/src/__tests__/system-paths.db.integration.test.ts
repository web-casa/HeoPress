import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { contentRoutes, items, type Database } from '@heopress/database';
import { isSystemPathSegment } from '@heopress/public-site';
import { ItemService } from '../services/item-service';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * The public site's own top-level paths (HeoPress P07 task 1.5): the CMS refuses content paths that start
 * with one; the database mirror used by the upgrade check agrees with the shared rule; content that already
 * took such a path stops the upgrade with a report instead of silently disappearing.
 */

const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const SAMPLES = [
  'robots.txt', 'sitemap.xml', 'sitemap-2.xml', 'sitemap.txt', 'news-sitemap.xml', 'llms.txt', 'llms-full.txt', 'feed', 'feed.xml', 'feed-articles.xml',
  'rss', 'atom.xml', 'Atom', '.well-known', 'well-known', 'ads.txt', 'google0123456789.html', 'site.webmanifest', 'favicon.ico', '_ext', '_EXT',
  'news', 'about', 'feedback', 'feeding-tips', 'rsvp', 'atomic-habits', 'sitemaps-explained', '2026', 'v1.2-release', 'llms', 'robots', 'readme.md', '_extras', 'ext',
];

describe.skipIf(!hasDbIntegrationUrl)('system paths — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;

  beforeAll(async () => {
    db = await connectDbIntegration('system-paths');
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'syspath', jwtSecret: 'system-paths-secret' });
    await upgradeSitePreset(db, fx.sites.a);
    await rebuildSiteProjection(db, fx.sites.a);
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
  });

  it('the database mirror and the shared rule agree', async () => {
    for (const segment of SAMPLES) {
      const [row] = (await db.execute(sql`SELECT public.heopress_is_system_path(${segment}) AS v`)) as unknown as Array<{ v: boolean }>;
      expect(row?.v, segment).toBe(isSystemPathSegment(segment));
    }
  });

  it('a content path cannot start with one: the item is refused with PATH_RESERVED', async () => {
    const articles = new ItemService({ db, siteId: fx.sites.a });
    for (const slug of ['atom', 'rss-latest', 'feed']) {
      const err = (await articles
        .create('pages', { data: { title: `Page ${slug}`, slug, locale: 'en' }, status: 'published' })
        .catch((e: unknown) => e)) as { code?: string };
      expect(err?.code, slug).toBe('PATH_RESERVED');
    }
    // An ordinary neighbour is fine.
    await expect(articles.create('pages', { data: { title: 'Atomic', slug: 'atomic-habits', locale: 'en' }, status: 'published' })).resolves.toBeDefined();
  });

  it('the upgrade check reports existing content on a system path and stops', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const page = (await new ItemService({ db, siteId: fx.sites.a }).create('pages', { data: { title: 'Old feed', slug: 'old-feed', locale: 'en' }, status: 'published' })) as {
      id: string;
    };
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const check = readFileSync(new URL('../../../../packages/database/drizzle/0050_system_paths.sql', import.meta.url), 'utf8')
      .split('--> statement-breakpoint')
      .find((s) => s.includes('DO $$'))!;
    try {
      // As a site would have it from before this release: content on what is now a system path.
      const reported = await owner
        .begin(async (tx) => {
          await tx`UPDATE lumibase_content_routes SET path = '/feed.xml' WHERE item_id = ${page.id}`;
          await tx.unsafe(check);
          return 'passed';
        })
        .catch((e: { message?: string; code?: string }) => `${e.code}: ${e.message}`);
      expect(reported).toMatch(/^23514: content paths now reserved/);
      expect(reported).toContain(`${fx.sites.a} /feed.xml`);
      // Without the conflict (the rollback above), the check passes.
      await owner.unsafe(check);
    } finally {
      await owner.end({ timeout: 1 });
    }
    expect(await db.select({ path: contentRoutes.path }).from(contentRoutes).where(eq(contentRoutes.itemId, page.id))).not.toContainEqual({ path: '/feed.xml' });
    expect(await db.select({ id: items.id }).from(items).where(eq(items.id, page.id))).toHaveLength(1);
  });
});
