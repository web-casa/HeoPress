/**
 * The extension-point test matrix (HeoPress P12 task 9.1; ADR-0015 nine extension points, ADR-0017 quality gate).
 *
 * For each of the nine extension points five cells, each backed by a real test: (1) declared use works, (2) undeclared use
 * is refused, (3) another site is out of reach, (4) a plugin's failure is contained — the host, other plugins and other
 * sites carry on, (5) a contract version mismatch (the manifest's HeoPress version range) is refused. The matrix itself —
 * which test backs which cell, here or in the suites of tasks 1.x–4.x — is `helpers/extension-matrix.ts`; its
 * consistency is checked by `extension-matrix.test.ts`. This suite holds the cells no earlier suite covered, named
 * `9.1 <point> × <cell>: …`.
 *
 * Plugins are inline bundles loaded through the capability sandbox (development mode: unsigned bundles accepted), the
 * way the runtime and pipeline hosts load them. Classic serves the sites through its own read-only rendering role.
 *
 * Needs DATABASE_OWNER_URL (to provision this suite's rendering role, as a deployment does).
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  auditLog,
  collections,
  ensureRenderRole,
  extensions,
  ingestSourceRuns,
  items as itemsTable,
  pluginJobs,
  schema,
  siteContentSettings,
  siteDomains,
  sites,
  type Database,
} from '@heopress/database';
import type { JobOptions, QueueProvider, StorageObject, StorageProvider } from '@heopress/runtime';
import { MemoryRateLimiter } from '@heopress/runtime';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import type { ExtensionPoint } from '@heopress/contracts/extensions';
import type { Bindings } from '../env';
import { ExtensionSandbox, type ExtensionSandboxDeps } from '../extensions/sandbox';
import { PluginHost } from '../extensions/runtime/plugin-host';
import { PluginJobRunner, PluginJobScheduler, type JobRunRequest } from '../extensions/runtime/jobs';
import { consumersOf, runPrePublishHooks } from '../extensions/runtime/events';
import { handlePluginEndpoint, type EndpointRequestInput } from '../extensions/runtime/endpoints';
import { PluginPanels } from '../extensions/runtime/admin-panels';
import { PipelinePluginHost } from '../extensions/pipeline/host';
import { declaredGateChecks, pluginBuildSteps } from '../extensions/pipeline/declarations';
import { EventConsumerRunner } from '../modules/events/consumer-runner';
import { ExtensionMutationError, ExtensionsService } from '../services/extensions-service';
import { ExtensionVerifierService } from '../services/extension-verifier';
import { publicExtensionsOfSite } from '../services/extensions/content-extensions';
import { IngestSourceService } from '../services/ingest/source-service';
import { processSourceJob, setSourceRunner } from '../services/ingest/source-worker';
import { createIngestRunner } from '../services/ingest/url-runner';
import { RobotsCache } from '../services/ingest/robots';
import { ItemService } from '../services/item-service';
import { reconcileOfficialExtensions } from '../services/official-extension-reconciler';
import { PermissionService } from '../services/permission-service';
import { runSiteTransaction, type SiteTransaction } from '../services/rls-transaction';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

const RENDER_ROLE = 'heopress_render_ext_matrix';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const A = 'site_p12_matrix_a';
const B = 'site_p12_matrix_b';
const HOST = 'matrix-a.example.com';
const HOST_B = 'matrix-b.example.com';
const JOBS = 'jobs.example.com';
/** The instance version the services check manifests against. */
const VERSION = '1.2.0';
const ENV = { HEOPRESS_ENV: 'development', HEOPRESS_VERSION: VERSION } as Record<string, unknown>;
/** How long a plugin's load may take in this suite (the production default is 5 s). */
const LOAD_MS = 400;

/** The test plugins: each inline bundle hands its context to `register[key]` and returns what that returns. */
interface Harness {
  register: Record<string, (ctx: PluginCtx) => unknown>;
}
interface PluginCtx {
  extensionPoints: { register(point: string, def: unknown): void };
  items: {
    list(c: string, p?: unknown): Promise<unknown>;
    detail(c: string, id: string): Promise<unknown>;
    create(c: string, payload: { data: Record<string, unknown>; status?: string }): Promise<unknown>;
    patch(c: string, id: string, patch: { data?: Record<string, unknown>; status?: string; expectedVersion?: number }): Promise<unknown>;
    delete(c: string, id: string): Promise<unknown>;
  };
}
declare global {
  // eslint-disable-next-line no-var
  var __p12mx: Harness | undefined;
}
const bundle = (key: string) =>
  `data:text/javascript,${encodeURIComponent(`export default async (ctx) => (await globalThis.__p12mx.register[${JSON.stringify(key)}](ctx)) ?? {};`)}`;
const never = () => new Promise<never>(() => {});

/** A sandbox as the hosts build it, with this suite's load limit. */
function quickSandbox(env: Record<string, unknown>, deps: ExtensionSandboxDeps): ExtensionSandbox {
  const sandbox = new ExtensionSandbox(env as never, deps);
  const load = sandbox.load.bind(sandbox);
  sandbox.load = (opts) => load({ ...opts, timeoutMs: LOAD_MS });
  return sandbox;
}

// ─── Content plugin manifests (collections, routes) ─────────────────────────

const page = (body: string) => `<!doctype html>
<html lang="{{ page.locale }}">
<head>
<meta charset="utf-8">
{% seo_head %}
</head>
<body>
${body}
</body>
</html>`;
const ASTRO_PAGE = `---
import type { PageDataPage } from '@heopress/astro-kit';
import SeoHead from '@heopress/astro-kit/SeoHead.astro';
interface Props { page: PageDataPage }
const { page } = Astro.props;
const { vm } = page;
---
<html lang={vm.page.locale}>
<head>
<meta charset="utf-8">
<SeoHead page={page} />
</head>
<body><h1>{vm.item?.title}</h1></body>
</html>`;
const NOTE_FIELDS = [
  { name: 'title', type: 'string', interface: 'input' },
  { name: 'slug', type: 'string', interface: 'slug' },
  { name: 'body', type: 'text', interface: 'wysiwyg' },
];

/** A plugin with a `notes` collection and, unless `path` is null, an item route over it. */
function notesManifest(path: string | null, body = '<h1 class="note">{{ item.title }}</h1>\n{% item_body %}', kind: 'item' | 'list' = 'item'): Record<string, unknown> {
  return {
    collections: [{ name: 'notes', label: 'Notes', fields: NOTE_FIELDS }],
    ...(path
      ? {
          routes: [{ id: 'note', kind, path, collection: 'notes', template: 'note', ...(kind === 'list' ? { title: 'Notes' } : {}) }],
          templates: { classic: { note: page(body) }, astro: { note: ASTRO_PAGE } },
        }
      : {}),
  };
}

