import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { cdcChangeEvents, ensureRenderRole, publicSites, siteRenderVersions, type Database } from '@heopress/database';
import { CdcOperationSchema, EventEnvelopeSchema } from '@heopress/contracts';
import { buildEnvelope } from '../modules/cdc/change-feed/dispatcher';
import type { StoredChangeEvent } from '../modules/cdc/change-feed/feed-reader';
import { createRuntime } from '@heopress/runtime/node';
import { renderPort } from '@heopress/site-classic/read-port';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { SiteIdentityService } from '../services/site-network/site-identity-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Whom a site speaks for (HeoPress P07 task 2.12; spec seo/page-metadata "站点身份"): `null` until set, changed against the
 * version read by the site's administrators; each change passes the projection gate — the public snapshot and the
 * site's render version change in the same transaction, the other site's do not — and the rendering role reads the
 * snapshot, never the identity table.
 */

const JWT_SECRET = 'site-identity-secret';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const RENDER_ROLE = 'heopress_render_identity_it';
const PERSON = { kind: 'person', name: 'Sam Example', sameAs: ['https://social.example.com/sam', 'https://code.example.com/sam'] };

describe.skipIf(!hasDbIntegrationUrl)('site identity — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let owner: postgres.Sql;
  let render: postgres.Sql;

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('site-identity');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    render = postgres(url.toString(), { max: 1, onnotice: () => {} });
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'sidn', jwtSecret: JWT_SECRET });
    for (const id of [fx.sites.a, fx.sites.b]) {
      await upgradeSitePreset(db, id);
      await rebuildSiteProjection(db, id);
    }
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
    await render?.end({ timeout: 1 });
    await owner?.end({ timeout: 1 });
  });

  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const renderVersion = async (siteId: string) =>
    (await db.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, siteId)))[0]?.v ?? 0;
  const snapshot = async (siteId: string) => (await db.select({ identity: publicSites.identity }).from(publicSites).where(eq(publicSites.siteId, siteId)))[0]?.identity;
  const codeOf = async (res: Response) => ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;

  it('null until set; an administrator sets it against the version read; stale and invalid forms are refused; others may not', async () => {
    const admin = fx.headers('a', await fx.session('adminA', 'a'));
    const read = (await (await call('/api/v1/site/identity', 'GET', admin)).json()) as { data: { identity: unknown; version: number } };
    expect(read.data).toEqual({ identity: null, version: 0 });
    const set = await call('/api/v1/site/identity', 'PUT', admin, { version: 0, ...PERSON });
    expect(set.status, await set.clone().text()).toBe(200);
    const body = (await set.json()) as { data: { identity: Record<string, unknown>; version: number } };
    expect(body.data.version).toBe(1);
    // Stored as given, the empty fields empty: nothing filled in for the site.
    expect(body.data.identity).toEqual({ ...PERSON, logo: '', email: '', telephone: '', address: { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: '' } });
    // Its change event: a schema-valid `site_identity.update` naming what changed (Codex review of batch 5a).
    const events = await db.select().from(cdcChangeEvents).where(and(eq(cdcChangeEvents.siteId, fx.sites.a), eq(cdcChangeEvents.resource, 'site_identity')));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ itemId: fx.sites.a, operation: 'update', collection: '$site' });
    expect(events[0]!.changedFields).toEqual(expect.arrayContaining(['kind', 'name', 'sameAs']));
    const e = events[0]!;
    const stored: StoredChangeEvent = {
      id: e.id,
      siteId: e.siteId,
      resource: e.resource,
      collection: e.collection,
      itemId: e.itemId,
      operation: CdcOperationSchema.parse(e.operation),
      payload: (e.payload as Record<string, unknown> | null) ?? null,
      changedFields: e.changedFields as string[] | null,
      schemaVersion: e.schemaVersion,
      actorType: e.actorType,
      actorId: e.actorId,
      source: e.source,
      occurredAt: e.occurredAt,
    };
    const envelope = buildEnvelope(stored, 'reference');
    expect(envelope.type).toBe('site_identity.update');
    expect(EventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    const stale = await call('/api/v1/site/identity', 'PUT', admin, { version: 0, ...PERSON, name: 'Other' });
    expect(stale.status).toBe(409);
    expect(await codeOf(stale)).toBe('VERSION_CONFLICT');
    for (const bad of [
      { ...PERSON },
      { version: 1, kind: 'robot', name: 'X' },
      { version: 1, kind: 'person', name: '' },
      { version: 1, kind: 'organization', name: 'X', logo: 'javascript:alert(1)' },
      { version: 1, kind: 'organization', name: 'X', unknown: true },
      { version: 1, kind: 'organization', name: 'X', address: { unknown: 'x' } },
    ]) {
      const res = await call('/api/v1/site/identity', 'PUT', admin, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call('/api/v1/site/identity', 'PUT', fx.headers('a', await fx.session('onlyA', 'a')), { version: 1, ...PERSON })).status).toBe(403);
    expect((await call('/api/v1/site/identity', 'PUT', fx.headers('a', await fx.session('adminB', 'b')), { version: 1, ...PERSON })).status).toBeGreaterThanOrEqual(401);
  });

  it('concurrent first updates: one wins, the others get the 409 (no row to lock yet)', async () => {
    const attempt = (n: number) => new SiteIdentityService({ db, siteId: fx.sites.a, actor: { userId: null } }).update({ version: 0, kind: 'organization', name: `Org ${n}` });
    const results = await Promise.allSettled([1, 2, 3, 4].map(attempt));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')) {
      expect((r.reason as { code?: string }).code, String(r.reason)).toBe('VERSION_CONFLICT');
    }
  });

  it('a change passes the projection gate: that site\'s snapshot and render version move with it, not the other site\'s', async () => {
    const before = { a: await renderVersion(fx.sites.a), b: await renderVersion(fx.sites.b) };
    expect(await snapshot(fx.sites.a)).toEqual({});
    await new SiteIdentityService({ db, siteId: fx.sites.a, actor: { userId: null } }).update({ version: 0, ...PERSON });
    expect(await renderVersion(fx.sites.a)).toBeGreaterThan(before.a);
    expect(await snapshot(fx.sites.a)).toMatchObject(PERSON);
    expect(await renderVersion(fx.sites.b)).toBe(before.b);
    expect(await snapshot(fx.sites.b)).toEqual({});
    // The rendering service reads it; a rebuild writes the same.
    const identityOf = (siteId: string) => renderPort(db).request(siteId, async (_p, reads) => (await reads.site())?.identity);
    expect(await identityOf(fx.sites.a)).toMatchObject(PERSON);
    expect(await identityOf(fx.sites.b)).toBeNull();
    await rebuildSiteProjection(db, fx.sites.a);
    expect(await snapshot(fx.sites.a)).toMatchObject(PERSON);
  });

  it('the rendering role reads the snapshot of the site in scope, never the identity table', async () => {
    await new SiteIdentityService({ db, siteId: fx.sites.a, actor: { userId: null } }).update({ version: 0, kind: 'organization', name: 'Alpha Ltd' });
    const rows = await render.begin(async (tx) => {
      await tx`SELECT set_config('app.site_id', ${fx.sites.a}, true)`;
      return tx`SELECT identity FROM lumibase_public_sites WHERE site_id = ${fx.sites.a}`;
    });
    expect(rows[0]?.identity).toMatchObject({ kind: 'organization', name: 'Alpha Ltd' });
    expect(await render`SELECT identity FROM lumibase_site_identity`.catch((e: { code?: string }) => e.code)).toBe('42501');
  });
});
