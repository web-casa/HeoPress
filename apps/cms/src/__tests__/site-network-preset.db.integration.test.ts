import { SignJWT } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { auditLog, authSessions, collections, fields, items, publicItems, relations, siteContentSettings, roles, sitePresets, sites, userSites, users, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { TOKEN_AUDIENCE } from '../services/auth/token-audience';
import { createLoginSession } from '../services/auth/login-sessions';
import { ItemService } from '../services/item-service';
import { SchemaService } from '../services/schema-service';
import { SITE_NETWORK_COLLECTIONS, SITE_NETWORK_PRESET } from '../services/site-network/preset';
import { dropPresetCaches, ensureContentSettings, installSiteNetworkPreset, upgradeAllSitePresets, upgradeSitePreset } from '../services/site-network/preset-installer';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { runSiteTransaction } from '../services/rls-transaction';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * The site network preset and content settings (HeoPress P05 tasks 1.1, 1.2,
 * 1.4; spec content/site-network-model "站群预设集合", "站点设置"), through
 * the whole app: a new site gets the five collections and their standard
 * fields together with its content settings, in one transaction; an upgrade
 * only adds — fields the site added and preset fields it changed stay as
 * they are, data included; settings are validated (patterns, time zone,
 * languages, prefixes), version-checked and, for the sponsor policy,
 * reasoned and acknowledged; only the site's administrators change them.
 */

const JWT_SECRET = 'site-network-preset-secret';
const NEW_SITE = 'site_p05_preset_new';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

describe.skipIf(!hasDbIntegrationUrl)('site network preset and content settings — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('site-network-preset');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, NEW_SITE));
    fx = await createCrossSiteFixture(db, { prefix: 'snp', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    await db.delete(sites).where(eq(sites.id, NEW_SITE));
    if (fx) await fx.teardown();
  });

  const as = async (who: 'adminA' | 'adminB' | 'onlyA', site: 'a' | 'b' = 'a') => fx.headers(site, await fx.session(who, site));
  /** The instance administrator (the bootstrap user: the `admin` role system routes require). */
  const asInstanceAdmin = async () => {
    const [boot] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.isBootstrap, true)).limit(1);
    // An administrator of site A too (the system routes also check the requested site).
    const [adminRole] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, fx.sites.a), eq(roles.name, 'Administrator')));
    await db.insert(userSites).values({ userId: boot!.id, siteId: fx.sites.a, roleId: adminRole!.id }).onConflictDoNothing();
    const login = await createLoginSession(db, { userId: boot!.id, mfaVerified: false, amr: ['pwd'], source: 'password' });
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(authSessions.id, login.id));
    const token = await new SignJWT({
      userId: boot!.id,
      email: boot!.email,
      roles: ['admin'],
      // A development token of the instance administrator (tests run with HEOPRESS_ENV=development).
      dev: true,
      siteId: fx.sites.a,
      tokenVersion: 0,
      sid: login.id,
      authTime: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(TOKEN_AUDIENCE.studio)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    return fx.headers('a', token);
  };
  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const json = async <T>(res: Response, status = 200): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return ((await res.json()) as { data: T }).data;
  };
  const ensureContentSettingsRow = (siteId: string) => db.transaction((tx) => ensureContentSettings(tx as unknown as Database, siteId));
  const settingsInput = (r: typeof siteContentSettings.$inferSelect) => ({
    availableLocales: r.availableLocales,
    timezone: r.timezone,
    siteType: r.siteType as 'blog',
    trailingSlash: r.trailingSlash as 'always',
    localeStrategy: r.localeStrategy as 'subdirectory',
    localePrefixMode: r.localePrefixMode as 'default_at_root',
    localePrefixes: r.localePrefixes,
    permalinks: r.permalinks,
    allowCrossSiteTranslations: r.allowCrossSiteTranslations,
    sponsorDisclosure: r.sponsorDisclosure,
    sponsorRel: r.sponsorRel,
    version: r.version,
  });
  const codeOf = async (res: Response) => ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;
  const fieldNames = async (siteId: string, collection: string) =>
    (
      await db
        .select({ name: fields.name })
        .from(fields)
        .innerJoin(collections, eq(collections.id, fields.collectionId))
        .where(and(eq(fields.siteId, siteId), eq(collections.name, collection)))
    ).map((f) => f.name);

  it('a new site gets the five collections with their standard fields and its content settings', async () => {
    const res = await call('/api/v1/instance/sites', 'POST', await asInstanceAdmin(), { id: NEW_SITE, name: 'New network site' });
    expect(res.status, await res.clone().text()).toBe(201);
    const names = (await db.select({ name: collections.name }).from(collections).where(eq(collections.siteId, NEW_SITE))).map((c) => c.name).sort();
    expect(names).toEqual(['articles', 'authors', 'categories', 'pages', 'tags']);
    const articleFields = await fieldNames(NEW_SITE, 'articles');
    for (const f of ['title', 'slug', 'excerpt', 'body', 'seo_title', 'seo_description', 'seo_image', 'canonical_url', 'source_url', 'source_license', 'locale', 'sponsored', 'sponsor_name', 'primary_category', 'author']) {
      expect(articleFields, f).toContain(f);
    }
    expect(await fieldNames(NEW_SITE, 'categories')).toEqual(expect.arrayContaining(['name', 'slug', 'translations', 'parent']));
    // Version 2 (P07 task 2.8): term pages have their own indexing setting.
    for (const term of ['categories', 'tags', 'authors']) expect(await fieldNames(NEW_SITE, term), term).toContain('seo_robots');
    const [settings] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, NEW_SITE));
    expect(settings).toMatchObject({ availableLocales: ['en'], allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true });
    expect(settings!.permalinks).toMatchObject({ articles: '/:year/:month/:slug', pages: '/:slug' });
    const [preset] = await db.select().from(sitePresets).where(eq(sitePresets.siteId, NEW_SITE));
    expect(preset).toMatchObject({ preset: 'site-network', version: 4 });
    // Version 3 (P07 task 2.4): articles and pages have their explicit questions and answers.
    for (const c of ['articles', 'pages']) expect(await fieldNames(NEW_SITE, c), c).toContain('faq');
    // Version 4 (P07 task 2.9): and their own structured data.
    for (const c of ['articles', 'pages']) expect(await fieldNames(NEW_SITE, c), c).toContain('structured_data');
    // The report is kept with the version.
    expect(preset!.report).toMatchObject({ version: 4 });
    // The body is a block field (P04 stable block ids).
    const [body] = await db
      .select({ iface: fields.interface })
      .from(fields)
      .innerJoin(collections, eq(collections.id, fields.collectionId))
      .where(and(eq(fields.siteId, NEW_SITE), eq(collections.name, 'articles'), eq(fields.name, 'body')));
    expect(body!.iface).toBe('wysiwyg');
  });

  it.skipIf(!OWNER_URL)('site, preset and settings commit together: a failure mid-install leaves no site behind', async () => {
    // Fail the install half-way (one preset field refused), through the owner connection.
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      await owner.unsafe(`
        CREATE OR REPLACE FUNCTION heopress_test_refuse_field() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.site_id = '${NEW_SITE}' AND NEW.name = 'sponsor_name' THEN RAISE EXCEPTION 'injected install failure'; END IF;
          RETURN NEW;
        END $$`);
      await owner.unsafe(`CREATE TRIGGER heopress_test_refuse_field BEFORE INSERT ON lumibase_fields FOR EACH ROW EXECUTE FUNCTION heopress_test_refuse_field()`);
      const res = await call('/api/v1/instance/sites', 'POST', await asInstanceAdmin(), { id: NEW_SITE, name: 'Half installed' });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_refuse_field ON lumibase_fields`).catch(() => undefined);
      await owner.unsafe(`DROP FUNCTION IF EXISTS heopress_test_refuse_field()`).catch(() => undefined);
      await owner.end({ timeout: 1 });
    }
    expect(await db.select().from(sites).where(eq(sites.id, NEW_SITE))).toEqual([]);
    expect(await db.select().from(collections).where(eq(collections.siteId, NEW_SITE))).toEqual([]);
    expect(await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, NEW_SITE))).toEqual([]);
  });

  it('an upgrade only adds: a field the site added, a preset field it changed, and their data stay as they are', async () => {
    await call('/api/v1/instance/sites', 'POST', await asInstanceAdmin(), { id: NEW_SITE, name: 'Upgrade me' });
    const schema = new SchemaService({ db, siteId: NEW_SITE });
    await schema.createField('articles', { name: 'reading_time', type: 'integer', interface: 'input' });
    await schema.updateField('articles', 'excerpt', { label: 'Standfirst', note: 'site wording' });
    await schema.deleteField('articles', 'source_attribution', { force: true });
    const item = (await new ItemService({ db, siteId: NEW_SITE }).create('articles', {
      data: { title: 'Kept', slug: 'kept', locale: 'en', reading_time: 7, excerpt: 'mine' },
    })) as { id: string };

    const report = await upgradeSitePreset(db, NEW_SITE);
    expect(report.added).toEqual([{ collection: 'articles', field: 'source_attribution' }]);
    expect(report.skipped).toEqual(expect.arrayContaining([{ collection: 'articles', field: 'excerpt', reason: 'exists' }]));

    const [excerpt] = await db
      .select({ label: fields.label, note: fields.note })
      .from(fields)
      .innerJoin(collections, eq(collections.id, fields.collectionId))
      .where(and(eq(fields.siteId, NEW_SITE), eq(collections.name, 'articles'), eq(fields.name, 'excerpt')));
    expect(excerpt).toEqual({ label: 'Standfirst', note: 'site wording' });
    expect(await fieldNames(NEW_SITE, 'articles')).toContain('reading_time');
    const [row] = await db.select({ data: items.data }).from(items).where(eq(items.id, item.id));
    expect(row!.data).toMatchObject({ reading_time: 7, excerpt: 'mine' });
    // Twice is the same as once.
    const again = await upgradeSitePreset(db, NEW_SITE);
    expect(again.added).toEqual([]);
  });

  it('from version 1 (P07 task 2.8): term pages gain their indexing field; seo_robots as v1 installed it gains `index` — renamed too — a changed one is left', async () => {
    await call('/api/v1/instance/sites', 'POST', await asInstanceAdmin(), { id: NEW_SITE, name: 'From v1' });
    const schema = new SchemaService({ db, siteId: NEW_SITE });
    const v1 = ['index,follow', 'noindex,follow', 'index,nofollow', 'noindex,nofollow'];
    const optionsOf = async (collection: string, field = 'seo_robots') =>
      (
        await db
          .select({ options: fields.options })
          .from(fields)
          .innerJoin(collections, eq(collections.id, fields.collectionId))
          .where(and(eq(fields.siteId, NEW_SITE), eq(collections.name, collection), eq(fields.name, field)))
      )[0]?.options as { choices?: string[]; preset?: { name?: string; version?: number; key?: string } } | undefined;
    // The version-1 shape: no indexing field on terms; the four original choices, marked version 1, on articles and pages.
    for (const term of ['categories', 'tags', 'authors']) await schema.deleteField(term, 'seo_robots', { force: true });
    for (const collection of ['articles', 'pages']) {
      const { choices: _c, preset: _p, ...rest } = (await optionsOf(collection)) ?? {};
      // As the version-1 installer wrote it (only the installer writes a preset marker).
      await new SchemaService({ db, siteId: NEW_SITE, presetInstaller: true }).updateField(collection, 'seo_robots', { options: { ...rest, choices: v1, preset: { name: 'site-network', version: 1, key: 'seo_robots' } } });
    }
    // Pages: the site renamed the field (the preset key stays with it).
    await schema.renameField('pages', 'seo_robots', { name: 'indexing', type: 'string', interface: 'select-dropdown' });
    // …and later added a field of its own under the old name.
    await schema.createField('pages', { name: 'seo_robots', type: 'string', interface: 'select-dropdown', options: { choices: ['mine'] } });
    await db.update(sitePresets).set({ version: 1 }).where(eq(sitePresets.siteId, NEW_SITE));
    expect((await optionsOf('articles'))?.preset).toEqual({ name: 'site-network', version: 1, key: 'seo_robots' });
    expect((await optionsOf('pages', 'indexing'))?.choices).toEqual(v1);

    const report = await upgradeSitePreset(db, NEW_SITE);
    expect(report.added).toEqual(
      expect.arrayContaining([
        { collection: 'categories', field: 'seo_robots' },
        { collection: 'tags', field: 'seo_robots' },
        { collection: 'authors', field: 'seo_robots' },
        { collection: 'articles', field: 'seo_robots', choices: ['index'] },
        { collection: 'pages', field: 'indexing', choices: ['index'] },
      ]),
    );
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { collection: 'pages', field: 'seo_robots', reason: 'renamed_by_site' },
        { collection: 'pages', field: 'seo_robots', reason: 'site_field_with_same_name' },
      ]),
    );
    // Only the choices change: the version-1 marker and the rest stay.
    expect(await optionsOf('articles')).toMatchObject({ choices: [...v1, 'index'], preset: { name: 'site-network', version: 1, key: 'seo_robots' } });
    expect((await optionsOf('pages', 'indexing'))?.choices).toEqual([...v1, 'index']);
    // The site's own field of that name is left exactly as it is.
    expect(await optionsOf('pages')).toEqual({ choices: ['mine'] });
    expect((await db.select().from(sitePresets).where(eq(sitePresets.siteId, NEW_SITE)))[0]?.version).toBe(SITE_NETWORK_PRESET.version);
    // Twice is the same as once.
    const again = await upgradeSitePreset(db, NEW_SITE);
    expect(again.added).toEqual([]);
    expect(again.skipped).toEqual(
      expect.arrayContaining([
        { collection: 'articles', field: 'seo_robots', reason: 'exists' },
        { collection: 'pages', field: 'seo_robots', reason: 'renamed_by_site' },
        { collection: 'pages', field: 'indexing', reason: 'exists' },
        { collection: 'tags', field: 'seo_robots', reason: 'exists' },
      ]),
    );

    // A site that changed its own choices keeps them, reported.
    await schema.updateField('articles', 'seo_robots', { options: { ...(await optionsOf('articles')), choices: ['index,follow', 'noindex,follow'] } });
    const changed = await upgradeSitePreset(db, NEW_SITE);
    expect(changed.added).toEqual([]);
    expect(changed.skipped).toEqual(expect.arrayContaining([{ collection: 'articles', field: 'seo_robots', reason: 'choices_changed_by_site' }]));
    expect((await optionsOf('articles'))?.choices).toEqual(['index,follow', 'noindex,follow']);
  });

  it('P07 task 2.4: the worker brings every site to the current version — the questions-and-answers field added, a site\'s own `faq` kept and reported, again changes nothing', async () => {
    // Two sites as version 2 left them: no faq field; site B has a field of its own called `faq`.
    for (const site of [fx.sites.a, fx.sites.b]) {
      await upgradeSitePreset(db, site);
      for (const c of ['articles', 'pages']) await new SchemaService({ db, siteId: site }).deleteField(c, 'faq');
      await db.update(sitePresets).set({ version: 2, report: null }).where(eq(sitePresets.siteId, site));
    }
    await new SchemaService({ db, siteId: fx.sites.b }).createField('articles', { name: 'faq', type: 'text', interface: 'textarea', label: 'Our FAQ notes' });
    // A site without the preset is left alone.
    await db.insert(sites).values({ id: NEW_SITE, name: 'No preset' });
    const run = await upgradeAllSitePresets(db);
    expect(run.upgraded).toEqual(expect.arrayContaining([fx.sites.a, fx.sites.b]));
    expect(run.upgraded).not.toContain(NEW_SITE);
    expect(run.failed).toEqual([]);
    for (const c of ['articles', 'pages']) expect(await fieldNames(fx.sites.a, c), c).toContain('faq');
    // B's own field stays as it was, and the skip is kept in its report.
    const [own] = await db
      .select({ type: fields.type, label: fields.label })
      .from(fields)
      .innerJoin(collections, eq(collections.id, fields.collectionId))
      .where(and(eq(fields.siteId, fx.sites.b), eq(collections.name, 'articles'), eq(fields.name, 'faq')));
    expect(own).toEqual({ type: 'text', label: 'Our FAQ notes' });
    const [kept] = await db.select().from(sitePresets).where(eq(sitePresets.siteId, fx.sites.b));
    expect(kept).toMatchObject({ version: SITE_NETWORK_PRESET.version, report: { version: SITE_NETWORK_PRESET.version } });
    expect((kept!.report as { skipped: unknown[] }).skipped).toEqual(expect.arrayContaining([{ collection: 'articles', field: 'faq', reason: 'site_field_with_same_name' }]));
    expect(await fieldNames(fx.sites.b, 'pages')).toContain('faq');
    expect(await db.select().from(sitePresets).where(eq(sitePresets.siteId, NEW_SITE))).toEqual([]);
    // Again: nothing left to do for these sites (other suites' sites share the database).
    const again = await upgradeAllSitePresets(db);
    for (const site of [fx.sites.a, fx.sites.b]) {
      expect(again.upgraded).not.toContain(site);
      expect(again.failed).not.toContain(site);
    }
  });

  /** Both fixture sites as preset version 2 left them: no questions-and-answers field. */
  async function atVersion2() {
    for (const site of [fx.sites.a, fx.sites.b]) {
      await upgradeSitePreset(db, site);
      for (const c of ['articles', 'pages']) await new SchemaService({ db, siteId: site }).deleteField(c, 'faq');
      await db.update(sitePresets).set({ version: 2, report: null }).where(eq(sitePresets.siteId, site));
    }
  }
  const faqCount = async (siteId: string, collection: string) =>
    (await db.select({ id: fields.id }).from(fields).innerJoin(collections, eq(collections.id, fields.collectionId)).where(and(eq(fields.siteId, siteId), eq(collections.name, collection), eq(fields.name, 'faq')))).length;

  it('P07 task 2.4: FAQ comes from the preset\'s own field — by its preset key: a site field that only shares the name is not read, a renamed preset field is (Codex review of batch 5b-2)', async () => {
    for (const site of [fx.sites.a, fx.sites.b]) await upgradeSitePreset(db, site);
    // B: its own `faq` repeater with the same sub-fields, in place of the preset's.
    for (const c of ['articles']) await new SchemaService({ db, siteId: fx.sites.b }).deleteField(c, 'faq');
    await new SchemaService({ db, siteId: fx.sites.b }).createField('articles', {
      name: 'faq', type: 'json', interface: 'repeater', label: 'Our FAQ',
      options: { fields: [{ name: 'question', type: 'string', interface: 'input' }, { name: 'answer', type: 'text', interface: 'textarea' }] },
    });
    const qa = [{ question: 'Why?', answer: 'Because.' }];
    const publish = (site: string, slug: string, data: Record<string, unknown>) =>
      new ItemService({ db, siteId: site }).create('articles', { data: { title: slug, slug, locale: 'en', ...data }, status: 'published' }) as Promise<{ id: string }>;
    const structuredOf = async (site: string, id: string) =>
      (await db.select({ s: publicItems.structured }).from(publicItems).where(and(eq(publicItems.siteId, site), eq(publicItems.itemId, id))))[0]?.s;
    const a = await publish(fx.sites.a, 'faq-a', { faq: qa });
    const b = await publish(fx.sites.b, 'faq-b', { faq: qa });
    expect(await structuredOf(fx.sites.a, a.id)).toEqual({ faq: qa });
    expect(await structuredOf(fx.sites.b, b.id)).toEqual({});
    // A renames the preset's field: still the questions and answers (the projection finds it by its preset key).
    const [articles] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, fx.sites.a), eq(collections.name, 'articles')));
    await db.update(fields).set({ name: 'questions' }).where(and(eq(fields.collectionId, articles!.id), eq(fields.name, 'faq')));
    await rebuildSiteProjection(db, fx.sites.a);
    const renamed = await publish(fx.sites.a, 'faq-renamed', { questions: qa });
    expect(await structuredOf(fx.sites.a, renamed.id)).toEqual({ faq: qa });
  });

  it('P07 task 2.4: only the installer writes the preset marker — a forged one is dropped, a stored one survives an edit; an unchanged FAQ is not rewritten (Codex review of batch 5b-2)', async () => {
    await upgradeSitePreset(db, fx.sites.a);
    await upgradeSitePreset(db, fx.sites.b);
    const forged = { fields: [{ name: 'question', type: 'string', interface: 'input' }, { name: 'answer', type: 'text', interface: 'textarea' }], preset: { name: 'site-network', version: 3, key: 'faq' } };
    // B: its own repeater claiming to be the preset's field.
    await new SchemaService({ db, siteId: fx.sites.b }).deleteField('articles', 'faq');
    await new SchemaService({ db, siteId: fx.sites.b }).createField('articles', { name: 'faq', type: 'json', interface: 'repeater', options: forged });
    const optionsOf = async (site: string) =>
      (await db.select({ o: fields.options }).from(fields).innerJoin(collections, eq(collections.id, fields.collectionId)).where(and(eq(fields.siteId, site), eq(collections.name, 'articles'), eq(fields.name, 'faq'))))[0]!.o as Record<string, unknown>;
    expect(await optionsOf(fx.sites.b)).not.toHaveProperty('preset');
    const qa = [{ question: 'Why?', answer: 'Because.' }];
    const created = (await new ItemService({ db, siteId: fx.sites.b }).create('articles', { data: { title: 'forged', slug: 'forged', locale: 'en', faq: qa }, status: 'published' })) as { id: string };
    const rowOf = async (site: string, id: string) => (await db.select().from(publicItems).where(and(eq(publicItems.siteId, site), eq(publicItems.itemId, id))))[0]!;
    expect((await rowOf(fx.sites.b, created.id)).structured).toEqual({});
    // A: an edit of the preset's field that leaves out (or forges) the marker keeps the stored one.
    await new SchemaService({ db, siteId: fx.sites.a }).updateField('articles', 'faq', { label: 'FAQ', options: { fields: forged.fields, preset: { name: 'site-network', key: 'other' } } });
    expect((await optionsOf(fx.sites.a)).preset).toMatchObject({ name: 'site-network', key: 'faq' });
    // A rename keeps the stored marker of the preset's field and drops a forged one on a site field.
    await new SchemaService({ db, siteId: fx.sites.a }).renameField('pages', 'faq', { name: 'questions', type: 'json', interface: 'repeater', options: { fields: forged.fields } });
    const pagesOptions = async (site: string, name: string) =>
      (await db.select({ o: fields.options }).from(fields).innerJoin(collections, eq(collections.id, fields.collectionId)).where(and(eq(fields.siteId, site), eq(collections.name, 'pages'), eq(fields.name, name))))[0]!.o as Record<string, unknown>;
    expect((await pagesOptions(fx.sites.a, 'questions')).preset).toMatchObject({ name: 'site-network', key: 'faq' });
    await new SchemaService({ db, siteId: fx.sites.b }).createField('pages', { name: 'notes', type: 'json', interface: 'repeater', options: { fields: forged.fields } });
    await new SchemaService({ db, siteId: fx.sites.b }).renameField('pages', 'notes', { name: 'more_notes', type: 'json', interface: 'repeater', options: forged });
    expect(await pagesOptions(fx.sites.b, 'more_notes')).not.toHaveProperty('preset');
    // An unchanged FAQ row is not rewritten by a rebuild (JSONB key order is not a change).
    const a = (await new ItemService({ db, siteId: fx.sites.a }).create('articles', { data: { title: 'stable', slug: 'stable', locale: 'en', faq: qa }, status: 'published' })) as { id: string };
    expect((await rowOf(fx.sites.a, a.id)).structured).toEqual({ faq: qa });
    const xminOf = async () => ((await db.execute(sql`SELECT xmin::text AS x FROM lumibase_public_items WHERE item_id = ${a.id}`)) as unknown as Array<{ x: string }>)[0]?.x;
    const before = await xminOf();
    await rebuildSiteProjection(db, fx.sites.a);
    expect(await xminOf()).toBe(before);
  });

  /** A cache whose calls fail while `failing()` says so, counting the calls that went through. */
  const cacheThat = (failing: () => boolean, gate?: Promise<void>) => {
    const calls = { ok: 0, failed: 0 };
    // Resolved by the first call: the drop has read its generation and is in the invalidation.
    let entered!: () => void;
    const enteredAt = new Promise<void>((r) => (entered = r));
    const cache = new Proxy({}, {
      get: (_t, prop) =>
        prop === 'then'
          ? undefined
          : async () => {
              entered();
              if (gate) await gate;
              if (failing()) {
                calls.failed++;
                throw new Error('cache down');
              }
              calls.ok++;
              return undefined;
            },
    }) as never;
    return { cache, calls, enteredAt };
  };
  const reportOf = async (site: string) => (await db.select().from(sitePresets).where(eq(sitePresets.siteId, site)))[0]!.report as Record<string, unknown>;

  it('P07 task 2.4: dropping the caches after a committed upgrade is retried when it failed — the cache really called again (Codex review of batch 5b-2)', async () => {
    await atVersion2();
    let down = true;
    const { cache, calls } = cacheThat(() => down);
    const first = await upgradeAllSitePresets(db, cache);
    expect(first.failed).toEqual(expect.arrayContaining([fx.sites.a, fx.sites.b]));
    expect(calls.failed).toBeGreaterThan(0);
    expect((await db.select().from(sitePresets).where(eq(sitePresets.siteId, fx.sites.a)))[0]).toMatchObject({ version: SITE_NETWORK_PRESET.version, report: { cachesPending: true } });
    // The cache back: the next run drops the caches (calls that go through) and clears the flag; the one after does nothing.
    down = false;
    const second = await upgradeAllSitePresets(db, cache);
    expect(second.upgraded).toEqual(expect.arrayContaining([fx.sites.a, fx.sites.b]));
    expect(calls.ok).toBeGreaterThan(0);
    expect(await reportOf(fx.sites.a)).toMatchObject({ cachesPending: false });
    expect((await upgradeAllSitePresets(db, cache)).upgraded).not.toContain(fx.sites.a);
  });

  it('P07 task 2.4: a version-3 report from before the flag counts as pending once; a drop that ends after a newer install leaves the newer one pending', async () => {
    await upgradeSitePreset(db, fx.sites.a);
    // As the first version-3 installs wrote it: no flag, no generation.
    await db.update(sitePresets).set({ report: { version: 3, added: [], skipped: [], at: new Date().toISOString() } }).where(eq(sitePresets.siteId, fx.sites.a));
    expect((await upgradeAllSitePresets(db)).upgraded).toContain(fx.sites.a);
    expect(await reportOf(fx.sites.a)).toMatchObject({ cachesPending: false });
    expect((await upgradeAllSitePresets(db)).upgraded).not.toContain(fx.sites.a);
    // A record with no report at all: cleared to a complete report (the API's shape), not retried again.
    await db.update(sitePresets).set({ report: null }).where(eq(sitePresets.siteId, fx.sites.a));
    expect((await upgradeAllSitePresets(db)).upgraded).toContain(fx.sites.a);
    expect(await reportOf(fx.sites.a)).toMatchObject({ version: SITE_NETWORK_PRESET.version, added: [], skipped: [], cachesPending: false });
    expect(typeof (await reportOf(fx.sites.a)).at).toBe('string');
    expect((await upgradeAllSitePresets(db)).upgraded).not.toContain(fx.sites.a);
    // A drop that started for one install and ends after a newer install committed (whose own drop failed).
    await upgradeSitePreset(db, fx.sites.a);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = cacheThat(() => false, gate);
    const older = dropPresetCaches(db, fx.sites.a, slow.cache);
    await slow.enteredAt;
    await expect(upgradeSitePreset(db, fx.sites.a, cacheThat(() => true).cache)).rejects.toThrow(/cache down/);
    const newer = await reportOf(fx.sites.a);
    expect(newer).toMatchObject({ cachesPending: true });
    release();
    await older;
    // The older drop did not clear the newer install's pending drop.
    expect(await reportOf(fx.sites.a)).toMatchObject({ cachesPending: true, cachesGeneration: newer.cachesGeneration });
  });

  it('P07 task 2.4: the kept report is read by the site\'s administrators, on that site only', async () => {
    await atVersion2();
    await new SchemaService({ db, siteId: fx.sites.a }).createField('articles', { name: 'faq', type: 'text', interface: 'textarea', label: 'Notes' });
    await upgradeAllSitePresets(db);
    const res = await call('/api/v1/site/preset', 'GET', await as('adminA'));
    const view = await json<{ version: number; report: { skipped: unknown[] } }>(res);
    expect(view.version).toBe(SITE_NETWORK_PRESET.version);
    expect(view.report.skipped).toEqual(expect.arrayContaining([{ collection: 'articles', field: 'faq', reason: 'site_field_with_same_name' }]));
    // B's view is B's: no skip of A's.
    const bView = await json<{ report: { skipped: unknown[] } }>(await call('/api/v1/site/preset', 'GET', await as('adminB', 'b')));
    expect(bView.report.skipped).not.toEqual(expect.arrayContaining([{ collection: 'articles', field: 'faq', reason: 'site_field_with_same_name' }]));
    expect((await call('/api/v1/site/preset', 'GET', await as('onlyA'))).status).toBe(403);
  });

  it.skipIf(!OWNER_URL)('P07 task 2.4: a site that fails does not hold the others back; the next run upgrades only it; two runs at once add each field once', async () => {
    await atVersion2();
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      await owner.unsafe(`
        CREATE OR REPLACE FUNCTION heopress_test_refuse_faq() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.site_id = '${fx.sites.a}' AND NEW.name = 'faq' THEN RAISE EXCEPTION 'injected upgrade failure'; END IF;
          RETURN NEW;
        END $$`);
      await owner.unsafe(`CREATE TRIGGER heopress_test_refuse_faq BEFORE INSERT ON lumibase_fields FOR EACH ROW EXECUTE FUNCTION heopress_test_refuse_faq()`);
      const first = await upgradeAllSitePresets(db);
      expect(first.failed).toContain(fx.sites.a);
      expect(first.failed).not.toContain(fx.sites.b);
      expect(first.upgraded).toContain(fx.sites.b);
      expect((await db.select().from(sitePresets).where(eq(sitePresets.siteId, fx.sites.a)))[0]!.version).toBe(2);
      expect(await faqCount(fx.sites.a, 'articles')).toBe(0);
    } finally {
      await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_refuse_faq ON lumibase_fields`).catch(() => undefined);
      await owner.unsafe(`DROP FUNCTION IF EXISTS heopress_test_refuse_faq()`).catch(() => undefined);
      await owner.end({ timeout: 1 });
    }
    const second = await upgradeAllSitePresets(db);
    expect(second.upgraded).toContain(fx.sites.a);
    expect(second.upgraded).not.toContain(fx.sites.b);
    // Two runs at once (two workers): each field added once, each site at the current version.
    await atVersion2();
    const runs = await Promise.all([upgradeAllSitePresets(db), upgradeAllSitePresets(db)]);
    for (const site of [fx.sites.a, fx.sites.b]) expect(runs.flatMap((r) => r.failed)).not.toContain(site);
    for (const site of [fx.sites.a, fx.sites.b]) {
      for (const c of ['articles', 'pages']) expect(await faqCount(site, c), `${site} ${c}`).toBe(1);
      expect((await db.select().from(sitePresets).where(eq(sitePresets.siteId, site)))[0]!.version).toBe(SITE_NETWORK_PRESET.version);
    }
  });

  it('a site field with a preset field\'s name is never taken over', async () => {
    await db.insert(sites).values({ id: NEW_SITE, name: 'Bare' });
    const schema = new SchemaService({ db, siteId: NEW_SITE });
    await schema.createCollection({ name: 'articles' });
    await schema.createField('articles', { name: 'title', type: 'text', interface: 'textarea', label: 'Headline' });
    const report = await upgradeSitePreset(db, NEW_SITE);
    expect(report.skipped).toEqual(expect.arrayContaining([{ collection: 'articles', field: 'title', reason: 'site_field_with_same_name' }]));
    const [title] = await db
      .select({ type: fields.type, label: fields.label })
      .from(fields)
      .innerJoin(collections, eq(collections.id, fields.collectionId))
      .where(and(eq(fields.siteId, NEW_SITE), eq(collections.name, 'articles'), eq(fields.name, 'title')));
    expect(title).toEqual({ type: 'text', label: 'Headline' });
    expect(SITE_NETWORK_COLLECTIONS.length).toBe(5);
  });

  it('a relation is added only to the preset\'s own field — not to a site field of the same name', async () => {
    await db.insert(sites).values({ id: NEW_SITE, name: 'Own author field' });
    const schema = new SchemaService({ db, siteId: NEW_SITE });
    await schema.createCollection({ name: 'articles' });
    await schema.createField('articles', { name: 'author', type: 'string', interface: 'input', label: 'Byline' });
    const report = await upgradeSitePreset(db, NEW_SITE);
    expect(report.skipped).toEqual(expect.arrayContaining([{ collection: 'articles', relation: 'author', reason: 'field_not_from_preset' }]));
    const rels = await db.select().from(relations).where(and(eq(relations.siteId, NEW_SITE), eq(relations.manyCollection, 'articles')));
    expect(rels.map((r) => r.manyField)).toEqual(['primary_category']);
    // The preset's own relation follows a rename by the site.
    await schema.renameField('articles', 'primary_category', { name: 'main_category', type: 'string', interface: 'select-dropdown-m2o' });
    await db.delete(relations).where(eq(relations.siteId, NEW_SITE));
    const again = await upgradeSitePreset(db, NEW_SITE);
    expect(again.added).toEqual(expect.arrayContaining([{ collection: 'articles', relation: 'main_category' }]));
    expect(again.added).not.toEqual(expect.arrayContaining([{ collection: 'articles', field: 'primary_category' }]));
  });

  it('an upgrade that fills in permalinks bumps the settings version: a form read before cannot undo it', async () => {
    await db.insert(sites).values({ id: NEW_SITE, name: 'Old site' });
    await ensureContentSettingsRow(NEW_SITE);
    const [before] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, NEW_SITE));
    await upgradeSitePreset(db, NEW_SITE);
    const [after] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, NEW_SITE));
    expect(after!.version).toBe(before!.version + 1);
    expect(after!.permalinks).toMatchObject({ articles: '/:year/:month/:slug' });
    const stale = await new ContentSettingsService({ db, siteId: NEW_SITE, actor: { userId: null } })
      .update({ ...settingsInput(before!), permalinks: {} })
      .catch((e: unknown) => e);
    expect(stale).toMatchObject({ code: 'VERSION_CONFLICT' });
    // Nothing to add: no version change.
    await upgradeSitePreset(db, NEW_SITE);
    const [third] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, NEW_SITE));
    expect(third!.version).toBe(after!.version);
  });

  it('the upgrade drops the cached schema after commit: a running CMS sees the new fields at once', async () => {
    const runtime = createRuntime({ ...process.env, HEOPRESS_ENV: 'development' });
    await db.insert(sites).values({ id: NEW_SITE, name: 'Cached' });
    const cached = new SchemaService({ db, siteId: NEW_SITE, cache: runtime.cache });
    await cached.createCollection({ name: 'articles' });
    expect((await cached.getCompiled('articles'))!.fields.map((f) => f.name)).toEqual([]);
    await upgradeSitePreset(db, NEW_SITE, runtime.cache);
    expect((await cached.getCompiled('articles'))!.fields.map((f) => f.name)).toContain('slug');
  });

  it('the report lists the items whose first publish date is estimated or unknown', async () => {
    await call('/api/v1/instance/sites', 'POST', await asInstanceAdmin(), { id: NEW_SITE, name: 'Dated' });
    const [articles] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, NEW_SITE), eq(collections.name, 'articles')));
    const at = new Date('2019-03-22T08:00:00Z');
    await db.insert(items).values([
      { siteId: NEW_SITE, collectionId: articles!.id, status: 'published', data: { title: 'Old post', slug: 'old-post' }, publishedAt: at, publishedAtSource: 'estimated' },
      { siteId: NEW_SITE, collectionId: articles!.id, status: 'draft', data: { title: 'Unpublished then', slug: 'then' }, publishedAtSource: 'unknown' },
      { siteId: NEW_SITE, collectionId: articles!.id, status: 'published', data: { title: 'Known', slug: 'known' }, publishedAt: at, publishedAtSource: 'recorded' },
    ]);
    const report = await upgradeSitePreset(db, NEW_SITE);
    expect(report.publishDates.estimated).toEqual([{ collection: 'articles', id: expect.any(String), title: 'Old post', slug: 'old-post', publishedAt: at.toISOString() }]);
    expect(report.publishDates.unknown.map((i) => i.title)).toEqual(['Unpublished then']);
  });

  it('there is no way to create a site without the preset', async () => {
    const res = await call('/api/v1/instance/sites', 'POST', await asInstanceAdmin(), { id: NEW_SITE, name: 'No opt-out', preset: false });
    expect(res.status).toBe(201);
    expect((await db.select().from(collections).where(eq(collections.siteId, NEW_SITE))).length).toBe(5);
  });

  it.skipIf(!OWNER_URL)('the install runs in the target site\'s RLS scope, and puts the caller\'s scope back', async () => {
    await db.insert(sites).values({ id: NEW_SITE, name: 'Scoped' });
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const envBefore = process.env.HEOPRESS_ENV;
    try {
      // Every row the install writes must be written while app.site_id names its own site.
      await owner.unsafe(`
        CREATE OR REPLACE FUNCTION heopress_test_scope_check() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.site_id = '${NEW_SITE}' AND current_setting('app.site_id', true) IS DISTINCT FROM NEW.site_id THEN
            RAISE EXCEPTION 'written outside its site scope (app.site_id = %)', current_setting('app.site_id', true);
          END IF;
          RETURN NEW;
        END $$`);
      for (const t of ['lumibase_site_content_settings', 'lumibase_collections', 'lumibase_fields', 'lumibase_relations', 'lumibase_site_presets']) {
        await owner.unsafe(`CREATE TRIGGER heopress_test_scope_check BEFORE INSERT OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION heopress_test_scope_check()`);
      }
      process.env.HEOPRESS_ENV = 'test'; // outside development, scopes are set (rls-transaction.ts)
      await upgradeSitePreset(db, NEW_SITE);
      // Nested inside another site's transaction: the caller's scope is restored afterwards.
      const restored = await runSiteTransaction(db, fx.sites.a, async (tx) => {
        await installSiteNetworkPreset(tx as unknown as Database, NEW_SITE);
        const [r] = (await tx.execute(sql`SELECT current_setting('app.site_id', true) AS v`)) as unknown as Array<{ v: string }>;
        return r!.v;
      });
      expect(restored).toBe(fx.sites.a);
    } finally {
      process.env.HEOPRESS_ENV = envBefore;
      for (const t of ['lumibase_site_content_settings', 'lumibase_collections', 'lumibase_fields', 'lumibase_relations', 'lumibase_site_presets']) {
        await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_scope_check ON ${t}`).catch(() => undefined);
      }
      await owner.unsafe(`DROP FUNCTION IF EXISTS heopress_test_scope_check()`).catch(() => undefined);
      await owner.end({ timeout: 1 });
    }
    expect((await db.select().from(collections).where(eq(collections.siteId, NEW_SITE))).length).toBe(5);
  });

  describe('content settings', () => {
    const settingsOf = async (headers: Record<string, string>) =>
      json<{ version: number; availableLocales: string[]; localePrefixes: Record<string, string> } & Record<string, unknown>>(await call('/api/v1/site/content-settings', 'GET', headers));
    const base = (v: { version: number } & Record<string, unknown>) => ({
      availableLocales: ['en', 'zh-CN'],
      timezone: 'Asia/Shanghai',
      siteType: 'blog',
      trailingSlash: 'always',
      localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root',
      localePrefixes: { 'zh-CN': 'zh' },
      permalinks: {},
      allowCrossSiteTranslations: false,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: v.version,
    });

    it('saves valid settings, version-checked; a language without a prefix gets its tag', async () => {
      const a = await as('adminA');
      const current = await settingsOf(a);
      const saved = await json<{ version: number; localePrefixes: Record<string, string>; timezone: string }>(
        await call('/api/v1/site/content-settings', 'PUT', a, { ...base(current), availableLocales: ['en', 'zh-CN', 'pt-BR'] }),
      );
      expect(saved).toMatchObject({ version: current.version + 1, timezone: 'Asia/Shanghai', localePrefixes: { en: 'en', 'zh-CN': 'zh', 'pt-BR': 'pt-br' } });
      // The same form again: someone saved since.
      expect(await codeOf(await call('/api/v1/site/content-settings', 'PUT', a, base(current)))).toBe('VERSION_CONFLICT');
    });

    it('refuses an illegal pattern, an unknown time zone, a missing default language and a reserved or shared prefix', async () => {
      const a = await as('adminA');
      const current = await settingsOf(a);
      const put = (over: Record<string, unknown>) => call('/api/v1/site/content-settings', 'PUT', a, { ...base(current), ...over });
      const noSlug = await put({ permalinks: { articles: '/:year/:month/' } });
      expect(noSlug.status).toBe(400);
      expect(await noSlug.text()).toContain(':slug or :id');
      expect((await put({ permalinks: { articles: '/:title' } })).status).toBe(400);
      expect(await codeOf(await put({ timezone: 'Mars/Olympus' }))).toBe('VALIDATION');
      expect(await codeOf(await put({ availableLocales: ['zh-CN'], localePrefixes: { 'zh-CN': 'zh' } }))).toBe('DEFAULT_LANGUAGE_MISSING');
      expect(await codeOf(await put({ localePrefixes: { 'zh-CN': 'api' } }))).toBe('PREFIX_RESERVED');
      expect((await put({ localePrefixes: { en: 'zh', 'zh-CN': 'zh' } })).status).toBe(400);
      expect((await put({ permalinks: { nonexistent: '/:slug' } })).status).toBe(400);
      // The default language cannot be switched to one the site does not have.
      const patch = await call('/api/v1/site', 'PATCH', a, { defaultLanguage: 'ja' });
      expect(patch.status).toBe(422);
      expect((await settingsOf(a)).version).toBe(current.version);
    });

    it('the sponsor policy: a change needs a reason; switching off needs its risk acknowledged; it is audited', async () => {
      const a = await as('adminA');
      const current = await settingsOf(a);
      const put = (over: Record<string, unknown>) => call('/api/v1/site/content-settings', 'PUT', a, { ...base(current), ...over });
      expect(await codeOf(await put({ sponsorDisclosure: false, sponsorRel: false, riskAcknowledged: ['disclosure', 'rel'] }))).toBe('REASON_REQUIRED');
      const unack = await put({ sponsorDisclosure: false, sponsorRel: false, reason: 'test', riskAcknowledged: ['disclosure'] });
      expect(unack.status).toBe(422);
      const body = (await unack.json()) as { errors: Array<{ code: string; details: { risks: Record<string, string> } }> };
      expect(body.errors[0]!.code).toBe('RISK_ACK_REQUIRED');
      expect(Object.keys(body.errors[0]!.details.risks)).toEqual(['rel']);
      const saved = await json<{ sponsorDisclosure: boolean; sponsorRel: boolean; sponsorPolicyVersion: number }>(
        await put({ sponsorDisclosure: false, sponsorRel: false, reason: 'publisher network policy', riskAcknowledged: ['disclosure', 'rel'] }),
      );
      expect(saved).toMatchObject({ sponsorDisclosure: false, sponsorRel: false, sponsorPolicyVersion: 2 });
      const audit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'site_sponsor_policy_changed')));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.metadata).toMatchObject({
        operator: fx.users.adminA.id,
        reason: 'publisher network policy',
        riskAcknowledged: ['disclosure', 'rel'],
        before: { disclosure: true, rel: true },
        after: { disclosure: false, rel: false },
      });
      // Switching back on needs a reason too, but no acknowledgement.
      const back = await settingsOf(a);
      expect(await codeOf(await call('/api/v1/site/content-settings', 'PUT', a, { ...base(back), sponsorDisclosure: true }))).toBe('REASON_REQUIRED');
      expect((await call('/api/v1/site/content-settings', 'PUT', a, { ...base(back), sponsorDisclosure: true, sponsorRel: false, reason: 'back on' })).status).toBe(200);
    });

    it.skipIf(!OWNER_URL)('a default language change cannot slip between a languages change\'s check and its commit', async () => {
      const a = await as('adminA');
      const current = await settingsOf(a);
      await json(await call('/api/v1/site/content-settings', 'PUT', a, { ...base(current), availableLocales: ['en', 'zh-CN'] }));
      await call('/api/v1/site', 'PATCH', a, { defaultLanguage: 'en' });
      const fresh = await settingsOf(a);
      // An outside transaction holds the settings row and the site row: both requests queue behind it.
      // Without the PATCH taking the settings lock, the PATCH would check the languages (zh-CN still there)
      // and wait only on the site row, then commit after the PUT dropped zh-CN.
      const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
      const waiting = async (sql: postgres.TransactionSql, n: number) => {
        let queued = 0;
        for (let i = 0; i < 100 && queued < n; i++) {
          const [r] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`;
          queued = r!.n;
          if (queued < n) await new Promise((res) => setTimeout(res, 50));
        }
        if (queued < n) {
          const rows = await sql`SELECT state, wait_event_type, wait_event, left(query, 120) AS q FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
          throw new Error(`the requests never queued: ${JSON.stringify(rows).slice(0, 300)}`);
        }
      };
      // The two writes as the routes make them (service level: the HTTP stack does not change the lock protocol).
      const service = new ContentSettingsService({ db, siteId: fx.sites.a, actor: { userId: null } });
      let put: Promise<unknown> | undefined;
      let patch: Promise<unknown> | undefined;
      try {
        await owner.begin(async (sql) => {
          await sql`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${fx.sites.a} FOR UPDATE`;
          await sql`SELECT 1 FROM lumibase_sites WHERE id = ${fx.sites.a} FOR UPDATE`;
          put = service.update({ ...base(fresh), availableLocales: ['en'], localePrefixes: {} } as never).then(() => 'saved', (e: unknown) => e);
          await waiting(sql, 1);
          patch = service.updateSite({ defaultLanguage: 'zh-CN' }).then(() => 'saved', (e: unknown) => e);
          await waiting(sql, 2);
        });
        expect(await put!).toBe('saved');
        expect(await patch!).toMatchObject({ code: 'DEFAULT_LANGUAGE_MISSING' });
      } finally {
        await owner.end({ timeout: 1 });
      }
      const [site] = await db.select({ lang: sites.defaultLanguage }).from(sites).where(eq(sites.id, fx.sites.a));
      expect(site!.lang).toBe('en');
    });

    it('language tags are valid BCP 47 and stored in canonical form, the default language included', async () => {
      const a = await as('adminA');
      const current = await settingsOf(a);
      expect((await call('/api/v1/site/content-settings', 'PUT', a, { ...base(current), availableLocales: ['en', 'en-12'] })).status).toBe(400);
      const saved = await json<{ availableLocales: string[]; localePrefixes: Record<string, string> }>(
        await call('/api/v1/site/content-settings', 'PUT', a, { ...base(current), availableLocales: ['en', 'zh-hant-tw'], localePrefixes: {} }),
      );
      expect(saved.availableLocales).toEqual(['en', 'zh-Hant-TW']);
      expect(saved.localePrefixes).toMatchObject({ 'zh-Hant-TW': 'zh-hant-tw' });
      expect((await call('/api/v1/site', 'PATCH', a, { defaultLanguage: 'zh-Hant-TW' })).status).toBe(200);
    });

    it('an old alias tag keeps working: a site stored as `iw` saves its languages and its default as before', async () => {
      await db.update(sites).set({ defaultLanguage: 'iw' }).where(eq(sites.id, fx.sites.a));
      await db.update(siteContentSettings).set({ availableLocales: ['iw'], localePrefixes: { iw: 'he' } }).where(eq(siteContentSettings.siteId, fx.sites.a));
      const a = await as('adminA');
      const current = await settingsOf(a);
      const saved = await json<{ availableLocales: string[]; localePrefixes: Record<string, string> }>(
        await call('/api/v1/site/content-settings', 'PUT', a, { ...base(current), availableLocales: ['iw'], localePrefixes: { iw: 'he' } }),
      );
      expect(saved.availableLocales).toEqual(['he']);
      expect(saved.localePrefixes).toEqual({ he: 'he' });
      expect((await call('/api/v1/site', 'PATCH', a, { defaultLanguage: 'iw' })).status).toBe(200);
    });

    it('two spellings of one language with different prefixes are refused; a tag too long for a prefix needs an explicit one', async () => {
      const a = await as('adminA');
      const current = await settingsOf(a);
      const dup = await call('/api/v1/site/content-settings', 'PUT', a, { ...base(current), localePrefixes: { 'zh-cn': 'cn', 'zh-CN': 'tw' } });
      expect(dup.status).toBe(400);
      expect(await dup.text()).toContain('same language');
      const long = await call('/api/v1/site/content-settings', 'PUT', a, { ...base(current), availableLocales: ['en', 'en-US-u-ca-gregory'], localePrefixes: {} });
      expect(await codeOf(long)).toBe('PREFIX_REQUIRED');
      expect(
        (await call('/api/v1/site/content-settings', 'PUT', a, { ...base(current), availableLocales: ['en', 'en-US-u-ca-gregory'], localePrefixes: { 'en-US-u-ca-gregory': 'en-greg' } })).status,
      ).toBe(200);
    });

    it('members read the settings; only administrators change them; another site\'s are out of reach', async () => {
      const reader = await as('onlyA');
      const current = await settingsOf(reader);
      expect((await call('/api/v1/site/content-settings', 'PUT', reader, base(current))).status).toBe(403);
      const settingsB = await settingsOf(await as('adminB', 'b'));
      expect(settingsB).not.toMatchObject({ timezone: 'Asia/Shanghai' });
      const rows = await db.select({ siteId: siteContentSettings.siteId }).from(siteContentSettings).where(inArray(siteContentSettings.siteId, [fx.sites.a, fx.sites.b]));
      expect(rows).toHaveLength(2);
    });

    it('only a site administrator gives or confirms an item\'s first publish time', async () => {
      const editor = await as('onlyA');
      const body = { data: { title: 'Old', slug: 'old-post', locale: 'en' }, status: 'published', publishedAt: '2019-01-05T08:00:00Z' };
      expect((await call('/api/v1/items/articles', 'POST', editor, body)).status).toBe(403);
      expect((await call('/api/v1/items/articles/nope/published-at', 'PUT', editor, { publishedAt: null, expectedVersion: 1 })).status).toBe(403);
      const admin = await as('adminA');
      // Past the administrator check: the item does not exist.
      expect((await call('/api/v1/items/articles/nope/published-at', 'PUT', admin, { publishedAt: null, expectedVersion: 1 })).status).toBe(404);
      expect((await call('/api/v1/items/articles/nope/published-at', 'PUT', admin, { publishedAt: 'yesterday', expectedVersion: 1 })).status).toBe(400);
    });
  });
});