// ─── One declaration per extension point (cell 5) ───────────────────────────

const POINT_DECLARATIONS: Record<ExtensionPoint, { capabilities: string[]; manifest: Record<string, unknown> }> = {
  collections: { capabilities: ['ext:collections'], manifest: notesManifest(null) },
  routes: { capabilities: ['ext:collections', 'ext:routes'], manifest: notesManifest('/v-notes/:slug') },
  'source-adapters': { capabilities: ['ext:source-adapters', `http:fetch:${JOBS}`], manifest: { sourceAdapters: [{ id: 'board', label: 'Board' }] } },
  'gate-checks': { capabilities: ['ext:gate-checks'], manifest: { gateChecks: [{ id: 'tone', label: 'Tone' }] } },
  jobs: { capabilities: ['ext:jobs'], manifest: {} },
  endpoints: { capabilities: ['ext:endpoints'], manifest: {} },
  events: { capabilities: ['ext:events'], manifest: {} },
  'admin-panels': {
    capabilities: ['ext:admin-panels'],
    manifest: { storage: { results: { indexes: [] } }, admin: { pages: [{ id: 'results', title: 'Results', storage: 'results' }] } },
  },
  'build-steps': { capabilities: ['ext:build-steps'], manifest: { buildSteps: [{ id: 'pdf', label: 'PDF', source: 'console.log(1);' }] } },
};

// ─── Ingest doubles (source adapters) ───────────────────────────────────────

class MemoryStorage implements StorageProvider {
  objects = new Map<string, Buffer>();
  async put(key: string, data: ReadableStream | Buffer): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(data) ? data : Buffer.from(await new Response(data).arrayBuffer()));
  }
  async get(key: string): Promise<StorageObject | null> {
    const b = this.objects.get(key);
    return b ? { key, body: b, size: b.byteLength } : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(prefix = ''): Promise<{ keys: string[] }> {
    return { keys: [...this.objects.keys()].filter((k) => k.startsWith(prefix)) };
  }
}
class FakeQueue implements QueueProvider {
  jobs: Array<{ queue: string; data: unknown; options?: JobOptions }> = [];
  async enqueue<T>(queue: string, _name: string, data: T, options?: JobOptions): Promise<string> {
    this.jobs.push({ queue, data, options });
    return String(this.jobs.length);
  }
  process(): void {}
  async getStatus() {
    return null;
  }
}

