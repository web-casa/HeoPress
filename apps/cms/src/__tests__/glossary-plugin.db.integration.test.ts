import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { aiProductions, collections, ensureRenderRole, extensions, items as itemsTable, pluginJobs, schema, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { ExtensionManifestSchema, MarketplaceManifestSchema } from '@heopress/contracts/schemas';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import { exportPageData, servePageData } from '@heopress/site-classic/page-data';
import { buildSiteGeneration, pageFile, templateDir } from '@heopress/site-astro';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { bundle } from '@heopress/plugin-glossary/build';
import { ExtensionSandbox } from '../extensions/sandbox';
import { PluginHost } from '../extensions/runtime/plugin-host';
import { PluginJobRunner } from '../extensions/runtime/jobs';
import { consumersOf } from '../extensions/runtime/events';
import { PipelinePluginHost } from '../extensions/pipeline/host';
import { EventConsumerRunner } from '../modules/events/consumer-runner';
import { ExtensionsService } from '../services/extensions-service';
import { ExtensionVerifierService } from '../services/extension-verifier';
import { ItemService } from '../services/item-service';
import { PermissionService } from '../services/permission-service';
import { QualityGate } from '../services/quality-gate/quality-gate';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The official glossary plugin (`heopress-glossary`, packages/plugin-glossary) against the real data path — HeoPress P12
 * task 5.1, the reference plugin of the extension points (ADR-0015). It is installed from its shipped manifest
 * (`heopress-extension.json`) with its built bundle (one ES module, `@heopress/plugin-glossary/build`), loaded through
 * the capability sandbox like any plugin, and uses nothing but the Extension SDK and its declared capabilities:
 *
 *   - collection + routes: term pages `/glossary/:slug` and the index `/glossary`, rendered by Classic and built by Astro
 *     with the plugin's templates; both engines say the same (status, head) and place the `tooltip` component;
 *   - event subscription: after an article is published its body's terms link to their pages (the definition as the
 *     link's title, the tooltip) and the term references are updated; an edit or an unpublish updates them again;
 *   - gate check: a term definition without a source citation needs review;
 *   - scheduled job: the periodic recomputation runs one batch per run and continues after the last article done;
 *   - no pre-publish hook: even with a bundle that does not load, the plugin never blocks a publish.
 *
 * Needs DATABASE_OWNER_URL (to provision this suite's rendering role, as a deployment does).
 */

const RENDER_ROLE = 'heopress_render_glossary';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const A = 'site_p12_glossary_a';
const HOST = 'terms.example.com';
const ORIGIN = `https://${HOST}`;
const PLUGIN = 'heopress-glossary';
const TERMS = 'heopress_glossary__terms';
const PERMALINKS = { articles: '/:slug', pages: '/:slug', categories: '/category/:slug', tags: '/tag/:slug', authors: '/author/:slug' };

const require = createRequire(import.meta.url);

describe.skipIf(!hasDbIntegrationUrl)('The glossary reference plugin — DB integration (P12 task 5.1)', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let renderDb: Database;
  let classic: SiteClassic;
  let root: string;
  let generation = 0;
  let manifest: Record<string, unknown>;
  let code = '';
  const terms: Record<string, string> = {};
  const queued: Array<{ jobName: string; payload: unknown }> = [];

  const ctx = (siteId: string) => ({ siteId, userId: null, roleId: null, user: null, ip: null, headers: {}, apiKey: null }) as never;
  const service = () => new ExtensionsService({ db, siteId: A, permissionCtx: ctx(A) });
  const items = () => new ItemService({ db, siteId: A });
  const host = () => new PluginHost({ db, enqueueJob: async (j) => void queued.push({ jobName: j.jobName, payload: j.payload }) });
  const get = async (path: string) => {
    const res = await classic.app.request(path, { headers: { host: HOST } });
    return { status: res.status, html: await res.text() };
  };
  const row = async (id: string) => (await db.select().from(itemsTable).where(eq(itemsTable.id, id)))[0]!;
  /** The stored body without the editor's block ids (the write path adds them). */
  const bodyOf = async (id: string) => String(((await row(id)).data as Record<string, unknown>).body).replace(/ data-block-id="[^"]*"/g, '');
  const references = async () => {
    const r = (await host().row(A, PLUGIN))!;
    const { documents } = await host().storageOf(r, A).collection('references').query({ limit: 200 });
    return documents.map((d) => { const data = d.data as Record<string, unknown>; return `${String(data.term_slug)}→${String(data.title)}`; }).sort();
  };
  const article = async (slug: string, title: string, body: string, status: 'published' | 'draft' = 'published') =>
    ((await items().create('articles', { data: { title, slug, locale: 'en', body }, status, publishedAt: new Date('2026-09-02T00:00:00Z') })) as { id: string }).id;

  /** What a crawler reads in a head. */
  function seoOf(html: string) {
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
    const all = (re: RegExp) => [...head.matchAll(re)].map((m) => m.slice(1).join(' '));
    return {
      title: all(/<title>([^<]*)<\/title>/g),
      description: all(/<meta name="description" content="([^"]*)">/g),
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

  /** Run the plugin's subscription until it has nothing left (its own body edits come back as events). */
  async function deliver(runner: EventConsumerRunner) {
    const defs = (await host().loadAll(A, 'events')).flatMap(consumersOf);
    expect(defs.map((d) => d.name)).toEqual([`plugin:${A}:${PLUGIN}:link-on-publish`]);
    for (let i = 0; i < 4; i++) await runner.runOnce(defs[0]!);
  }

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('glossary-plugin');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    classic = createSiteClassic({ db: renderDb, now: () => NOW, traffic: false, sweepIntervalMs: 0 });
    root = await mkdtemp(join(tmpdir(), 'heopress-p12-glossary-'));

    await db.delete(sites).where(eq(sites.id, A));
    await db.insert(sites).values({ id: A, name: 'Terms Site', defaultLanguage: 'en' });
    await upgradeSitePreset(db, A);
    await db.insert(siteDomains).values({ siteId: A, hostname: HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z') });
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
    await new ContentSettingsService({ db, siteId: A, actor: { userId: null } }).update({
      availableLocales: ['en', 'fr'], timezone: 'UTC', siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: PERMALINKS, allowCrossSiteTranslations: false,
      sponsorDisclosure: true, sponsorRel: true, version: r!.version,
    } as never);
    await rebuildSiteProjection(db, A);

    // Admin, official signature verified (the plugin is `heopress-*`): these suites check the plugin, not the gates
    // of installation. Bundles are inline `data:` modules, trusted for the test.
    vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection, action) => ({ collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] }) as never);
    vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: true, isOfficial: true, reason: 'ok' } as never);
    vi.spyOn(ExtensionSandbox.prototype as unknown as { isTrustedBundleUrl(u: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);

    manifest = JSON.parse(await readFile(require.resolve('@heopress/plugin-glossary/heopress-extension.json'), 'utf8')) as Record<string, unknown>;
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

  it('its shipped manifest is valid (marketplace rules included) and installs: the term collection on this site', async () => {
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
    const [coll] = await db.select().from(collections).where(and(eq(collections.siteId, A), eq(collections.name, TERMS)));
    expect(coll?.meta).toMatchObject({ extension: { name: PLUGIN, namespace: 'heopress_glossary', collection: 'terms' } });

    const term = async (slug: string, title: string, extra: Record<string, unknown>) =>
      ((await items().create(TERMS, { data: { title, slug, body: `<p>${title} explained at length.</p>`, ...extra }, status: 'published', publishedAt: new Date('2026-09-01T00:00:00Z') })) as { id: string }).id;
    terms.alpha = await term('alpha', 'Alpha', { excerpt: 'The first letter.', source_url: 'https://example.com/alpha', source_title: 'Alphabet notes' });
    terms.beta = await term('beta', 'Beta', { excerpt: 'The second letter.', aliases: 'second letter' });
  });

  // ---------- event subscription: links and references after publish ----------

  let notes = '';

  it('after an article is published, its terms link to their pages and the references are recorded', async () => {
    const runner = new EventConsumerRunner(db);
    const [def] = (await host().loadAll(A, 'events')).flatMap(consumersOf);
    await runner.register(def!);
    notes = await article('reading-notes', 'Reading notes', '<p>Alpha comes before Beta. Alpha again.</p><h2>Beta</h2>');
    const published = await row(notes);
    await deliver(runner);

    const body = await bodyOf(notes);
    expect(body).toBe(
      '<p><a href="/glossary/alpha/" title="The first letter." data-heopress-glossary="alpha">Alpha</a> comes before ' +
        '<a href="/glossary/beta/" title="The second letter." data-heopress-glossary="beta">Beta</a>. Alpha again.</p><h2>Beta</h2>',
    );
    // One new version (the plugin's edit, through the normal write path); its own edit came back as an event and changed nothing.
    expect((await row(notes)).version).toBe(published.version + 1);
    expect((await row(notes)).status).toBe('published');
    expect(await references()).toEqual(['alpha→Reading notes', 'beta→Reading notes']);

    // An editor changes the article: Beta is gone, the alias links instead.
    const v = (await row(notes)).version;
    await items().patch('articles', notes, { data: { body: '<p>Only Alpha, and the second letter.</p>' }, expectedVersion: v } as never);
    await deliver(runner);
    expect(await bodyOf(notes)).toBe(
      '<p>Only <a href="/glossary/alpha/" title="The first letter." data-heopress-glossary="alpha">Alpha</a>, and the ' +
        '<a href="/glossary/beta/" title="The second letter." data-heopress-glossary="beta">second letter</a>.</p>',
    );
    expect(await references()).toEqual(['alpha→Reading notes', 'beta→Reading notes']);
    await items().patch('articles', notes, { data: { body: '<p>Only Alpha now.</p>' }, expectedVersion: (await row(notes)).version } as never);
    await deliver(runner);
    expect(await references()).toEqual(['alpha→Reading notes']);

    // A draft is left alone; unpublishing drops the references.
    const draft = await article('draft-notes', 'Draft notes', '<p>Alpha in a draft.</p>', 'draft');
    await deliver(runner);
    expect(await bodyOf(draft)).toBe('<p>Alpha in a draft.</p>');
    const other = await article('other-notes', 'Other notes', '<p>Beta elsewhere.</p>');
    await deliver(runner);
    expect(await references()).toEqual(['alpha→Reading notes', 'beta→Other notes']);
    await items().patch('articles', other, { status: 'draft', expectedVersion: (await row(other)).version } as never);
    await deliver(runner);
    expect(await references()).toEqual(['alpha→Reading notes']);

    // A new or changed term queues the full recomputation (the job below).
    queued.length = 0;
    terms.gamma = ((await items().create(TERMS, { data: { title: 'Gamma', slug: 'gamma', excerpt: 'The third letter.', source_url: 'https://example.com/gamma' }, status: 'published' })) as { id: string }).id;
    await deliver(runner);
    expect(queued).toEqual([{ jobName: 'relink', payload: { term: terms.gamma } }]);
  });

  // ---------- rendering: both engines ----------

  it('Classic renders the term page (tooltip component, citation), the index and the linked article body', async () => {
    const page = await get('/glossary/alpha/');
    expect(page.status).toBe(200);
    expect(page.html).toContain('class="heopress-glossary heopress-glossary-term"');
    expect(page.html).toContain('<aside class="heopress-glossary-tooltip" role="note"><dfn>Alpha</dfn> <span>The first letter.</span></aside>');
    expect(page.html).toContain('Alpha explained at length.');
    expect(page.html).toContain('<a href="https://example.com/alpha">Alphabet notes</a>');
    expect(seoOf(page.html).canonical).toEqual([`${ORIGIN}/glossary/alpha/`]);
    // The plugin's structured data: a DefinedTerm in the page's one graph, written by the core.
    expect(seoOf(page.html).jsonLd).toHaveLength(1);
    expect(graphOf(page.html)).toContainEqual(expect.objectContaining({ '@type': 'DefinedTerm', name: 'Alpha', description: 'The first letter.' }));

    const index = await get('/glossary/');
    expect(index.status).toBe(200);
    expect(index.html).toContain('class="heopress-glossary heopress-glossary-index"');
    expect(index.html).toMatch(/<dt><a href="[^"]*\/glossary\/alpha\/">Alpha<\/a><\/dt><dd>The first letter.<\/dd>/);
    expect(index.html).toMatch(/<dt><a href="[^"]*\/glossary\/beta\/">Beta<\/a><\/dt>/);

    // The article: the plugin's links, the definition as their title (the public body drops the marker).
    const notesPage = await get('/reading-notes/');
    expect(notesPage.status).toBe(200);
    expect(notesPage.html).toContain('<a href="/glossary/alpha/" title="The first letter.">Alpha</a>');
    expect(notesPage.html).not.toContain('data-heopress-glossary');
    // The starter theme does not place the component: no trace of it on an article.
    expect(notesPage.html).not.toContain('heopress-glossary-tooltip');
  });

  it('Astro builds the same pages from the page data; Classic and Astro say the same', async () => {
    const { live, snapshot } = await build();
    expect(snapshot.pages.map((p) => p.path)).toEqual(expect.arrayContaining(['/glossary/alpha/', '/glossary/beta/', '/glossary/', '/reading-notes/']));
    for (const path of ['/glossary/alpha/', '/glossary/', '/reading-notes/']) {
      const fromClassic = await get(path);
      const fromAstro = await readFile(pageFile(live, path), 'utf8');
      expect(seoOf(fromAstro), path).toEqual(seoOf(fromClassic.html));
    }
    const term = await readFile(pageFile(live, '/glossary/alpha/'), 'utf8');
    expect(term).toContain('class="heopress-glossary heopress-glossary-term"');
    expect(term).toContain('<aside class="heopress-glossary-tooltip" role="note"><dfn>Alpha</dfn> <span>The first letter.</span></aside>');
    expect(term).toContain('<a href="https://example.com/alpha">Alphabet notes</a>');
    const index = await readFile(pageFile(live, '/glossary/'), 'utf8');
    expect(index).toMatch(/<dt><a href="[^"]*\/glossary\/alpha\/">Alpha<\/a><\/dt><dd>The first letter.<\/dd>/);
    const notesPage = await readFile(pageFile(live, '/reading-notes/'), 'utf8');
    expect(notesPage).toContain('<a href="/glossary/alpha/" title="The first letter.">Alpha</a>');
    expect(notesPage).not.toContain('heopress-glossary-tooltip');
  }, 240_000);

  // ---------- gate check ----------

  it('the gate: a term definition without a source citation needs review; with one the plugin check passes', async () => {
    const pipelineHost = new PipelinePluginHost({ db, env: {} });
    const gate = new QualityGate({ db, siteId: A, pluginGateChecks: (s) => pipelineHost.gateChecks(s) });
    const run = async (termId: string) => {
      const [prod] = await db
        .insert(aiProductions)
        .values({ siteId: A, idempotencyKey: `glossary-${termId}-${Math.random()}`, mode: 'write', collection: TERMS, sources: [], promptVersion: 'test', status: 'drafted', itemId: termId })
        .returning({ id: aiProductions.id });
      return gate.run({ productionId: prod!.id });
    };
    const ruleOf = (checks: Array<{ rule: string; status: string; evidence?: unknown }>) => checks.find((c) => c.rule === 'ext:heopress_glossary:citation');

    const missing = await run(terms.beta!);
    expect(ruleOf(missing.checks)).toMatchObject({ status: 'needs_review', evidence: expect.objectContaining({ missing: 'source_url' }) });
    expect(missing.status).not.toBe('passed');

    const cited = await run(terms.alpha!);
    expect(ruleOf(cited.checks)).toMatchObject({ status: 'passed', evidence: expect.objectContaining({ source: 'https://example.com/alpha' }) });

    // Only terms: the check is declared for the term collection, an article's gate does not run it.
    const [prod] = await db
      .insert(aiProductions)
      .values({ siteId: A, idempotencyKey: `glossary-article-${Math.random()}`, mode: 'write', collection: 'articles', sources: [], promptVersion: 'test', status: 'drafted', itemId: notes })
      .returning({ id: aiProductions.id });
    expect(ruleOf((await gate.run({ productionId: prod!.id })).checks)).toBeUndefined();
  });

  // ---------- scheduled job: batches ----------

  it('the periodic recomputation runs one batch per run and continues after the last article done', async () => {
    // Articles published while the subscription was not running: unlinked so far. One is on hold.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await article(`batch-${i}`, `Batch ${i}`, `<p>Gamma number ${i}.</p>`));
    await items().setHold('articles', ids[2]!, true, (await row(ids[2]!)).version);
    await db.update(extensions).set({ settings: { batch_size: 2 } }).where(and(eq(extensions.siteId, A), eq(extensions.name, PLUGIN)));
    // In the order the plugin reads them (by id, in the database's collation).
    const published = ((await items().list('articles', { status: 'published', sort: ['id'], limit: 200 } as never)) as { data: Array<{ id: string }> }).data.map((r) => r.id);
    expect(published.length).toBeGreaterThanOrEqual(6);

    const runner = new PluginJobRunner({ db, host: host() });
    const req = { siteId: A, extensionName: PLUGIN, jobName: 'relink', trigger: 'schedule' as const };
    const progress = async () => (await db.select().from(pluginJobs).where(and(eq(pluginJobs.siteId, A), eq(pluginJobs.jobName, 'relink'))))[0]?.progress ?? null;

    // First batch: the first two articles in id order, then it continues from the second.
    expect(await runner.run(req)).toMatchObject({ status: 'continued' });
    expect(await progress()).toEqual({ after: published[1] });
    const linkedNow = async () => (await Promise.all(ids.map(async (id) => (await bodyOf(id)).includes('/glossary/gamma/')))).filter(Boolean).length;
    const firstBatch = published.slice(0, 2).filter((id) => ids.includes(id) && id !== ids[2]).length;
    expect(await linkedNow()).toBe(firstBatch);

    // The next batches pick up where it stopped, until a short batch ends the run.
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const out = await runner.run({ ...req, trigger: 'continuation' });
      outcomes.push(out.status);
      if (out.status !== 'continued') break;
    }
    expect(outcomes[outcomes.length - 1]).toBe('succeeded');
    expect(outcomes.length).toBe(Math.floor(published.length / 2) - 1 + 1);
    expect(await progress()).toBeNull();
    // Every published article links Gamma, but the held one: its edit is refused and left for later, the run goes on.
    for (const id of ids) expect((await bodyOf(id)).includes('/glossary/gamma/'), id).toBe(id !== ids[2]);
    expect(await bodyOf(ids[0]!)).toContain('<a href="/glossary/gamma/" title="The third letter." data-heopress-glossary="gamma">Gamma</a>');
    // Running again changes nothing.
    const versions = await Promise.all(ids.map(async (id) => (await row(id)).version));
    for (let i = 0; i < 10; i++) if ((await runner.run({ ...req, trigger: 'manual' })).status !== 'continued') break;
    expect(await Promise.all(ids.map(async (id) => (await row(id)).version))).toEqual(versions);
    expect(await references()).toEqual(expect.arrayContaining(['gamma→Batch 0', 'gamma→Batch 1', 'gamma→Batch 3', 'gamma→Batch 4']));
  });

  // ---------- never blocks a publish ----------

  it('declares no pre-publish hook: with a bundle that does not load, publishing goes on', async () => {
    await db.update(extensions).set({ bundleUrl: `data:text/javascript,${encodeURIComponent('throw new Error("broken build")')}` }).where(and(eq(extensions.siteId, A), eq(extensions.name, PLUGIN)));
    expect(await host().loadAll(A, 'events')).toEqual([]);
    const id = await article('published-anyway', 'Published anyway', '<p>Alpha.</p>');
    expect((await row(id)).status).toBe('published');
    const rows = await db.select({ id: itemsTable.id }).from(itemsTable).where(inArray(itemsTable.id, [id]));
    expect(rows).toHaveLength(1);
  });
});
