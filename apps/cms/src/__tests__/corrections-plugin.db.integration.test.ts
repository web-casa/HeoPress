import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  aiProductions,
  collections,
  ensureRenderRole,
  extensions,
  items as itemsTable,
  pluginStorage,
  schema,
  siteContentSettings,
  siteDomains,
  sites,
  type Database,
  scopedDatabase,
} from '@heopress/database';
import { ExtensionManifestSchema, MarketplaceManifestSchema } from '@heopress/contracts/schemas';
import { MemoryRateLimiter } from '@heopress/runtime';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { exportPageData, servePageData } from '@heopress/site-classic/page-data';
import { buildSiteGeneration, pageFile, templateDir } from '@heopress/site-astro';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { bundle } from '@heopress/plugin-corrections/build';
import { ExtensionSandbox } from '../extensions/sandbox';
import { PluginHost } from '../extensions/runtime/plugin-host';
import { consumersOf } from '../extensions/runtime/events';
import { handlePluginEndpoint, type EndpointRequestInput } from '../extensions/runtime/endpoints';
import { PluginPanels } from '../extensions/runtime/admin-panels';
import { PipelinePluginHost } from '../extensions/pipeline/host';
import type { ChangeEvent } from '../modules/events/consumer-runner';
import { ExtensionsService } from '../services/extensions-service';
import { ExtensionVerifierService } from '../services/extension-verifier';
import { ItemService } from '../services/item-service';
import { PermissionService } from '../services/permission-service';
import { QualityGate } from '../services/quality-gate/quality-gate';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { dbFixturesUrl, connectDbFixtures, connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The official corrections plugin (`heopress-corrections`, packages/plugin-corrections) against the real data path — the
 * second official plugin of the extension points (ADR-0015). It is installed from its shipped manifest
 * (`heopress-extension.json`) with its built bundle (one ES module, `@heopress/plugin-corrections/build`), loaded through
 * the capability sandbox like any plugin, and uses nothing but the Extension SDK and its declared capabilities:
 *
 *   - the public form endpoint: origin verification, the body and rate limits, the honeypot, every field's validation,
 *     the one neutral answer, and no personal data in any answer;
 *   - moderation: an accepted report produces exactly one draft notice (a duplicate delivery produces none), a rejected
 *     one produces none; the queue (the report collection) is never public;
 *   - the correction block: written once into the article when its notice is published, kept across unrelated edits,
 *     never duplicated over an operator's edit, removed when the notice stops being public, switched off by
 *     `write_body`, and never added to an article without a body;
 *   - the gate check: a marker pointing at a missing or unpublished notice blocks the gate, a published notice passes;
 *   - the public route: `/corrections` and `/corrections/<slug>` on Classic and Astro, with the `CorrectionComment`
 *     structured-data node, and no report data anywhere public.
 *
 * Needs DATABASE_OWNER_URL (to provision this suite's rendering role, as a deployment does).
 */

const RENDER_ROLE = 'heopress_render_corrections';
const OWNER_URL = dbFixturesUrl();
const NOW = Date.parse('2026-10-01T12:00:00Z');
const A = 'site_corrections_a';
const HOST = 'corrections.example.com';
const ORIGIN = `https://${HOST}`;
const PLUGIN = 'heopress-corrections';
const REPORTS = 'heopress_corrections__reports';
const NOTICES = 'heopress_corrections__notices';
const PERMALINKS = { articles: '/:slug', pages: '/:slug', categories: '/category/:slug', tags: '/tag/:slug', authors: '/author/:slug' };
/** The plugin's public answer, asserted as the contract a reader sees (the plugin ships the same sentence). */
const NEUTRAL_ANSWER = 'Thanks. Reports are reviewed before a page is changed.';

const require = createRequire(import.meta.url);

describe.skipIf(!hasDbIntegrationUrl)('The corrections official plugin — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let renderDb: Database;
  let classic: SiteClassic;
  let root: string;
  let generation = 0;
  let manifest: Record<string, unknown>;
  let code = '';
  let seq = 0;

  const ctx = (siteId: string) => ({ siteId, userId: null, roleId: null, user: null, ip: null, headers: {}, apiKey: null }) as never;
  const service = () => new ExtensionsService({ db: scopedDatabase(db, { site: A }), siteId: A, permissionCtx: ctx(A) });
  const items = () => new ItemService({ db: scopedDatabase(db, { site: A }), siteId: A });
  const host = () => new PluginHost({ db });

  const get = async (path: string) => {
    const res = await classic.app.request(path, { headers: { host: HOST } });
    return { status: res.status, html: await res.text() };
  };
  const row = async (id: string) => (await fixtures.select().from(itemsTable).where(eq(itemsTable.id, id)))[0]!;
  /** The stored body without the editor's block ids (the write path adds them). */
  const bodyOf = async (id: string) => String(((await row(id)).data as Record<string, unknown>).body ?? '').replace(/ data-block-id="[^"]*"/g, '');
  const article = async (slug: string, title: string, body: string | null, status: 'published' | 'draft' = 'published') =>
    ((await items().create('articles', {
      data: { title, slug, locale: 'en', ...(body === null ? {} : { body }) },
      status,
      ...(status === 'published' ? { publishedAt: new Date('2026-09-02T00:00:00Z') } : {}),
    })) as { id: string }).id;

  /** A crawler's view of a page's head. */
  function seoOf(html: string) {
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
    const all = (re: RegExp) => [...head.matchAll(re)].map((m) => m.slice(1).join(' '));
    return {
      title: all(/<title>([^<]*)<\/title>/g),
      canonical: all(/<link rel="canonical" href="([^"]*)">/g),
      robots: all(/<meta name="robots" content="([^"]*)">/g),
      jsonLd: [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as unknown),
    };
  }
  const graphOf = (html: string) => ((seoOf(html).jsonLd[0] as { '@graph'?: Array<Record<string, unknown>> } | undefined)?.['@graph'] ?? []);

  async function build(): Promise<{ live: string; snapshot: PageDataSnapshot }> {
    const snapshot = await exportPageData({ db: renderDb, siteId: A, now: () => NOW });
    const out = await buildSiteGeneration({ root, generation: ++generation, theme: 'official:starter', snapshot, serve: servePageData });
    expect(out.ok, out.ok ? '' : out.error).toBe(true);
    return { live: out.ok ? out.outDir : '', snapshot };
  }

  // ---------- the form ----------

  const headers = { origin: ORIGIN as string | null, referer: null as string | null, contentType: 'application/x-www-form-urlencoded', timestamp: null, nonce: null, signature: null };

  function submission(body: Record<string, string>, overrides: Partial<EndpointRequestInput['headers']> = {}, clientIp = '198.51.100.10'): EndpointRequestInput {
    return {
      host: HOST,
      siteParam: null,
      plugin: PLUGIN,
      endpoint: 'report',
      method: 'POST',
      headers: { ...headers, ...overrides },
      body: new URLSearchParams(body).toString(),
      clientIp,
    };
  }

  const form = (pagePath: string, extra: Record<string, string> = {}) => ({
    page_path: pagePath,
    excerpt: 'The bridge was built in 1998.',
    correction: 'The bridge was built in 1989.',
    comment: 'The plaque says 1989.',
    name: 'A Reader',
    email: 'reader@example.com',
    ...extra,
  });

  const send = (input: EndpointRequestInput) => handlePluginEndpoint({ db, host: host(), rateLimiter: new MemoryRateLimiter() }, input);
  const sendWith = (rateLimiter: MemoryRateLimiter, input: EndpointRequestInput) => handlePluginEndpoint({ db, host: host(), rateLimiter }, input);

  const reports = async () =>
    ((await items().list(REPORTS, { limit: 100 })) as unknown as { data: Array<{ id: string; status: string; version: number; data: Record<string, unknown> }> }).data;
  const notices = async () =>
    ((await items().list(NOTICES, { limit: 100 })) as unknown as { data: Array<{ id: string; status: string; version: number; data: Record<string, unknown> }> }).data;
  const noticeOf = async (reportId: string) => (await notices()).find((n) => n.data.report_id === reportId);

  /** Submit and return the report the submission created (the endpoint itself returns no id, by design). */
  async function submit(body: Record<string, string>, clientIp: string) {
    const before = new Set((await reports()).map((r) => r.id));
    const response = await send(submission(body, {}, clientIp));
    const report = (await reports()).find((r) => !before.has(r.id));
    return { response, report };
  }

  // ---------- the subscriptions, delivered by hand (at-least-once is a duplicate call) ----------

  function eventOf(collection: string, itemId: string, operation: 'create' | 'update' | 'delete' = 'update'): ChangeEvent {
    seq += 1;
    return {
      id: `evt_corr_${seq}`,
      siteId: A,
      resource: 'item',
      collection,
      itemId,
      operation,
      payload: null,
      changedFields: ['data', 'status'],
      itemVersion: null,
      actorType: 'user',
      actorId: null,
      source: 'api',
      occurredAt: new Date(NOW),
      txid: String(seq),
      seq,
    };
  }

  async function deliver(subscription: string, event: ChangeEvent, attempt = 1): Promise<void> {
    const defs = (await host().loadAll(A, 'events')).flatMap(consumersOf);
    const def = defs.find((d) => d.name === `plugin:${A}:${PLUGIN}:${subscription}`);
    expect(def, subscription).toBeDefined();
    await def!.handle!(event, { idempotencyKey: `${event.id}:${subscription}:${attempt}`, attempt, signal: new AbortController().signal } as never);
  }
  const deliverReport = (reportId: string, op: 'create' | 'update' = 'update') => deliver('moderate-report', eventOf(REPORTS, reportId, op));
  const deliverNotice = (noticeId: string, op: 'create' | 'update' | 'delete' = 'update') => deliver('attach-notice', eventOf(NOTICES, noticeId, op));

  const publishNotice = async (noticeId: string) => {
    const current = await row(noticeId);
    await items().patch(NOTICES, noticeId, { status: 'published', expectedVersion: current.version } as never);
    await deliverNotice(noticeId);
  };
  const unpublishNotice = async (noticeId: string) => {
    const current = await row(noticeId);
    await items().patch(NOTICES, noticeId, { status: 'draft', expectedVersion: current.version } as never);
    await deliverNotice(noticeId);
  };
  const acceptReport = async (reportId: string) => {
    const current = await row(reportId);
    await items().patch(REPORTS, reportId, { data: { status: 'accepted' }, expectedVersion: current.version } as never);
    await deliverReport(reportId);
  };

  const setSettings = (settings: Record<string, unknown>) =>
    fixtures.update(extensions).set({ settings }).where(and(eq(extensions.siteId, A), eq(extensions.name, PLUGIN)));

  const gateRule = 'ext:heopress_corrections:notice-links';
  const pipelineHost = () => new PipelinePluginHost({ db, env: {} });
  const gateRuleOf = (checks: Array<{ rule: string; status: string; evidence?: unknown }>) => checks.find((c) => c.rule === gateRule);

  async function gateRun(itemId: string) {
    const gate = new QualityGate({ db: scopedDatabase(db, { site: A }), siteId: A, pluginGateChecks: (s) => pipelineHost().gateChecks(s) });
    const [prod] = await fixtures
      .insert(aiProductions)
      .values({ siteId: A, idempotencyKey: `corrections-${itemId}-${Math.random()}`, mode: 'write', collection: 'articles', sources: [], promptVersion: 'test', status: 'drafted', itemId })
      .returning({ id: aiProductions.id });
    return gate.run({ productionId: prod!.id });
  }

  // ---------- state shared by the scenarios ----------

  let notes = '';
  let reportA = '';
  let noticeA = '';

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('corrections-plugin');
    fixtures = await connectDbFixtures('corrections-plugin');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    classic = createSiteClassic({ db: renderDb, now: () => NOW, traffic: false, sweepIntervalMs: 0 });
    root = await mkdtemp(join(tmpdir(), 'heopress-corrections-'));

    await fixtures.delete(sites).where(eq(sites.id, A));
    await fixtures.insert(sites).values({ id: A, name: 'Corrections Site', defaultLanguage: 'en' });
    await upgradeSitePreset(db, A);
    await fixtures.insert(siteDomains).values({ siteId: A, hostname: HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z') });
    const [r] = await fixtures.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
    await new ContentSettingsService({ db: scopedDatabase(db, { site: A }), siteId: A, actor: { userId: null } }).update({
      availableLocales: ['en'], timezone: 'UTC', siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: PERMALINKS, allowCrossSiteTranslations: false,
      sponsorDisclosure: true, sponsorRel: true, version: r!.version,
    } as never);
    await rebuildSiteProjection(db, A);

    // Admin, official signature verified (the plugin is `heopress-*`); bundles are inline `data:` modules, trusted here.
    vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection, action) => ({ collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] }) as never);
    vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: true, isOfficial: true, reason: 'ok' } as never);
    vi.spyOn(ExtensionSandbox.prototype as unknown as { isTrustedBundleUrl(u: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);

    manifest = JSON.parse(await readFile(require.resolve('@heopress/plugin-corrections/heopress-extension.json'), 'utf8')) as Record<string, unknown>;
    code = await bundle();
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.delete(sites).where(eq(sites.id, A));
    await classic?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    if (root) await rm(root, { recursive: true, force: true });
    await rm(join(templateDir(), 'themes', '.ext'), { recursive: true, force: true });
  });

  // ---------- installation ----------

  it('its shipped manifest is valid (marketplace rules included) and installs: the two collections on this site', async () => {
    expect(ExtensionManifestSchema.safeParse(manifest).error?.issues ?? []).toEqual([]);
    expect(MarketplaceManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.prePublishHooks).toBeUndefined();
    const { name, version, type, entry: _entry, capabilities, ...declarations } = manifest as { name: string; version: string; type: string; entry: string; capabilities: string[] } & Record<string, unknown>;
    const installed = await service().installExtension({
      name,
      version,
      type,
      enabled: true,
      bundleUrl: `data:text/javascript,${encodeURIComponent(code)}`,
      capabilities,
      approvedCapabilities: capabilities,
      manifest: declarations,
    } as never);
    expect(installed).toMatchObject({ enabled: true, isOfficial: true, permissionsStatus: 'approved' });
    for (const [local, machine] of [
      ['reports', REPORTS],
      ['notices', NOTICES],
    ] as const) {
      const [coll] = await fixtures.select().from(collections).where(and(eq(collections.siteId, A), eq(collections.name, machine)));
      expect(coll?.meta).toMatchObject({ extension: { name: PLUGIN, namespace: 'heopress_corrections', collection: local } });
    }
    notes = await article('reading-notes', 'Reading notes', '<p>Alpha comes before Beta.</p><h2>Beta</h2>');
  });

  // ---------- the public form ----------

  it('the form: origin, body and rate limits; a cross-site post never reaches the queue', async () => {
    const before = (await reports()).length;
    expect(await send(submission(form('/reading-notes/'), { origin: 'https://evil.example' }))).toMatchObject({ status: 403, body: { errors: [{ code: 'ORIGIN_NOT_ALLOWED' }] } });
    expect(await send(submission(form('/reading-notes/'), { origin: null, referer: null }))).toMatchObject({ status: 403, body: { errors: [{ code: 'ORIGIN_REQUIRED' }] } });
    // A static deployment's page may post: the origin is approved and echoed for the browser.
    const ok = await send(submission(form('/reading-notes/'), { origin: ORIGIN }));
    expect(ok).toMatchObject({ status: 200, body: { data: { message: NEUTRAL_ANSWER } } });
    expect(ok.headers).toMatchObject({ 'Access-Control-Allow-Origin': ORIGIN });
    expect((await reports()).length).toBe(before + 1);

    // The body ceiling is 8 KiB (checked before the rate limit and before any parsing).
    const huge = await sendWith(new MemoryRateLimiter(), submission({ ...form('/reading-notes/'), comment: 'x'.repeat(9 * 1024) }, {}, '203.0.113.20'));
    expect(huge.status).toBe(413);

    // Five requests a minute per client address; the sixth is refused.
    const limiter = new MemoryRateLimiter();
    for (let i = 0; i < 5; i++) expect((await sendWith(limiter, submission({}, {}, '203.0.113.21'))).status).toBe(422);
    const limited = await sendWith(limiter, submission(form('/reading-notes/'), {}, '203.0.113.21'));
    expect(limited.status).toBe(429);
    expect(limited.headers).toMatchObject({ 'Retry-After': expect.any(String) });
  });

  it('the form: every field is validated, and a refusal is about the field, not about the page', async () => {
    const cases: Array<[Record<string, string>, Array<{ field: string; code: string }>]> = [
      [{ page_path: 'not-a-path' }, [{ field: 'page_path', code: 'not_a_path' }]],
      [{ page_path: '/a/../../etc' }, [{ field: 'page_path', code: 'not_a_path' }]],
      [{ page_path: `${ORIGIN}/reading-notes/` }, [{ field: 'page_path', code: 'not_a_path' }]],
      [{ page_path: '/_ext/heopress-corrections/report' }, [{ field: 'page_path', code: 'not_a_path' }]],
      [{ excerpt: '' }, [{ field: 'excerpt', code: 'required' }]],
      [{ excerpt: '<b>markup</b>' }, [{ field: 'excerpt', code: 'contains_markup' }]],
      [{ correction: '' }, [{ field: 'correction', code: 'required' }]],
      [{ correction: '<script>x</script>' }, [{ field: 'correction', code: 'contains_markup' }]],
      [{ comment: '<em>x</em>' }, [{ field: 'comment', code: 'contains_markup' }]],
      [{ name: '<i>x</i>' }, [{ field: 'name', code: 'contains_markup' }]],
      [{ email: 'not an address' }, [{ field: 'email', code: 'invalid_email' }]],
      [{ excerpt: 'x'.repeat(1001) }, [{ field: 'excerpt', code: 'too_long' }]],
      [{ correction: 'x'.repeat(2001) }, [{ field: 'correction', code: 'too_long' }]],
      [{ comment: 'x'.repeat(2001) }, [{ field: 'comment', code: 'too_long' }]],
      [{ name: 'x'.repeat(121) }, [{ field: 'name', code: 'too_long' }]],
    ];
    let ip = 40;
    for (const [override, errors] of cases) {
      ip += 1;
      const res = await send(submission({ ...form('/reading-notes/'), ...override }, {}, `203.0.113.${ip}`));
      expect(res.status, JSON.stringify(override)).toBe(422);
      expect((res.body as { data: { errors: unknown } }).data.errors, JSON.stringify(override)).toEqual(errors);
    }
    // A page that does not exist is indistinguishable from one that does: both are accepted by the form.
    const unknown = await send(submission(form('/no-such-page/'), {}, '203.0.113.90'));
    expect(unknown).toMatchObject({ status: 200, body: { data: { message: NEUTRAL_ANSWER } } });
  });

  it('the form: the honeypot is answered exactly like a person and dropped; the answer carries no personal data', async () => {
    const before = (await reports()).length;
    const trapped = await send(submission(form('/reading-notes/', { website: 'https://spam.example' }), {}, '203.0.113.91'));
    expect(trapped).toEqual({ status: 200, body: { data: { message: NEUTRAL_ANSWER } }, headers: { 'Access-Control-Allow-Origin': ORIGIN, Vary: 'Origin' } });
    expect((await reports()).length).toBe(before);

    const { response, report } = await submit(form('/reading-notes/', { email: 'private.person@example.com', name: 'Private Person' }), '203.0.113.92');
    expect(response).toMatchObject({ status: 200, body: { data: { message: NEUTRAL_ANSWER } } });
    const text = JSON.stringify(response.body);
    expect(text).not.toContain('private.person@example.com');
    expect(text).not.toContain('Private Person');
    expect(text).not.toContain('/reading-notes/');
    expect(text).not.toMatch(/recorded|received|exists|not found/i);

    // The queue keeps them where only the site can read them.
    reportA = report!.id;
    expect(report?.data).toMatchObject({ status: 'pending', reporter_email: 'private.person@example.com', reporter_name: 'Private Person' });
    expect(report?.status).toBe('draft');
  });

  // ---------- moderation ----------

  it('moderation: accepted produces exactly one draft notice; a duplicate delivery, or a rejected report, produces none', async () => {
    await acceptReport(reportA);
    const one = await notices();
    expect(one.filter((n) => n.data.report_id === reportA)).toHaveLength(1);
    const notice = one.find((n) => n.data.report_id === reportA)!;
    noticeA = notice.id;
    expect(notice.status).toBe('draft');
    expect(notice.data).toMatchObject({
      slug: `correction-${reportA}`,
      page_path: '/reading-notes/',
      excerpt: 'The bridge was built in 1998.',
      correction: 'The bridge was built in 1989.',
      report_id: reportA,
      article_id: notes,
      locale: 'en',
    });
    expect(notice.data.title).toBe('Correction: Reading notes');
    // Nothing of the reporter reaches the notice.
    expect(JSON.stringify(notice.data)).not.toMatch(/private\.person|Private Person|plaque/i);

    // At-least-once: the same acceptance delivered again, and a second "accepted" decision, still give one notice.
    await deliverReport(reportA);
    await deliverReport(reportA, 'create');
    const again = await row(reportA);
    await items().patch(REPORTS, reportA, { data: { status: 'accepted', editor_note: 'again' }, expectedVersion: again.version } as never);
    await deliverReport(reportA);
    expect((await notices()).filter((n) => n.data.report_id === reportA)).toHaveLength(1);
    // The decision is recorded once in the plugin's private ledger, without a single reporter field.
    const ledger = await fixtures.select().from(pluginStorage).where(and(eq(pluginStorage.siteId, A), eq(pluginStorage.namespace, 'decisions')));
    const doc = ledger.find((d) => d.docId === `notice:${reportA}`)!;
    expect(doc.data).toMatchObject({ report: reportA, notice: noticeA, article: notes, state: 'accepted' });
    expect(JSON.stringify(doc.data)).not.toMatch(/private\.person|Private Person|plaque/i);

    // Rejected: nothing is created, nothing is touched.
    const { response, report } = await submit(form('/reading-notes/', { excerpt: 'A rejected report.' }), '203.0.113.93');
    expect(response).toMatchObject({ status: 200 });
    const rejected = report!;
    const current = await row(rejected.id);
    await items().patch(REPORTS, rejected.id, { data: { status: 'rejected' }, expectedVersion: current.version } as never);
    await deliverReport(rejected.id);
    expect((await notices()).filter((n) => n.data.report_id === rejected.id)).toHaveLength(0);
    expect((await notices()).filter((n) => n.data.report_id === reportA)).toHaveLength(1);
  });

  // ---------- the correction block ----------

  it('the block: published notice writes one marker; a second delivery and an unrelated edit keep it single and keep the edit', async () => {
    const before = await row(notes);
    expect(await bodyOf(notes)).not.toContain('data-heopress-correction');

    await publishNotice(noticeA);
    const body = await bodyOf(notes);
    expect(body.match(/data-heopress-correction=/g)).toHaveLength(1);
    expect(body).toContain(`<aside data-heopress-correction="${reportA}">`);
    expect(body).toContain('<p><strong>Correction</strong>');
    expect(body).toContain('The bridge was built in 1989.');
    expect(body).toContain('<blockquote><p>The bridge was built in 1998.</p></blockquote>');
    expect(body.startsWith('<p>Alpha comes before Beta.</p>')).toBe(true);
    expect((await row(notes)).status).toBe('published');
    expect((await row(notes)).version).toBe(before.version + 1);

    // A repeated delivery changes nothing at all (no new version, no second block).
    const version = (await row(notes)).version;
    await deliverNotice(noticeA);
    await deliverNotice(noticeA, 'create');
    expect((await row(notes)).version).toBe(version);
    expect(await bodyOf(notes)).toBe(body);

    // An operator edits an unrelated paragraph: the edit lands and the marker stays, once.
    await items().patch('articles', notes, { data: { body: (await bodyOf(notes)).replace('Alpha comes before Beta.', 'Alpha now comes after Beta.') }, expectedVersion: (await row(notes)).version } as never);
    await deliverNotice(noticeA);
    const edited = await bodyOf(notes);
    expect(edited).toContain('Alpha now comes after Beta.');
    expect(edited.match(/data-heopress-correction=/g)).toHaveLength(1);

    // An operator rewrites the block: the plugin does not duplicate it and does not overwrite the wording.
    await items().patch('articles', notes, { data: { body: edited.replace('The bridge was built in 1989.', 'The bridge was built in 1989, per the parish record.') }, expectedVersion: (await row(notes)).version } as never);
    await deliverNotice(noticeA);
    const rewritten = await bodyOf(notes);
    expect(rewritten.match(/data-heopress-correction=/g)).toHaveLength(1);
    expect(rewritten).toContain('per the parish record');
  });

  it('the block: unpublishing the notice removes exactly its block and keeps the rest of the edit', async () => {
    await unpublishNotice(noticeA);
    const afterUnpublish = await bodyOf(notes);
    expect(afterUnpublish).not.toContain('data-heopress-correction');
    // The block carried the correction; what the operator wrote outside it stays.
    expect(afterUnpublish).toContain('Alpha now comes after Beta.');
    expect(afterUnpublish).not.toContain('The bridge was built in 1989, per the parish record.');

    await publishNotice(noticeA);
    expect(await bodyOf(notes)).toContain('data-heopress-correction');
  });

  it('the block: deleting a notice removes its block; `write_body` off leaves the notice in the collection only; an article without a body is untouched', async () => {
    const deletable = await article('deletable', 'Deletable', '<p>One.</p>');
    const { report } = await submit(form('/deletable/'), '203.0.113.94');
    await acceptReport(report!.id);
    const notice = (await noticeOf(report!.id))!;
    await publishNotice(notice.id);
    expect(await bodyOf(deletable)).toContain('data-heopress-correction');
    const current = await row(notice.id);
    await items().softDelete(NOTICES, notice.id, { expectedVersion: current.version });
    await deliverNotice(notice.id, 'delete');
    expect(await bodyOf(deletable)).not.toContain('data-heopress-correction');
    expect(await bodyOf(deletable)).toContain('<p>One.</p>');

    const off = await article('setting-off', 'Setting off', '<p>No block here.</p>');
    const offReport = (await submit(form('/setting-off/'), '203.0.113.95')).report!;
    await acceptReport(offReport.id);
    const offNotice = (await noticeOf(offReport.id))!;
    await setSettings({ write_body: false });
    await publishNotice(offNotice.id);
    expect(await bodyOf(off)).toBe('<p>No block here.</p>');
    // The notice is still a public record; only the article is left alone.
    expect((await row(offNotice.id)).status).toBe('published');
    await setSettings({});

    // An article without a body field: the plugin never invents one.
    const bare = await article('bare-article', 'Bare article', null);
    const bareReport = (await submit(form('/bare-article/'), '203.0.113.96')).report!;
    await acceptReport(bareReport.id);
    const bareNotice = (await noticeOf(bareReport.id))!;
    await publishNotice(bareNotice.id);
    expect((await row(bare)).data).not.toHaveProperty('body');
  });

  // ---------- the gate check ----------

  it('the gate: a missing or unpublished notice blocks; a published notice passes; an article without a block passes', async () => {
    const withBlock = await article('gated', 'Gated article', '<p>Body.</p>\n<aside data-heopress-correction="r_missing"><p>x</p></aside>');
    const missing = await gateRun(withBlock);
    expect(gateRuleOf(missing.checks)).toMatchObject({ status: 'blocked', evidence: { missing: ['r_missing'] } });
    expect(missing.status).not.toBe('passed');

    const marker = (await bodyOf(notes)).match(/data-heopress-correction="([^"]+)"/)![1]!;
    expect(marker).toBe(reportA);
    const gated = await article('gated-2', 'Gated article 2', `<p>Body.</p>\n<aside data-heopress-correction="${marker}"><p>x</p></aside>`);
    const passing = await gateRun(gated);
    expect(gateRuleOf(passing.checks)).toMatchObject({ status: 'passed', evidence: { corrections: [marker] } });

    // The same article with the same marker, once its notice is not public: blocked, naming the notice and its state.
    await unpublishNotice(noticeA);
    const blocked = await gateRuleOf((await gateRun(gated)).checks);
    expect(blocked).toMatchObject({ status: 'blocked', evidence: { unpublished: [{ report: marker, notice: noticeA, status: 'draft' }] } });
    await publishNotice(noticeA);

    // A marker the plugin did not write is blocked too.
    const malformed = await article('gated-3', 'Gated article 3', '<p>Body.</p>\n<aside data-heopress-correction="../etc/passwd"><p>x</p></aside>');
    expect(gateRuleOf((await gateRun(malformed)).checks)).toMatchObject({ status: 'blocked', evidence: { malformed: ['../etc/passwd'] } });

    // No block, no check: an ordinary article passes.
    const plain = await article('gated-4', 'Gated article 4', '<p>Nothing to correct.</p>');
    expect(gateRuleOf((await gateRun(plain)).checks)).toMatchObject({ status: 'passed', evidence: { corrections: 0 } });
  });

  // ---------- rendering: both engines ----------

  it('Classic renders the public correction list and page, with the CorrectionComment node and no report data', async () => {
    const published = (await noticeOf(reportA))!;
    expect(published.status).toBe('published');
    const index = await get('/corrections/');
    expect(index.status).toBe(200);
    expect(index.html).toContain('class="heopress-corrections heopress-corrections-index"');
    expect(index.html).toMatch(new RegExp(`<a href="[^"]*\\/corrections\\/${published.data.slug}\\/">`));
    expect(index.html).toContain(published.data.title as string);

    const page = await get(`/corrections/${published.data.slug}/`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('class="heopress-corrections heopress-corrections-notice"');
    expect(page.html).toContain('The bridge was built in 1989.');
    expect(page.html).toContain('The bridge was built in 1998.');
    expect(page.html).toContain('href="/reading-notes/"');
    expect(seoOf(page.html).canonical).toEqual([`${ORIGIN}/corrections/${published.data.slug}/`]);
    // The plugin's structured data: one CorrectionComment in the page's one graph, written by the core.
    expect(seoOf(page.html).jsonLd).toHaveLength(1);
    expect(graphOf(page.html)).toContainEqual(
      expect.objectContaining({
        '@type': 'CorrectionComment',
        text: 'The bridge was built in 1989.',
        about: { '@type': 'WebPage', url: '/reading-notes/' },
        dateCreated: published.data.corrected_on,
      }),
    );

    // No reporter data, no report id, no marker in any public output; the report collection has no public page.
    for (const html of [index.html, page.html]) {
      expect(html).not.toContain('private.person@example.com');
      expect(html).not.toContain('Private Person');
      expect(html).not.toContain('The plaque says 1989.');
      expect(html).not.toContain('data-heopress-correction');
      // The hidden internal fields of the notice are not public data either.
      expect(html).not.toContain('"report_id"');
      expect(html).not.toContain('"article_id"');
    }
    expect((await get(`/corrections/${reportA}/`)).status).toBe(404);

    // The corrected article shows the correction text; the block's wrapper and marker are the core's to drop.
    const articlePage = await get('/reading-notes/');
    expect(articlePage.status).toBe(200);
    // The block was last rebuilt from the notice (the gate scenario unpublished and republished it), so the article
    // carries the notice's wording; what the operator wrote outside the block is still there.
    expect(articlePage.html).toContain('The bridge was built in 1989.');
    expect(articlePage.html).toContain('Alpha now comes after Beta.');
    expect(articlePage.html).not.toContain('data-heopress-correction');
    expect(articlePage.html).not.toContain('private.person@example.com');
    // The sitemap index lists shards; the text form lists every public address.
    expect((await get('/sitemap.txt')).html).toContain(`/corrections/${published.data.slug}`);
  });

  it('Astro builds the same pages from the page data; Classic and Astro say the same', async () => {
    const { live, snapshot } = await build();
    const published = (await noticeOf(reportA))!;
    expect(snapshot.pages.map((p) => p.path)).toEqual(expect.arrayContaining(['/corrections/', `/corrections/${published.data.slug}/`, '/reading-notes/']));
    for (const path of ['/corrections/', `/corrections/${published.data.slug}/`, '/reading-notes/']) {
      const fromClassic = await get(path);
      const fromAstro = await readFile(pageFile(live, path), 'utf8');
      expect(seoOf(fromAstro), path).toEqual(seoOf(fromClassic.html));
    }
    const page = await readFile(pageFile(live, `/corrections/${published.data.slug}/`), 'utf8');
    expect(page).toContain('class="heopress-corrections heopress-corrections-notice"');
    expect(page).toContain('The bridge was built in 1989.');
    expect(page).toContain('The bridge was built in 1998.');
    const index = await readFile(pageFile(live, '/corrections/'), 'utf8');
    expect(index).toMatch(/class="heopress-corrections-list"/);
    // A draft notice is not built: only the published record has a page.
    const draft = (await notices()).find((n) => n.status !== 'published');
    if (draft) expect(snapshot.pages.map((p) => p.path)).not.toContain(`/corrections/${draft.data.slug}/`);
  }, 240_000);

  // ---------- the admin panel ----------

  it('the admin table lists the moderation decisions; the settings page declares the body switch', async () => {
    const panels = new PluginPanels(db, A);
    const panel = (await panels.list()).find((p) => p.name === PLUGIN)!;
    expect(panel).toMatchObject({ displayName: 'Corrections', hasSettings: true });
    expect(panel.pages.map((p) => `${p.type}:${p.id}`)).toEqual(['table:decisions', 'settings:settings']);
    expect(panel.widgets).toEqual([expect.objectContaining({ id: 'decisions', count: expect.any(Number) })]);
    const table = await panels.page(PLUGIN, 'decisions');
    expect(table).toMatchObject({ type: 'table', columns: ['report', 'notice', 'article', 'state'] });
    if (table.type === 'table') {
      expect(table.documents.length).toBeGreaterThanOrEqual(1);
      expect(table.documents[0]!.data).toMatchObject({ state: 'accepted' });
    }
    const settings = await panels.page(PLUGIN, 'settings');
    expect(settings).toMatchObject({ type: 'settings', settings: [expect.objectContaining({ key: 'write_body' }), expect.objectContaining({ key: 'marker_label' })] });
  });
});