describe.skipIf(!hasDbIntegrationUrl)('ADR-0015 extension-point matrix — DB integration (P12 task 9.1)', () => {
  let db: Database;
  let raw: postgres.Sql;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let classic: SiteClassic;
  const articles: Record<string, string> = {};

  const ctx = (siteId: string) => ({ siteId, userId: null, roleId: null, user: null, ip: null, headers: {}, apiKey: null }) as never;
  const service = (siteId = A, version = VERSION) =>
    new ExtensionsService({ db, siteId, env: { ...ENV, HEOPRESS_VERSION: version } as unknown as Bindings, permissionCtx: ctx(siteId) });
  const get = async (path: string, host = HOST) => {
    const res = await classic.app.request(path, { headers: { host } });
    return { status: res.status, html: await res.text() };
  };
  const refusal = async (p: Promise<unknown>) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionMutationError);
    return err as ExtensionMutationError;
  };
  const inSite = <T,>(siteId: string, fn: (tx: SiteTransaction) => Promise<T>) => runSiteTransaction(db, siteId, fn);
  const host = () => new PluginHost({ db, env: ENV, createSandbox: quickSandbox });
  const pipelineHost = () => new PipelinePluginHost({ db, env: ENV, sandboxFor: (_s, deps) => quickSandbox(ENV, deps) });
  const denials = async (siteId: string) =>
    (await db.select().from(auditLog).where(and(eq(auditLog.siteId, siteId), eq(auditLog.event, 'extension_capability_denied')))).map((r) => r.metadata as Record<string, unknown>);

  /** A plugin row as installed and approved (the runtime suites' way: the install path is not under test here). */
  async function install(siteId: string, name: string, capabilities: string[], manifest: Record<string, unknown> = {}, extra: Partial<typeof extensions.$inferInsert> = {}) {
    const [row] = await db
      .insert(extensions)
      .values({ siteId, name, key: name.replace(/[^a-z0-9]+/g, '_'), version: '1.0.0', type: 'hook', enabled: true, bundleUrl: bundle(name), manifest, capabilities, requestedCapabilities: capabilities, permissionsStatus: 'approved', ...extra })
      .returning();
    return row!;
  }
  /** An install request through the service (the operator approves every requested capability). */
  const request = (name: string, capabilities: string[], manifest: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    ({ name, version: '1.0.0', type: 'hook', enabled: false, bundleUrl: `https://${JOBS}/${name.replace(/\W+/g, '-')}.js`, capabilities, approvedCapabilities: capabilities, manifest, ...over }) as never;

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('extension-matrix');
    raw = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    classic = createSiteClassic({ db: drizzle(renderClient, { schema }) as unknown as Database, now: () => NOW, traffic: false, sweepIntervalMs: 0 });

    await db.delete(sites).where(inArray(sites.id, [A, B]));
    await db.insert(sites).values([
      { id: A, name: 'Matrix A', defaultLanguage: 'en' },
      { id: B, name: 'Matrix B', defaultLanguage: 'en' },
    ]);
    await db.insert(siteDomains).values([
      { siteId: A, hostname: HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z') },
      { siteId: B, hostname: HOST_B, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z') },
    ]);
    for (const id of [A, B]) {
      await upgradeSitePreset(db, id);
      const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, id));
      await new ContentSettingsService({ db, siteId: id, actor: { userId: null } }).update({
        availableLocales: ['en'], timezone: 'UTC', siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
        localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { articles: '/:slug', pages: '/:slug', categories: '/category/:slug', tags: '/tag/:slug', authors: '/author/:slug' },
        allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: r!.version,
      } as never);
      await rebuildSiteProjection(db, id);
      const created = (await new ItemService({ db, siteId: id }).create('articles', {
        data: { title: `Reading notes ${id}`, slug: 'reading-notes', locale: 'en', body: '<p>Notes.</p>' },
        status: 'published',
        publishedAt: new Date('2026-09-02T00:00:00Z'),
      })) as { id: string };
      articles[id] = created.id;
    }
  }, 180_000);

  beforeEach(() => {
    vi.stubEnv('HEOPRESS_ENV', 'development');
    vi.stubEnv('HEOPRESS_VERSION', VERSION);
    globalThis.__p12mx = { register: {} };
    // Inline bundles are trusted here; the operator may manage plugins; signatures are not what this suite checks.
    vi.spyOn(ExtensionSandbox.prototype as unknown as { isTrustedBundleUrl(u: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);
    vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection, action) => ({ collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] }) as never);
    vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: true, isOfficial: false, reason: 'ok' } as never);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setSourceRunner(null);
    // Through the service where content is involved, so routes and projections are withdrawn with the row.
    for (const siteId of [A, B]) {
      for (const row of await db.select().from(extensions).where(eq(extensions.siteId, siteId))) {
        if ((row.manifest as { routes?: unknown } | null)?.routes) await db.update(extensions).set({ enabled: false }).where(eq(extensions.id, row.id));
      }
      await db.delete(extensions).where(eq(extensions.siteId, siteId));
      await rebuildSiteProjection(db, siteId);
    }
    await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE name LIKE ${'plugin:site_p12_matrix_%'}`);
    await db.delete(extensions).where(and(isNull(extensions.siteId), eq(extensions.marketplaceSlug, 'heopress-pageview-counter')));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.delete(sites).where(inArray(sites.id, [A, B]));
    await classic?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    await raw?.end({ timeout: 1 });
  });

  // ─── collections ───────────────────────────────────────────────────────────

  it('9.1 collections × undeclared: collections without ext:collections are refused at install and never installed from a row', async () => {
    const err = await refusal(service().installExtension(request('acme/undeclared', [], notesManifest(null))));
    expect(err.code).toBe('INVALID_MANIFEST');
    expect(err.message).toContain('collections need the ext:collections capability');
    expect(await db.select().from(extensions).where(and(eq(extensions.siteId, A), eq(extensions.name, 'acme/undeclared')))).toEqual([]);
    // A row that bypassed the install checks: enabling it installs nothing.
    const row = await install(A, 'acme/rowonly', [], notesManifest(null), { enabled: false });
    await service().updateExtension(row.id, { enabled: true } as never);
    expect(await db.select().from(collections).where(and(eq(collections.siteId, A), eq(collections.name, 'acme_rowonly__notes')))).toEqual([]);
  });

  it('9.1 collections × cross-site: a plugin reads its collection on its own site only, through its job on that site', async () => {
    const coll = 'acme_shared__notes';
    for (const siteId of [A, B]) {
      const row = await service(siteId).installExtension(request('acme/shared', ['ext:collections', `items:read:${coll}`, 'ext:jobs'], notesManifest(null)));
      await service(siteId).updateExtension(row!.id, { enabled: true } as never);
      await db.update(extensions).set({ bundleUrl: bundle('acme/shared') }).where(eq(extensions.id, row!.id));
    }
    const noteA = ((await new ItemService({ db, siteId: A }).create(coll, { data: { title: 'A note', slug: 'a-note' } })) as { id: string }).id;
    const noteB = ((await new ItemService({ db, siteId: B }).create(coll, { data: { title: 'B note', slug: 'b-note' } })) as { id: string }).id;
    const seen: Record<string, unknown> = {};
    globalThis.__p12mx!.register['acme/shared'] = (c) =>
      c.extensionPoints.register('jobs', {
        name: 'read',
        run: async () => {
          const listed = (await c.items.list(coll)) as { data: Array<{ id: string }> };
          seen.ids = listed.data.map((i) => i.id);
          seen.foreign = await c.items.detail(coll, noteB).then(() => 'read', (e: { code?: string }) => e.code);
        },
      });
    expect(await new PluginJobRunner({ db, host: host() }).run({ siteId: A, extensionName: 'acme/shared', jobName: 'read', trigger: 'manual' })).toMatchObject({ status: 'succeeded' });
    expect(seen).toEqual({ ids: [noteA], foreign: 'NOT_FOUND' });
  });

  it('9.1 collections × isolation: a plugin whose enable fails installs nothing; other plugins\' collections and the site\'s content stay as they were', async () => {
    const other = await service().installExtension(request('acme/other', ['ext:collections'], notesManifest(null)));
    await service().updateExtension(other!.id, { enabled: true } as never);
    const kept = ((await new ItemService({ db, siteId: A }).create('acme_other__notes', { data: { title: 'Kept', slug: 'kept' } })) as { id: string }).id;
    // Its list route takes the path of an existing article: the enable is refused, as one transaction.
    const clash = await service().installExtension(request('acme/clash', ['ext:collections', 'ext:routes'], notesManifest('/reading-notes', '<h1>{{ route.title }}</h1>', 'list')));
    const err = await refusal(service().updateExtension(clash!.id, { enabled: true } as never));
    expect(err.code).toBe('ROUTE_CONFLICT');
    expect(await db.select().from(collections).where(and(eq(collections.siteId, A), eq(collections.name, 'acme_clash__notes')))).toEqual([]);
    expect((await db.select().from(extensions).where(eq(extensions.id, clash!.id)))[0]!.enabled).toBe(false);
    expect(await db.select({ id: itemsTable.id }).from(itemsTable).where(eq(itemsTable.id, kept))).toHaveLength(1);
    expect((await get('/reading-notes/')).status).toBe(200);
  });

  // ─── routes ────────────────────────────────────────────────────────────────

  it('9.1 routes × undeclared: routes without ext:routes are refused at install; revoking ext:routes withdraws the pages', async () => {
    const err = await refusal(service().installExtension(request('acme/noroutes', ['ext:collections'], notesManifest('/no-routes/:slug'))));
    expect(err.code).toBe('INVALID_MANIFEST');
    expect(err.message).toContain('need the ext:routes capability');

    const row = await service().installExtension(request('acme/notes', ['ext:collections', 'ext:routes'], notesManifest('/notes/:slug')));
    await service().updateExtension(row!.id, { enabled: true } as never);
    await new ItemService({ db, siteId: A }).create('acme_notes__notes', { data: { title: 'First note', slug: 'first' }, status: 'published', publishedAt: new Date('2026-09-03T00:00:00Z') });
    expect((await get('/notes/first/')).html).toContain('<h1 class="note">First note</h1>');
    // PATCH may revoke: without ext:routes the plugin has no public pages any more.
    await service().updateExtension(row!.id, { capabilities: ['ext:collections'] } as never);
    expect((await inSite(A, (tx) => publicExtensionsOfSite(tx, A))).routes).toEqual([]);
    expect((await get('/notes/first/')).status).toBe(404);
  });

  it('9.1 routes × cross-site: a plugin\'s routes exist on its own site only; another site\'s content at the same path is no conflict', async () => {
    await new ItemService({ db, siteId: B }).create('pages', { data: { title: 'B notes', slug: 'notes', locale: 'en', body: '<p>B.</p>' }, status: 'published', publishedAt: new Date('2026-09-02T00:00:00Z') });
    const row = await service().installExtension(request('acme/notes', ['ext:collections', 'ext:routes'], notesManifest('/notes', '<h1 class="list">{{ route.title }}</h1>', 'list')));
    await service().updateExtension(row!.id, { enabled: true } as never);
    expect((await get('/notes/')).html).toContain('<h1 class="list">Notes</h1>');
    expect((await inSite(B, (tx) => publicExtensionsOfSite(tx, B))).routes).toEqual([]);
    const onB = await get('/notes/', HOST_B);
    expect(onB.status).toBe(200);
    expect(onB.html).not.toContain('class="list"');
    expect(await db.select().from(collections).where(and(eq(collections.siteId, B), eq(collections.name, 'acme_notes__notes')))).toEqual([]);
  });

  it('9.1 routes × isolation: a plugin page that fails to render answers 500 alone; the site\'s other pages, other plugins and other sites are served', async () => {
    // Passes the install checks; runs past the theme engine's render limit on every request.
    const slow = await service().installExtension(request('acme/slow', ['ext:collections', 'ext:routes'], notesManifest('/slow/:slug', '{% for i in (1..50000000) %}{% endfor %}{% item_body %}')));
    const fine = await service().installExtension(request('acme/fine', ['ext:collections', 'ext:routes'], notesManifest('/fine/:slug')));
    for (const r of [slow, fine]) await service().updateExtension(r!.id, { enabled: true } as never);
    const items = new ItemService({ db, siteId: A });
    await items.create('acme_slow__notes', { data: { title: 'Slow', slug: 'one' }, status: 'published', publishedAt: new Date('2026-09-03T00:00:00Z') });
    await items.create('acme_fine__notes', { data: { title: 'Fine', slug: 'one' }, status: 'published', publishedAt: new Date('2026-09-03T00:00:00Z') });
    expect((await get('/slow/one/')).status).toBe(500);
    expect((await get('/fine/one/')).html).toContain('<h1 class="note">Fine</h1>');
    expect((await get('/reading-notes/')).status).toBe(200);
    expect((await get('/reading-notes/', HOST_B)).status).toBe(200);
  }, 30_000);

  // ─── source adapters ───────────────────────────────────────────────────────

  describe('source adapters', () => {
    const sources = (siteId = A) => new IngestSourceService({ db, siteId, actor: { isAdmin: true, userId: null } });
    const caps = ['ext:source-adapters', `http:fetch:${JOBS}`];
    const manifest = { sourceAdapters: [{ id: 'board', label: 'Board' }] };
    const create = (siteId: string, name: string, adapter: string) =>
      sources(siteId).create({ name, type: 'plugin', adapter, url: `https://${JOBS}/${name}`, scheduleTimes: ['08:00'], timezone: 'UTC' } as never);
    async function run(siteId: string, sourceId: string) {
      const queue = new FakeQueue();
      setSourceRunner(createIngestRunner({ db, storage: new MemoryStorage(), limiter: null, queue, fetch: { robots: new RobotsCache() }, sourceAdapters: (s, ref) => pipelineHost().sourceAdapter(s, ref) }));
      await processSourceJob({ db }, { siteId, sourceId, scheduledFor: '2026-10-26T08:00:00.000Z' });
      const runs = await inSite(siteId, (tx) => tx.select().from(ingestSourceRuns).where(eq(ingestSourceRuns.sourceId, sourceId)));
      return { run: runs.at(-1)!, queue };
    }
    const board = (links: (c: { url: string }) => unknown) => (c: PluginCtx) => c.extensionPoints.register('source-adapters', { id: 'board', discover: links });

    it('9.1 source-adapters × undeclared: an adapter declared without ext:source-adapters is neither offered nor loaded', async () => {
      globalThis.__p12mx!.register['acme-nocap'] = board((c) => [`${c.url}/1`]);
      await install(A, 'acme-nocap', [`http:fetch:${JOBS}`], manifest);
      expect(await sources().adapters()).toEqual([]);
      expect(await pipelineHost().sourceAdapter(A, 'acme-nocap#board')).toBeNull();
      await expect(create(A, 'nocap', 'acme-nocap#board')).rejects.toMatchObject({ code: 'UNKNOWN_ADAPTER' });
    });

    it('9.1 source-adapters × cross-site: another site neither offers nor runs the adapter', async () => {
      globalThis.__p12mx!.register['acme-jobs'] = board((c) => [`${c.url}/1`]);
      await install(A, 'acme-jobs', caps, manifest);
      expect((await sources(A).adapters()).map((a) => a.ref)).toEqual(['acme-jobs#board']);
      expect(await sources(B).adapters()).toEqual([]);
      await expect(create(B, 'borrowed', 'acme-jobs#board')).rejects.toMatchObject({ code: 'UNKNOWN_ADAPTER' });
      expect(await pipelineHost().sourceAdapter(B, 'acme-jobs#board')).toBeNull();
    });

    it('9.1 source-adapters × isolation: a failing adapter fails its own run only; one that never loads fails in bounded time; others run', async () => {
      globalThis.__p12mx!.register['acme-flaky'] = board(() => {
        throw new Error('the listing exploded');
      });
      globalThis.__p12mx!.register['acme-stuck'] = never;
      globalThis.__p12mx!.register['acme-steady'] = board((c) => [`${c.url}/jobs/1`, `${c.url}/jobs/2`]);
      for (const name of ['acme-flaky', 'acme-stuck', 'acme-steady']) await install(A, name, caps, manifest);
      await install(B, 'acme-steady', caps, manifest);
      const flaky = await create(A, 'flaky', 'acme-flaky#board');
      const stuck = await create(A, 'stuck', 'acme-stuck#board');
      const steady = await create(A, 'steady', 'acme-steady#board');
      const steadyB = await create(B, 'steady', 'acme-steady#board');

      expect((await run(A, flaky.id)).run).toMatchObject({ outcome: 'failed' });
      const started = Date.now();
      const s = await run(A, stuck.id);
      expect(s.run).toMatchObject({ outcome: 'failed' });
      expect(s.run.message).toContain('acme-stuck#board');
      expect(Date.now() - started).toBeLessThan(LOAD_MS * 10);
      const ok = await run(A, steady.id);
      expect(ok.run).toMatchObject({ outcome: 'succeeded', itemsNew: 2 });
      expect(ok.queue.jobs).toHaveLength(2);
      expect((await run(B, steadyB.id)).run).toMatchObject({ outcome: 'succeeded', itemsNew: 2 });
    });
  });

  // ─── gate checks ───────────────────────────────────────────────────────────

  it('9.1 gate-checks × undeclared: checks declared without ext:gate-checks are neither part of the policy nor loaded', async () => {
    globalThis.__p12mx!.register['acme-tone'] = (c) => c.extensionPoints.register('gate-checks', { id: 'tone', check: () => ({ verdict: 'blocked' }) });
    await install(A, 'acme-tone', [], { gateChecks: [{ id: 'tone', label: 'Tone' }] });
    expect(await inSite(A, (tx) => declaredGateChecks(tx, A))).toEqual([]);
    expect([...(await pipelineHost().gateChecks(A)).keys()]).toEqual([]);
    // Registering from a plugin without the point (loaded for another one) is refused and recorded.
    globalThis.__p12mx!.register['acme-jobs-only'] = (c) => c.extensionPoints.register('gate-checks', { id: 'tone', check: () => ({ verdict: 'passed' }) });
    await install(A, 'acme-jobs-only', ['ext:jobs']);
    expect(await host().load((await host().row(A, 'acme-jobs-only'))!)).toBeNull();
    await vi.waitFor(async () => expect(await denials(A)).toContainEqual(expect.objectContaining({ extensionName: 'acme-jobs-only', capability: 'ext:gate-checks', operation: 'register' })));
  });

  it('9.1 gate-checks × cross-site: a plugin\'s checks are part of its own site\'s gate only', async () => {
    globalThis.__p12mx!.register['acme-tone'] = (c) => c.extensionPoints.register('gate-checks', { id: 'tone', check: () => ({ verdict: 'passed' }) });
    await install(A, 'acme-tone', ['ext:gate-checks'], { gateChecks: [{ id: 'tone', label: 'Tone' }] });
    expect((await inSite(A, (tx) => declaredGateChecks(tx, A))).map((c) => c.rule)).toEqual(['ext:acme_tone:tone']);
    expect([...(await pipelineHost().gateChecks(A)).keys()]).toEqual(['ext:acme_tone:tone']);
    expect(await inSite(B, (tx) => declaredGateChecks(tx, B))).toEqual([]);
    expect([...(await pipelineHost().gateChecks(B)).keys()]).toEqual([]);
  });

  // ─── jobs ──────────────────────────────────────────────────────────────────

  it('9.1 jobs × cross-site: a job reads its own site only; a run for a site it is not installed on does not start', async () => {
    const seen: Record<string, unknown> = {};
    globalThis.__p12mx!.register.reader = (c) =>
      c.extensionPoints.register('jobs', {
        name: 'read',
        run: async () => {
          seen.ids = ((await c.items.list('articles')) as { data: Array<{ id: string }> }).data.map((i) => i.id);
          seen.foreign = await c.items.detail('articles', articles[B]!).then(() => 'read', (e: { code?: string }) => e.code);
        },
      });
    await install(A, 'reader', ['ext:jobs', 'items:read:articles']);
    const runner = new PluginJobRunner({ db, host: host() });
    expect(await runner.run({ siteId: A, extensionName: 'reader', jobName: 'read', trigger: 'manual' })).toMatchObject({ status: 'succeeded' });
    expect(seen).toEqual({ ids: [articles[A]], foreign: 'NOT_FOUND' });
    expect(await runner.run({ siteId: B, extensionName: 'reader', jobName: 'read', trigger: 'manual' })).toEqual({ status: 'skipped', reason: 'disabled' });
  });

  it('9.1 jobs × undeclared: a job with items:write but not items:publish changes drafts only; editing, unpublishing or deleting a published article is refused and recorded (P12 task 1.4)', async () => {
    const live = articles[A]!;
    const before = await new ItemService({ db, siteId: A }).detail('articles', live) as { version: number; data: Record<string, unknown>; status: string };
    const seen: Record<string, unknown> = {};
    const codeOf = (e: unknown) => (e as { name?: string; code?: string }).code ?? (e as { name?: string }).name;
    globalThis.__p12mx!.register.writer = (c) =>
      c.extensionPoints.register('jobs', {
        name: 'edit',
        run: async () => {
          seen.edit = await c.items.patch('articles', live, { data: { body: '<p>Rewritten.</p>' }, expectedVersion: before.version }).then(() => 'written', codeOf);
          seen.unpublish = await c.items.patch('articles', live, { status: 'draft', expectedVersion: before.version }).then(() => 'written', codeOf);
          seen.remove = await c.items.delete('articles', live).then(() => 'deleted', codeOf);
          const draft = (await c.items.create('articles', { data: { title: 'Plugin draft', slug: 'plugin-draft', locale: 'en', body: '<p>One.</p>' } })) as { id: string; version: number };
          seen.draft = await c.items.patch('articles', draft.id, { data: { body: '<p>Two.</p>' }, expectedVersion: draft.version }).then(() => 'written', codeOf);
          seen.draftId = draft.id;
        },
      });
    await install(A, 'writer', ['ext:jobs', 'items:write:articles']);
    expect(await new PluginJobRunner({ db, host: host() }).run({ siteId: A, extensionName: 'writer', jobName: 'edit', trigger: 'manual' })).toMatchObject({ status: 'succeeded' });
    expect(seen).toMatchObject({ edit: 'CapabilityError', unpublish: 'CapabilityError', remove: 'CapabilityError', draft: 'written' });
    const after = await new ItemService({ db, siteId: A }).detail('articles', live) as { version: number; data: Record<string, unknown>; status: string };
    expect(after).toMatchObject({ version: before.version, status: 'published', data: expect.objectContaining({ body: before.data.body }) });
    expect((await denials(A)).filter((d) => d.extensionName === 'writer').map((d) => `${d.capability} ${d.operation}`).sort()).toEqual(
      ['items:publish:articles items.delete', 'items:publish:articles items.patch', 'items:publish:articles items.patch'],
    );
    const draft = await new ItemService({ db, siteId: A }).detail('articles', seen.draftId as string) as { status: string; data: Record<string, unknown> };
    expect(draft.status).toBe('draft');
    expect(String(draft.data.body)).toContain('Two.');
    await new ItemService({ db, siteId: A }).softDelete('articles', seen.draftId as string);
  });

  it('9.1 jobs × isolation: a failing job is recorded and retried alone; a plugin that never loads does not stall the scheduler for other plugins and sites', async () => {
    const ran: string[] = [];
    globalThis.__p12mx!.register.boom = (c) =>
      c.extensionPoints.register('jobs', { name: 'tick', schedule: { everyMinutes: 60 }, maxRetries: 2, run: () => { throw new Error('boom'); } });
    globalThis.__p12mx!.register.stuck = never;
    globalThis.__p12mx!.register.calm = (c) =>
      c.extensionPoints.register('jobs', { name: 'tick', schedule: { everyMinutes: 60 }, run: (j: { siteId: string }) => void ran.push(j.siteId) });
    await install(A, 'boom', ['ext:jobs']);
    await install(A, 'stuck', ['ext:jobs']);
    await install(A, 'calm', ['ext:jobs']);
    await install(B, 'calm', ['ext:jobs']);
    const h = host();
    const runner = new PluginJobRunner({ db, host: h });
    const dispatched: JobRunRequest[] = [];
    const started = Date.now();
    await new PluginJobScheduler({ db, host: h, runner, dispatch: async (r) => void dispatched.push(r) }).tick();
    expect(Date.now() - started).toBeLessThan(LOAD_MS * 10);
    const ours = dispatched.filter((r) => r.siteId === A || r.siteId === B).map((r) => `${r.siteId}:${r.extensionName}`).sort();
    expect(ours).toEqual([`${A}:boom`, `${A}:calm`, `${B}:calm`].sort());

    const failed = await runner.run({ siteId: A, extensionName: 'boom', jobName: 'tick', trigger: 'schedule' });
    expect(failed).toMatchObject({ status: 'failed', error: 'boom' });
    const [state] = await db.select().from(pluginJobs).where(and(eq(pluginJobs.siteId, A), eq(pluginJobs.extensionName, 'boom')));
    expect(state).toMatchObject({ attempts: 1, lastStatus: 'failed', leaseToken: null });
    expect(await runner.run({ siteId: A, extensionName: 'stuck', jobName: 'tick', trigger: 'manual' })).toEqual({ status: 'skipped', reason: 'unknown-job' });
    for (const siteId of [A, B]) expect(await runner.run({ siteId, extensionName: 'calm', jobName: 'tick', trigger: 'schedule' })).toMatchObject({ status: 'succeeded' });
    expect(ran.sort()).toEqual([A, B].sort());
  });

  // ─── public endpoints ──────────────────────────────────────────────────────

  it('9.1 endpoints × isolation: a handler that throws answers 500 for its own endpoint; one that never loads answers 404 in bounded time; the others serve', async () => {
    const form = (plugin: string, host = HOST): EndpointRequestInput => ({
      host,
      siteParam: null,
      plugin,
      endpoint: 'send',
      method: 'POST',
      headers: { origin: `https://${host}`, referer: null, contentType: 'application/x-www-form-urlencoded', timestamp: null, nonce: null, signature: null },
      body: 'email=reader%40example.com',
      clientIp: '203.0.113.9',
    });
    globalThis.__p12mx!.register.crashy = (c) =>
      c.extensionPoints.register('endpoints', { name: 'send', kind: 'form', handle: () => { throw new Error('handler exploded'); } });
    globalThis.__p12mx!.register.stuckep = never;
    globalThis.__p12mx!.register.forms = (c) => c.extensionPoints.register('endpoints', { name: 'send', kind: 'form', handle: () => ({ status: 201, body: { ok: true } }) });
    await install(A, 'crashy', ['ext:endpoints']);
    await install(A, 'stuckep', ['ext:endpoints']);
    await install(A, 'forms', ['ext:endpoints']);
    await install(B, 'forms', ['ext:endpoints']);
    const deps = { db, host: host(), rateLimiter: new MemoryRateLimiter() };
    expect(await handlePluginEndpoint(deps, form('crashy'))).toMatchObject({ status: 500, body: { errors: [{ code: 'PLUGIN_ERROR' }] } });
    const started = Date.now();
    expect((await handlePluginEndpoint(deps, form('stuckep'))).status).toBe(404);
    expect(Date.now() - started).toBeLessThan(LOAD_MS * 10);
    expect(await handlePluginEndpoint(deps, form('forms'))).toMatchObject({ status: 201, body: { data: { ok: true } } });
    expect(await handlePluginEndpoint(deps, form('forms', HOST_B))).toMatchObject({ status: 201 });
  });

  // ─── events ────────────────────────────────────────────────────────────────

  async function emit(siteId: string, itemId: string, collection = 'articles') {
    await raw`INSERT INTO lumibase_cdc_change_events (id, site_id, collection, item_id, operation, actor_type, source)
              VALUES (${`ev_${itemId}_${Math.random().toString(36).slice(2, 8)}`}, ${siteId}, ${collection}, ${itemId}, 'update', 'system', 'system')`;
  }

  it('9.1 events × undeclared: a pre-publish hook needs ext:events and a manifest declaration; undeclared hooks and subscriptions are refused at load and recorded; publishing does not ask them', async () => {
    // Declaring hooks without ext:events: refused at install.
    const err = await refusal(service().installExtension(request('acme/hooks-no-events', ['ext:jobs'], { prePublishHooks: [{ name: 'veto-all' }] })));
    expect(err.code).toBe('INVALID_MANIFEST');
    expect(err.message).toContain('prePublishHooks need the ext:events capability');

    // A row that bypassed the install checks (a declaration, no ext:events): nothing of it is registered or asked.
    let asked = 0;
    const vetoAll = { kind: 'pre-publish', name: 'veto-all', check: () => (asked++, { veto: 'no' }) };
    globalThis.__p12mx!.register.sneaky = (c) => {
      for (const def of [vetoAll, { kind: 'subscription', name: 'listen', collections: ['articles'], handle: () => {} }]) {
        try {
          c.extensionPoints.register('events', def);
        } catch {
          /* refused and recorded */
        }
      }
      c.extensionPoints.register('jobs', { name: 'noop', run: () => {} });
    };
    await install(A, 'sneaky', ['ext:jobs', 'cdc:subscribe:articles'], { prePublishHooks: [{ name: 'veto-all' }] });
    const h = host();
    expect(await h.loadAll(A, 'events')).toEqual([]);
    const [loaded] = await h.loadAll(A, 'jobs');
    expect(loaded!.prePublish).toEqual([]);
    expect(loaded!.subscriptions).toEqual([]);
    expect(consumersOf(loaded!)).toEqual([]);
    await vi.waitFor(async () => expect((await denials(A)).filter((d) => d.extensionName === 'sneaky' && d.capability === 'ext:events')).toHaveLength(2));

    // ext:events but no declaration: the hook is refused at load and recorded; its subscription works.
    globalThis.__p12mx!.register.undeclared = (c) => {
      c.extensionPoints.register('events', vetoAll);
      c.extensionPoints.register('events', { kind: 'subscription', name: 'listen', collections: ['articles'], handle: () => {} });
    };
    await install(A, 'undeclared', ['ext:events', 'cdc:subscribe:articles']);
    const plugin = await h.load((await h.row(A, 'undeclared'))!);
    expect(plugin!.refusedHooks).toEqual(['veto-all']);
    expect(plugin!.prePublish).toEqual([]);
    expect(consumersOf(plugin!)).toHaveLength(1);
    await vi.waitFor(async () =>
      expect(await denials(A)).toContainEqual(expect.objectContaining({ extensionName: 'undeclared', capability: 'prePublishHooks:veto-all', operation: 'register:pre-publish' })),
    );

    await expect(runPrePublishHooks({ db, host: h, siteId: A }, { collection: 'articles', itemId: articles[A]!, status: 'published', data: { title: 'x' } })).resolves.toBeUndefined();
    const created = await new ItemService({ db, siteId: A }).create('articles', { data: { title: 'Published anyway', slug: 'published-anyway', locale: 'en' }, status: 'published' });
    expect(created).toMatchObject({ status: 'published' });
    expect(asked).toBe(0);
  });

  it('9.1 events × isolation: a failing subscription is retried at its own position; other plugins\' and sites\' subscriptions carry on; a throwing declared hook is a recorded veto; a subscriber that does not load blocks nothing', async () => {
    const seen: string[] = [];
    let flakyCalls = 0;
    globalThis.__p12mx!.register.flaky = (c) => {
      c.extensionPoints.register('events', { kind: 'subscription', name: 'changes', collections: ['articles'], handle: () => { flakyCalls++; throw new Error('handler exploded'); } });
      c.extensionPoints.register('events', { kind: 'pre-publish', name: 'crash', collections: ['pages'], check: () => { throw new Error('hook exploded'); } });
    };
    globalThis.__p12mx!.register.steady = (c) =>
      c.extensionPoints.register('events', { kind: 'subscription', name: 'changes', collections: ['articles'], handle: (e: { siteId: string; itemId: string }) => void seen.push(`${e.siteId}:${e.itemId}`) });
    await install(A, 'flaky', ['ext:events', 'cdc:subscribe:articles'], { prePublishHooks: [{ name: 'crash', collections: ['pages'] }] });
    await install(A, 'steady', ['ext:events', 'cdc:subscribe:articles']);
    await install(B, 'steady', ['ext:events', 'cdc:subscribe:articles']);
    const runner = new EventConsumerRunner(db);
    const defs = async (siteId: string) => (await host().loadAll(siteId, 'events')).flatMap(consumersOf);
    const [flakyDef] = (await defs(A)).filter((d) => d.name.includes(':flaky:'));
    const [steadyDef] = (await defs(A)).filter((d) => d.name.includes(':steady:'));
    const [steadyB] = await defs(B);
    for (const d of [flakyDef!, steadyDef!, steadyB!]) await runner.register(d);
    await emit(A, 'one');
    await emit(B, 'b-one');

    expect(await runner.runOnce(flakyDef!)).toMatchObject({ handled: 0, failed: 1 });
    expect(await runner.runOnce(steadyDef!)).toMatchObject({ handled: 1, failed: 0 });
    expect(await runner.runOnce(steadyB!)).toMatchObject({ handled: 1, failed: 0 });
    expect(seen.sort()).toEqual([`${A}:one`, `${B}:b-one`].sort());
    // Not acknowledged: the event waits for its retry at the failing consumer's own position.
    expect(await runner.runOnce(flakyDef!)).toMatchObject({ handled: 0, failed: 0 });
    expect(flakyCalls).toBe(1);
    const [failure] = (await db.execute(sql`SELECT state, attempts FROM lumibase_event_consumer_failures WHERE consumer = ${flakyDef!.name}`)) as unknown as Array<{ state: string; attempts: number }>;
    expect(failure).toMatchObject({ state: 'retrying', attempts: 1 });

    // A hook that throws cannot let a publish through, and the host carries on.
    const err = (await runPrePublishHooks({ db, host: host(), siteId: A }, { collection: 'pages', itemId: null, status: 'published', data: { title: 'x' } }).catch((e: unknown) => e)) as { code?: string; vetoes?: Array<{ kind: string; reason: string }> };
    expect(err.code).toBe('PUBLISH_VETOED');
    expect(err.vetoes).toEqual([expect.objectContaining({ extension: 'flaky', kind: 'error', reason: 'the hook failed: hook exploded' })]);
    await expect(runPrePublishHooks({ db, host: host(), siteId: B }, { collection: 'pages', itemId: null, status: 'published', data: { title: 'x' } })).resolves.toBeUndefined();

    // A subscriber-only plugin whose bundle does not load: it declares no hook, so publishing goes on without it.
    globalThis.__p12mx!.register.down = () => {
      throw new Error('bundle crashed while loading');
    };
    await install(A, 'down', ['ext:events', 'cdc:subscribe:articles']);
    const published = await new ItemService({ db, siteId: A }).create('articles', { data: { title: 'While down', slug: 'while-down', locale: 'en' }, status: 'published' });
    expect(published).toMatchObject({ status: 'published' });
  });

  // ─── admin panels ──────────────────────────────────────────────────────────

  it('9.1 admin-panels × isolation: a plugin with broken declarations does not take the other plugins\' panels down', async () => {
    const good = { storage: { results: { indexes: [] } }, admin: { pages: [{ id: 'results', title: 'Results', storage: 'results' }], widgets: [{ id: 'count', title: 'Count', storage: 'results' }] } };
    // Only a row written past the install checks can look like this: a declared namespace without a declaration.
    await install(A, 'broken-panel', ['ext:admin-panels'], { storage: { results: null }, admin: good.admin });
    await install(A, 'good-panel', ['ext:admin-panels'], good);
    const panels = await new PluginPanels(db, A).list();
    expect(panels.map((p) => p.name)).toEqual(['good-panel']);
    expect(panels[0]).toMatchObject({ widgets: [{ id: 'count', count: 0 }] });
    await expect(new PluginPanels(db, A).page('good-panel', 'results')).resolves.toMatchObject({ type: 'table' });
  });

  it('9.1 admin-panels × version: an official plugin whose listing needs a newer HeoPress is not auto-installed', async () => {
    vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: true, isOfficial: true, reason: 'ok' } as never);
    const listing = (heopress: string) => ({
      name: 'heopress-pageview-counter', version: '2.0.0', type: 'panel' as const, bundleUrl: 'https://plugins.example.com/pageviews.js', marketplaceSlug: 'heopress-pageview-counter',
      publishedAt: new Date(), enabled: false, capabilities: ['ext:admin-panels'], requestedCapabilities: ['ext:admin-panels'],
      manifest: { heopress, storage: { views: { indexes: [] } }, admin: { pages: [{ id: 'views', title: 'Views', storage: 'views' }] } },
    });
    const [source] = await db.insert(extensions).values(listing('>=99.0.0')).returning();
    const env = ENV as unknown as Bindings;
    expect(await reconcileOfficialExtensions(db, env, A, { log: () => {}, error: () => {} })).toEqual({ installed: 0, skipped: 1 });
    expect(await db.select().from(extensions).where(and(eq(extensions.siteId, A), eq(extensions.name, 'heopress-pageview-counter')))).toEqual([]);
    expect(await new PluginPanels(db, A).list()).toEqual([]);
    // The same listing for this version is installed.
    await db.update(extensions).set({ manifest: listing('^1.0.0').manifest }).where(eq(extensions.id, source!.id));
    expect(await reconcileOfficialExtensions(db, env, A, { log: () => {}, error: () => {} })).toEqual({ installed: 1, skipped: 0 });
    expect((await new PluginPanels(db, A).list()).map((p) => p.name)).toEqual(['heopress-pageview-counter']);
  });

  // ─── build steps ───────────────────────────────────────────────────────────

  it('9.1 build-steps × cross-site: a trusted plugin\'s steps run in its own site\'s build only', async () => {
    const steps = { buildSteps: [{ id: 'pdf', label: 'PDF', source: 'console.log(1);' }] };
    await install(A, 'acme-pdf', ['ext:build-steps'], steps, { trusted: true });
    const planA = await inSite(A, (tx) => pluginBuildSteps(tx, A));
    expect(planA.run.map((s) => `${s.plugin}/${s.step.id}`)).toEqual(['acme-pdf/pdf']);
    expect(await inSite(B, (tx) => pluginBuildSteps(tx, B))).toEqual({ run: [], skipped: [] });
  });

  // ─── contract version (cell 5), every extension point ─────────────────────

  /**
   * A plugin declaring the point whose manifest needs another HeoPress: its install is refused naming the required
   * version (nothing is installed); an upgrade to such a version is refused and the installed version keeps running; a
   * staged upgrade is checked again when it is approved, after the instance moved on.
   */
  async function versionCell(point: ExtensionPoint) {
    const { capabilities, manifest } = POINT_DECLARATIONS[point];
    const name = `acme/v-${point}`;
    const refused = await refusal(service().installExtension(request(name, capabilities, { ...manifest, heopress: '>=2.0.0' })));
    expect(refused.code).toBe('INCOMPATIBLE_VERSION');
    expect(refused.details).toEqual({ required: '>=2.0.0', current: VERSION });
    expect(await db.select().from(extensions).where(and(eq(extensions.siteId, A), eq(extensions.name, name)))).toEqual([]);

    const row = await service().installExtension(request(name, capabilities, { ...manifest, heopress: '^1.0.0' }));
    const upgrade = (version: string, range: string, extra: string[] = []) => ({
      version, bundleUrl: `https://${JOBS}/v-${point}-${version}.js`, capabilities: [...capabilities, ...extra], manifest: { ...manifest, heopress: range },
    });
    expect((await refusal(service().upgradeExtension(row!.id, upgrade('1.1.0', '>=2.0.0') as never))).code).toBe('INCOMPATIBLE_VERSION');
    expect((await db.select().from(extensions).where(eq(extensions.id, row!.id)))[0]).toMatchObject({ version: '1.0.0', pendingUpgrade: null });

    // Staged (it adds a capability), then the instance is upgraded past the range before an admin approves.
    expect((await service().upgradeExtension(row!.id, upgrade('1.2.0', '<1.3.0', ['kv:read']) as never)).status).toBe('pending-approval');
    const approval = { approvedCapabilities: [...capabilities, 'kv:read'] };
    expect((await refusal(service(A, '1.3.0').approveUpgrade(row!.id, approval))).code).toBe('INCOMPATIBLE_VERSION');
    expect((await db.select().from(extensions).where(eq(extensions.id, row!.id)))[0]!.version).toBe('1.0.0');
    expect((await service().approveUpgrade(row!.id, approval)).extension.version).toBe('1.2.0');
  }

  it('9.1 collections × version: a manifest for another HeoPress version is refused at install, upgrade and approval', () => versionCell('collections'));
  it('9.1 routes × version: a manifest for another HeoPress version is refused at install, upgrade and approval', () => versionCell('routes'));
  it('9.1 source-adapters × version: a manifest for another HeoPress version is refused at install, upgrade and approval', () => versionCell('source-adapters'));
  it('9.1 gate-checks × version: a manifest for another HeoPress version is refused at install, upgrade and approval', () => versionCell('gate-checks'));
  it('9.1 jobs × version: a manifest for another HeoPress version is refused at install, upgrade and approval', () => versionCell('jobs'));
  it('9.1 endpoints × version: a manifest for another HeoPress version is refused at install, upgrade and approval', () => versionCell('endpoints'));
  it('9.1 events × version: a manifest for another HeoPress version is refused at install, upgrade and approval', () => versionCell('events'));
  it('9.1 admin-panels × version: a manifest for another HeoPress version is refused at install, upgrade and approval', () => versionCell('admin-panels'));
  it('9.1 build-steps × version: a manifest for another HeoPress version is refused at install, upgrade and approval', () => versionCell('build-steps'));

});
