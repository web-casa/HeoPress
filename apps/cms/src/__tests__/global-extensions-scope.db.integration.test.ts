import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { extensions, roles, scopedDatabase, sites, userSites, users, type Database } from '@heopress/database';
import type { AppEnv } from '../env';
import { marketplaceRouter } from '../routes/marketplace';
import { rlsPolicyStatements } from '../../../../packages/database/src/rls/policies';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Global extension rows (`lumibase_extensions.site_id IS NULL`, policy `site-or-global-read`; HeoPress P14 task 1.5,
 * ADR-0023): every site reads them, only the platform scope writes them. The marketplace writes the catalog in the
 * platform scope (`routes/marketplace.ts`); a site's scope that tries to change a global row changes nothing, and one
 * that tries to create a global row is refused.
 *
 * The refusals are checked on `lumibase_extensions` when the policies are installed; otherwise (the policies come with
 * a later migration) on a copy of the table carrying the registry's own `site-or-global-read` policies.
 */
const SITE = 'site_p14_global_ext';
const SLUG = 'p14-global-ext';
const PROBE = `heopress_global_ext_probe_${process.pid}`;
// Development mode: an unsigned bundle is accepted (signing is covered by extension-permissions).
const ENV = { HEOPRESS_ENV: 'development' };

describe.skipIf(!hasDbIntegrationUrl)('global extensions: written only in the platform scope (P14 task 1.5)', () => {
  let db: Database;
  let fixtures: Database;
  let table = 'lumibase_extensions';
  let adminId = '';

  beforeAll(async () => {
    db = await connectDbIntegration('global-extensions-scope');
    fixtures = await connectDbFixtures('global-extensions-scope');
    const [rls] = await fixtures.execute<{ on: boolean }>(sql`SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.lumibase_extensions'::regclass`);
    if (!rls?.on) {
      table = PROBE;
      const role = new URL(process.env.DATABASE_URL!).username;
      await fixtures.execute(sql.raw(`CREATE TABLE ${PROBE} (LIKE lumibase_extensions INCLUDING DEFAULTS)`));
      for (const statement of rlsPolicyStatements([{ table: PROBE, policy: 'site-or-global-read' }])) await fixtures.execute(sql.raw(statement));
      await fixtures.execute(sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE} TO "${role}"`));
    }
  });

  async function clean() {
    await fixtures.delete(extensions).where(and(isNull(extensions.siteId), eq(extensions.marketplaceSlug, SLUG)));
    await fixtures.delete(sites).where(eq(sites.id, SITE));
    await fixtures.delete(users).where(inArray(users.email, ['p14-global-admin@example.com']));
  }

  beforeEach(async () => {
    await clean();
    await fixtures.insert(sites).values({ id: SITE, name: 'Global extensions' });
    const [role] = await fixtures.insert(roles).values({ siteId: SITE, name: 'Admin', adminAccess: true }).returning();
    const [admin] = await fixtures.insert(users).values({ email: 'p14-global-admin@example.com', status: 'active' }).returning();
    await fixtures.insert(userSites).values({ userId: admin!.id, siteId: SITE, roleId: role!.id });
    adminId = admin!.id;
  });

  afterAll(async () => {
    if (!fixtures) return;
    await clean();
    await fixtures.execute(sql.raw(`DROP TABLE IF EXISTS ${PROBE}`));
  });

  function app() {
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      // As the request middleware does: the request's handle in its site's scope.
      c.set('db', scopedDatabase(db, { site: SITE }));
      c.set('siteId', SITE);
      c.set('auth', { userId: adminId, roles: [] } as never);
      c.set('runtime', { cache: undefined } as never);
      await next();
    });
    hono.route('/marketplace', marketplaceRouter);
    return (method: string, url: string, body?: unknown) =>
      hono.request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, ENV);
  }

  it('the platform scope publishes a global extension; a site scope modifying it is refused', async () => {
    const call = app();
    // Submit, approve and publish: three writes of the global row, each from a site's request.
    const submitted = await call('POST', '/marketplace/submit', {
      name: 'Global Ext', version: '1.0.0', type: 'hook', marketplaceSlug: SLUG, bundleUrl: 'https://example.com/global.js',
      capabilities: ['ext:events'], heopress: '>=1.0.0-0', security: { contact: 'security@example.com' },
      extensionPoints: { context: '^1.0.0', events: '^1.0.0' },
    });
    expect(submitted.status).toBe(201);
    const id = ((await submitted.json()) as { data: { id: string } }).data.id;
    expect((await call('POST', `/marketplace/submissions/${id}/review`, { action: 'approve' })).status).toBe(200);
    const published = await call('POST', '/marketplace/publish', {
      extensionId: id, marketplaceSlug: SLUG, publisher: 'Acme', signature: 'sig', signatureAlg: 'ed25519', publisherKeyId: 'key', bundleSha256: 'a'.repeat(64),
    });
    expect(published.status).toBe(200);
    const [row] = await fixtures.select().from(extensions).where(eq(extensions.id, id));
    expect(row).toMatchObject({ siteId: null, submissionStatus: 'approved', version: '1.0.0' });
    expect(row!.publishedAt).not.toBeNull();
    // The catalog (read in the site's scope) lists it.
    const catalog = (await (await call('GET', '/marketplace/extensions')).json()) as { data: Array<{ slug: string }> };
    expect(catalog.data.map((e) => e.slug)).toContain(SLUG);

    // A global row of the table under the policies: the site's scope reads it, but cannot change, delete or create one.
    const globalId = table === 'lumibase_extensions' ? id : `${id}-probe`;
    if (table !== 'lumibase_extensions') {
      await fixtures.execute(sql`INSERT INTO ${sql.identifier(table)} (id, site_id, name, version, type, bundle_url) VALUES (${globalId}, NULL, 'Global Ext', '1.0.0', 'hook', 'https://example.com/global.js')`);
    }
    const t = sql.identifier(table);
    const site = scopedDatabase(db, { site: SITE });
    expect(await site.execute(sql`SELECT id FROM ${t} WHERE id = ${globalId}`)).toHaveLength(1);
    expect(await site.execute(sql`UPDATE ${t} SET version = '9.9.9' WHERE id = ${globalId} RETURNING id`)).toHaveLength(0);
    expect(await site.execute(sql`DELETE FROM ${t} WHERE id = ${globalId} RETURNING id`)).toHaveLength(0);
    await expect(
      site.execute(sql`INSERT INTO ${t} (id, site_id, name, version, type, bundle_url) VALUES (${`${globalId}-forged`}, NULL, 'Forged', '1.0.0', 'hook', 'https://example.com/f.js')`),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    // Re-homing a site's own row into the catalog is refused the same way.
    await fixtures.execute(sql`INSERT INTO ${t} (id, site_id, name, version, type, bundle_url) VALUES (${`${globalId}-own`}, ${SITE}, 'Own', '1.0.0', 'hook', 'https://example.com/o.js')`);
    await expect(site.execute(sql`UPDATE ${t} SET site_id = NULL WHERE id = ${`${globalId}-own`}`)).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    const [kept] = await fixtures.execute<{ version: string; site_id: string | null }>(sql`SELECT version, site_id FROM ${t} WHERE id = ${globalId}`);
    expect(kept).toEqual({ version: '1.0.0', site_id: null });

    // The platform scope changes it.
    const platform = scopedDatabase(db, { platform: true });
    expect(await platform.execute(sql`UPDATE ${t} SET version = '1.0.1' WHERE id = ${globalId} RETURNING id`)).toHaveLength(1);
    await fixtures.execute(sql`DELETE FROM ${t} WHERE id IN (${globalId}, ${`${globalId}-own`})`);
  });
});
