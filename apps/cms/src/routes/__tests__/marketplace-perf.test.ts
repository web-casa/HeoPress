// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import {
  extensions,
  notifications,
  roles,
  sites,
  userSites,
  users,
  scopedDatabase,
  type Database,
} from '@heopress/database';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { marketplaceRouter } from '../marketplace';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Publish fan-out scaling — the notification broadcast to every admin of every
 * site running an outdated install must stay batched (no per-admin round trip).
 *
 * Rewritten to run against a real Postgres (skips when DATABASE_URL is unset):
 * the old mock encoded the pre-security-fix `/publish` contract (no auth, no
 * verify) and a hand-counted query sequence that the moderator gate + signature
 * verification invalidated. Driving the real handler over a real DB keeps the
 * anti-N+1 intent honest and survives future refactors of the query order.
 *
 * Test data goes through the owner's fixtures connection; the route runs as the application role in the publisher
 * site's scope, as the request middleware gives it (HeoPress P14).
 */
// Development mode: unsigned bundles are accepted (HeoPress P12); signing is covered by extension-permissions tests.
const PUBLISH_ENV = { HEOPRESS_ENV: 'development' } as unknown as Record<string, unknown>;

const NUM_SITES = 40;
const ADMINS_PER_SITE = 5;
const PUBLISHER_SITE = 'site_pub';

describe.skipIf(!hasDbIntegrationUrl)('marketplace publish performance', () => {
  let db: Database;
  let fixtures: Database;
  let app: Hono<AppEnv>;
  let publisherId = '';

  beforeAll(async () => {
    db = await connectDbIntegration('marketplace-perf');
    fixtures = await connectDbFixtures('marketplace-perf');

    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', scopedDatabase(db, { site: PUBLISHER_SITE }));
      c.set('siteId', PUBLISHER_SITE);
      c.set('requestId', 'req_perf');
      c.set('runtime', { cache: undefined } as never);
      if (publisherId) c.set('auth', { userId: publisherId, roles: [] } as never);
      await next();
    });
    app.route('/api/v1/marketplace', marketplaceRouter);
  });

  beforeEach(async () => {
    await fixtures.execute(
      sql`TRUNCATE TABLE lumibase_sites, lumibase_extensions, lumibase_user_sites, lumibase_users, lumibase_roles, lumibase_notifications RESTART IDENTITY CASCADE`,
    );
  });

  it('publishes with many sites and admins using a batched notification query', async () => {
    // Publisher site + an admin-bypass role for the acting publisher.
    await fixtures.insert(sites).values({ id: PUBLISHER_SITE, name: 'Publisher' });
    const [pubRole] = await fixtures
      .insert(roles)
      .values({ siteId: PUBLISHER_SITE, name: 'Publisher Admin', adminAccess: true })
      .returning();
    const [pub] = await fixtures
      .insert(users)
      .values({ email: 'publisher@example.com', status: 'active' })
      .returning();
    await fixtures.insert(userSites).values({ userId: pub!.id, siteId: PUBLISHER_SITE, roleId: pubRole!.id });
    publisherId = pub!.id;

    // The global draft to publish (non-reserved name → warn policy is enough).
    const [draft] = await fixtures
      .insert(extensions)
      .values({
        siteId: null,
        name: 'Perf Ext',
        version: '2.0.0',
        type: 'module',
        bundleUrl: 'http://cdn/perf-2.0.0.js',
        marketplaceSlug: 'perf-ext',
        publishedAt: null,
        manifest: { heopress: '>=1.0.0-0', security: { contact: 'security@example.com' } },
      })
      .returning();

    // NUM_SITES sites, each with an admin-role, ADMINS_PER_SITE admins, and an
    // outdated (1.0.0) install of the same slug.
    for (let i = 0; i < NUM_SITES; i++) {
      const siteId = `site_${i}`;
      await fixtures.insert(sites).values({ id: siteId, name: `Site ${i}` });
      const [role] = await fixtures
        .insert(roles)
        .values({ siteId, name: 'Site Admin', adminAccess: true })
        .returning();
      const admins = Array.from({ length: ADMINS_PER_SITE }, (_, j) => ({
        email: `admin_${i}_${j}@example.com`,
        status: 'active' as const,
      }));
      const insertedAdmins = await fixtures.insert(users).values(admins).returning({ id: users.id });
      await fixtures.insert(userSites).values(
        insertedAdmins.map((u) => ({ userId: u.id, siteId, roleId: role!.id })),
      );
      await fixtures.insert(extensions).values({
        siteId,
        name: 'Perf Ext',
        version: '1.0.0',
        type: 'module',
        bundleUrl: 'http://cdn/perf-1.0.0.js',
        marketplaceSlug: 'perf-ext',
        enabled: true,
      });
    }

    const payload = {
      extensionId: draft!.id,
      marketplaceSlug: 'perf-ext',
      publisher: 'Publisher',
      signature: 'dummy_sig',
      signatureAlg: 'ed25519',
      publisherKeyId: 'key_1',
      bundleSha256: 'a'.repeat(64),
    };

    const start = performance.now();
    const res = await app.request(
      '/api/v1/marketplace/publish',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
      PUBLISH_ENV,
    );
    const end = performance.now();

    if (res.status !== 200) console.error(await res.text());
    expect(res.status).toBe(200);

    // Every admin of every outdated site got exactly one notification — the
    // fan-out is a single batched insert, not N+1.
    const countRows = await fixtures
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications);
    const count = countRows[0]!.count;
    expect(count).toBe(NUM_SITES * ADMINS_PER_SITE);

    // The draft is now live.
    const [published] = await fixtures
      .select()
      .from(extensions)
      .where(and(eq(extensions.id, draft!.id), isNull(extensions.siteId)));
    expect(published!.publishedAt).not.toBeNull();

    console.log(
      `Publish fanned out to ${count} admins across ${NUM_SITES} sites in ${(end - start).toFixed(2)}ms.`,
    );
  });
});
