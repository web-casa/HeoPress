/**
 * Plugin runtime extension points (HeoPress P12 tasks 3.1–3.4, 3.7; spec extensions/runtime-extensions):
 *
 *  - jobs: one run at a time per site, plugin and job; the kill switch and disabling stop them; per-run duration and
 *    request limits terminate a run; a long scan continues in batches from its saved progress;
 *  - public endpoints: a form from an approved (static) origin is accepted, a foreign or missing origin refused; a signed
 *    callback is accepted once, a forged or replayed one refused; over the rate 429; never another site's data;
 *  - events: a subscription that was off continues from its position; a pre-publish hook can only veto (a veto, an
 *    attempt to change the item and a timeout all leave the item as it was);
 *  - private storage: per site and plugin, another plugin's namespace refused, kept when the plugin is disabled.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import {
  agentFreezes,
  collections,
  deploymentTargets,
  extensions,
  fields,
  items,
  pluginJobRuns,
  pluginJobs,
  pluginStorage,
  siteDomains,
  sites,
  type Database,
} from '@heopress/database';
import { EnvKeyProvider, MemoryRateLimiter } from '@heopress/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { ExtensionSandbox } from '../extensions/sandbox';
import { PluginHost } from '../extensions/runtime/plugin-host';
import { PluginJobRunner, PluginJobScheduler } from '../extensions/runtime/jobs';
import { consumersOf } from '../extensions/runtime/events';
import { handlePluginEndpoint, rotateCallbackSecret, signCallback, type EndpointRequestInput } from '../extensions/runtime/endpoints';
import { EventConsumerRunner } from '../modules/events/consumer-runner';
import { ItemService } from '../services/item-service';
import { sweepDuePublish } from '../services/scheduler-worker';

const A = 'p12rt-a';
const B = 'p12rt-b';
const KEYS = new EnvKeyProvider(new Map([['v0', Buffer.alloc(32, 7).toString('base64')]]), 'v0');

/** What the test plugins do: each bundle hands its context to `register` here. */
interface Harness {
  register: Record<string, (ctx: PluginCtx) => void>;
}
interface PluginCtx {
  meta: { name: string };
  extensionPoints: { register(point: string, def: unknown): void };
  storage: { collection(ns: string): { get(id: string): Promise<{ data: Record<string, unknown> } | null>; put(id: string, d: Record<string, unknown>): Promise<unknown>; query(q?: unknown): Promise<{ documents: Array<{ id: string; data: Record<string, unknown> }> }> } };
  items: { list(c: string, p?: unknown): Promise<unknown> };
  fetch(url: string): Promise<Response>;
  settings: { all(): Promise<Record<string, unknown>> };
}
declare global {
  // eslint-disable-next-line no-var
  var __p12rt: Harness | undefined;
}

const bundle = (key: string) =>
  `data:text/javascript,${encodeURIComponent(`export default (ctx) => { globalThis.__p12rt.register[${JSON.stringify(key)}](ctx); return {}; }`)}`;

describe.skipIf(!hasDbIntegrationUrl)('P12 plugin runtime — DB integration', () => {
  let db: Database;
  let raw: postgres.Sql;

  beforeAll(async () => {
    db = await connectDbIntegration('p12-plugin-runtime');
    raw = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
  });
  afterAll(async () => {
    if (db) for (const id of [A, B]) await db.delete(sites).where(eq(sites.id, id));
    await db?.execute(sql`DELETE FROM lumibase_event_consumers WHERE name LIKE ${`plugin:${A}:%`}`);
    await raw?.end({ timeout: 1 });
  });
  beforeEach(async () => {
    vi.stubEnv('HEOPRESS_ENV', 'development');
    vi.spyOn(ExtensionSandbox.prototype as unknown as { isTrustedBundleUrl(u: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);
    globalThis.__p12rt = { register: {} };
    for (const id of [A, B]) {
      await db.delete(sites).where(eq(sites.id, id));
      await db.insert(sites).values({ id, name: id });
      const [coll] = await db.insert(collections).values({ siteId: id, name: 'articles', label: 'Articles' }).returning({ id: collections.id });
      await db.insert(fields).values([
        { siteId: id, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' },
        { siteId: id, collectionId: coll!.id, name: 'summary', type: 'string', interface: 'input' },
      ]);
    }
    await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE name LIKE ${`plugin:${A}:%`}`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function install(siteId: string, name: string, capabilities: string[], manifest: Record<string, unknown> = {}, key = name) {
    await db.insert(extensions).values({
      siteId,
      name,
      key: name,
      version: '1.0.0',
      type: 'hook',
      enabled: true,
      bundleUrl: bundle(key),
      manifest,
      capabilities,
      requestedCapabilities: capabilities,
      permissionsStatus: 'approved',
    });
  }
  const setEnabled = (siteId: string, name: string, enabled: boolean) =>
    db.update(extensions).set({ enabled }).where(and(eq(extensions.siteId, siteId), eq(extensions.name, name)));
  const host = () => new PluginHost({ db });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ─── 3.1 / 3.2 jobs ─────────────────────────────────────────────────────────

  describe('jobs', () => {
    it('runs one instance at a time per site, plugin and job', async () => {
      let running = 0;
      let peak = 0;
      globalThis.__p12rt!.register.single = (ctx) =>
        ctx.extensionPoints.register('jobs', {
          name: 'scan',
          schedule: { everyMinutes: 60 },
          run: async () => {
            running++;
            peak = Math.max(peak, running);
            await sleep(300);
            running--;
          },
        });
      await install(A, 'single', ['ext:jobs']);
      await install(B, 'single', ['ext:jobs']);
      const runner = new PluginJobRunner({ db, host: host() });
      const req = { siteId: A, extensionName: 'single', jobName: 'scan', trigger: 'manual' as const };
      const results = await Promise.all([runner.run(req), runner.run(req), runner.run(req)]);
      expect(results.filter((r) => r.status === 'succeeded')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'skipped' && r.reason === 'busy')).toHaveLength(2);
      expect(peak).toBe(1);
      // Another site's same job is its own singleton; the lease is released afterwards.
      const [b, again] = await Promise.all([runner.run({ ...req, siteId: B }), sleep(10).then(() => runner.run(req))]);
      expect(b.status).toBe('succeeded');
      expect(again.status).toBe('succeeded');
    });

    it('the kill switch and disabling stop new runs; disabling stops a run in progress', async () => {
      let started = 0;
      globalThis.__p12rt!.register.killable = (ctx) =>
        ctx.extensionPoints.register('jobs', {
          name: 'tick',
          schedule: { everyMinutes: 5 },
          maxDurationMs: 5_000,
          run: async (job: { signal: AbortSignal }) => {
            started++;
            await new Promise<void>((resolve) => job.signal.addEventListener('abort', () => resolve(), { once: true }));
            await ctx.storage.collection('log').put('after-stop', { x: 1 }); // refused: the run was stopped
          },
        });
      await install(A, 'killable', ['ext:jobs'], { storage: { log: { indexes: [] } } });
      const h = host();
      const runner = new PluginJobRunner({ db, host: h, stopCheckMs: 50 });
      const scheduler = new PluginJobScheduler({ db, host: h, runner, dispatch: async () => {} });

      await db.insert(agentFreezes).values({ siteId: A, scope: 'site', reason: 'test' });
      expect(await scheduler.tick()).toEqual([]);
      expect(await runner.run({ siteId: A, extensionName: 'killable', jobName: 'tick', trigger: 'manual' })).toEqual({ status: 'skipped', reason: 'kill-switch' });
      await db.delete(agentFreezes).where(eq(agentFreezes.siteId, A));
      expect((await scheduler.tick()).map((r) => r.jobName)).toEqual(['tick']);

      // Disabled while running: the run is stopped, and its later context calls are refused.
      const run = runner.run({ siteId: A, extensionName: 'killable', jobName: 'tick', trigger: 'manual' });
      await sleep(100);
      await setEnabled(A, 'killable', false);
      const outcome = await run;
      expect(outcome).toMatchObject({ status: 'stopped' });
      await sleep(50);
      expect(await db.select().from(pluginStorage).where(eq(pluginStorage.siteId, A))).toHaveLength(0);
      expect(started).toBe(1);
      expect(await runner.run({ siteId: A, extensionName: 'killable', jobName: 'tick', trigger: 'manual' })).toEqual({ status: 'skipped', reason: 'disabled' });
      expect(await new PluginJobScheduler({ db, host: host(), runner, dispatch: async () => {} }).tick()).toEqual([]);
    });

    it('a run over its duration or request limit is terminated, not extended', async () => {
      let lateWrite: unknown = 'not attempted';
      globalThis.__p12rt!.register.limited = (ctx) => {
        ctx.extensionPoints.register('jobs', {
          name: 'slow',
          maxDurationMs: 200,
          maxRetries: 0,
          run: async () => {
            await sleep(500);
            lateWrite = await Promise.resolve()
              .then(() => ctx.storage.collection('log').put('late', { x: 1 }))
              .then(() => 'written', (e: Error) => e.name);
          },
        });
        ctx.extensionPoints.register('jobs', {
          name: 'chatty',
          maxRequests: 0,
          maxRetries: 0,
          run: async () => {
            await ctx.fetch('https://api.example.com/x');
          },
        });
      };
      await install(A, 'limited', ['ext:jobs', 'http:fetch:api.example.com'], { storage: { log: { indexes: [] } } });
      const runner = new PluginJobRunner({ db, host: host() });
      const slow = await runner.run({ siteId: A, extensionName: 'limited', jobName: 'slow', trigger: 'manual' });
      expect(slow).toMatchObject({ status: 'timeout' });
      await sleep(450);
      expect(lateWrite).toBe('RunLimitError');
      expect(await db.select().from(pluginStorage).where(eq(pluginStorage.siteId, A))).toHaveLength(0);

      const chatty = await runner.run({ siteId: A, extensionName: 'limited', jobName: 'chatty', trigger: 'manual' });
      expect(chatty).toMatchObject({ status: 'limit' });
      const runs = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.siteId, A));
      expect(runs.map((r) => r.status).sort()).toEqual(['limit', 'timeout']);
    });

    it('continues a long scan in batches from its saved progress, also after a run was cut short', async () => {
      const seen: number[] = [];
      let failOnce = true;
      globalThis.__p12rt!.register.batches = (ctx) =>
        ctx.extensionPoints.register('jobs', {
          name: 'rescan',
          schedule: { everyMinutes: 60 },
          maxDurationMs: 1_000,
          run: async (job: { progress: unknown; checkpoint(p: unknown): Promise<void>; continueLater(p: unknown): void }) => {
            let next = (job.progress as { next?: number } | null)?.next ?? 0;
            for (let n = 0; n < 4 && next < 10; n++, next++) {
              if (next === 6 && failOnce) {
                failOnce = false;
                throw new Error('upstream hiccup');
              }
              seen.push(next);
              await job.checkpoint({ next: next + 1 });
            }
            if (next < 10) job.continueLater({ next });
          },
        });
      await install(A, 'batches', ['ext:jobs']);
      const runner = new PluginJobRunner({ db, host: host() });
      const req = { siteId: A, extensionName: 'batches', jobName: 'rescan', trigger: 'schedule' as const };
      expect(await runner.run(req)).toMatchObject({ status: 'continued' });
      const [state1] = await db.select().from(pluginJobs).where(eq(pluginJobs.siteId, A));
      expect(state1!.progress).toEqual({ next: 4 });
      expect(state1!.nextRunAt!.getTime()).toBeLessThan(Date.now() + 5_000);
      // The second batch fails half-way: its checkpoint stays, the retry resumes there.
      expect(await runner.run({ ...req, trigger: 'continuation' })).toMatchObject({ status: 'failed' });
      const [state2] = await db.select().from(pluginJobs).where(eq(pluginJobs.siteId, A));
      expect(state2!.progress).toEqual({ next: 6 });
      expect(state2!.attempts).toBe(1);
      expect(await runner.run({ ...req, trigger: 'retry' })).toMatchObject({ status: 'succeeded' });
      expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const [done] = await db.select().from(pluginJobs).where(eq(pluginJobs.siteId, A));
      expect(done!.progress).toBeNull();
      expect(done!.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    });

    it('a job on an undeclared extension point is never registered', async () => {
      globalThis.__p12rt!.register.nojobs = (ctx) => {
        try {
          ctx.extensionPoints.register('jobs', { name: 'x', run: () => {} });
        } catch {
          /* refused and recorded */
        }
      };
      await install(A, 'nojobs', ['ext:events']);
      const runner = new PluginJobRunner({ db, host: host() });
      expect(await runner.run({ siteId: A, extensionName: 'nojobs', jobName: 'x', trigger: 'manual' })).toEqual({ status: 'skipped', reason: 'disabled' });
    });
  });

  // ─── 3.3 public endpoints ───────────────────────────────────────────────────

  describe('public endpoints', () => {
    beforeEach(async () => {
      globalThis.__p12rt!.register.forms = (ctx) => {
        ctx.extensionPoints.register('endpoints', {
          name: 'subscribe',
          kind: 'form',
          ratePerMinute: 3,
          handle: async (req: { body: { email?: string } }, c: { siteId: string }) => {
            await ctx.storage.collection('subscribers').put(String(req.body.email).replace(/[^a-z0-9]/gi, '_'), { email: req.body.email, site: c.siteId });
            const all = await ctx.storage.collection('subscribers').query();
            return { status: 201, body: { count: all.documents.length, sites: [...new Set(all.documents.map((d) => d.data.site))] } };
          },
        });
        ctx.extensionPoints.register('endpoints', {
          name: 'order',
          kind: 'callback',
          handle: async (req: { body: unknown }) => ({ body: { received: req.body } }),
        });
      };
      for (const site of [A, B]) await install(site, 'forms', ['ext:endpoints'], { storage: { subscribers: { indexes: [['email']] } } });
      await db.insert(siteDomains).values({ siteId: A, hostname: 'a.example.com', kind: 'custom', status: 'active', isPrimary: true });
      await db.insert(siteDomains).values({ siteId: B, hostname: 'b.example.com', kind: 'custom', status: 'active', isPrimary: true });
      // Site A is also deployed statically (e.g. Cloudflare Pages).
      await db.insert(deploymentTargets).values({ siteId: A, provider: 'cloudflare-pages', name: 'pages', projectId: 'p', tokenCiphertext: 'x', tokenKeyId: 'v0', productionUrl: 'https://a-static.example.com' });
    });

    const deps = (limiter = new MemoryRateLimiter()) => ({ db, host: host(), keys: KEYS, rateLimiter: limiter });
    const form = (over: Partial<EndpointRequestInput> & { origin?: string | null; email?: string } = {}): EndpointRequestInput => ({
      host: 'a.example.com',
      siteParam: null,
      plugin: 'forms',
      endpoint: 'subscribe',
      method: 'POST',
      headers: { origin: over.origin === undefined ? 'https://a-static.example.com' : over.origin, referer: null, contentType: 'application/x-www-form-urlencoded', timestamp: null, nonce: null, signature: null },
      body: `email=${encodeURIComponent(over.email ?? 'reader@example.com')}`,
      clientIp: '203.0.113.7',
      ...over,
    });

    it('accepts a form from the site\'s static deployment, refuses a foreign or missing origin', async () => {
      const ok = await handlePluginEndpoint(deps(), form());
      expect(ok.status).toBe(201);
      expect(ok.headers?.['Access-Control-Allow-Origin']).toBe('https://a-static.example.com');
      // From a static page, through the CMS's public address: the site is named.
      expect((await handlePluginEndpoint(deps(), form({ host: 'cms.example.com', siteParam: A, email: 'b@example.com' }))).status).toBe(201);
      expect((await handlePluginEndpoint(deps(), form({ origin: 'https://evil.example.net' }))).status).toBe(403);
      // Site B's own origin is not one of A's.
      expect((await handlePluginEndpoint(deps(), form({ origin: 'https://b.example.com' }))).status).toBe(403);
      const missing = await handlePluginEndpoint(deps(), form({ origin: null }));
      expect(missing).toMatchObject({ status: 403, body: { errors: [{ code: 'ORIGIN_REQUIRED' }] } });
      expect((await handlePluginEndpoint(deps(), form({ origin: 'null' }))).status).toBe(403);
    });

    it('never reaches another site\'s data: the host decides the site, storage is per site', async () => {
      await handlePluginEndpoint(deps(), form({ host: 'b.example.com', origin: 'https://b.example.com', email: 'b-only@example.com' }));
      // Site A's host with site B named: the host wins (and B's origin is refused on A).
      const res = await handlePluginEndpoint(deps(), form({ siteParam: B }));
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ data: { count: 1, sites: [A] } });
      const bDocs = await db.select().from(pluginStorage).where(eq(pluginStorage.siteId, B));
      expect(bDocs.map((d) => d.docId)).toEqual(['b_only_example_com']);
    });

    it('answers 429 over the rate limit and 413 over the body limit', async () => {
      const limiter = new MemoryRateLimiter();
      for (let i = 0; i < 3; i++) expect((await handlePluginEndpoint(deps(limiter), form({ email: `r${i}@example.com` }))).status).toBe(201);
      const limited = await handlePluginEndpoint(deps(limiter), form());
      expect(limited.status).toBe(429);
      expect(limited.headers?.['Retry-After']).toBeDefined();
      expect((await handlePluginEndpoint(deps(), form({ body: `email=${'x'.repeat(17 * 1024)}` }))).status).toBe(413);
    });

    it('accepts a signed callback once; a forged or replayed one is refused', async () => {
      const secret = await rotateCallbackSecret(db, KEYS, A, 'forms');
      const ts = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ order: 'o-1' });
      const cb = (over: Partial<EndpointRequestInput['headers']> = {}, b = body): EndpointRequestInput => ({
        ...form(),
        endpoint: 'order',
        body: b,
        headers: { origin: null, referer: null, contentType: 'application/json', timestamp: ts, nonce: 'nonce-0123456789abcdef', signature: signCallback(secret, ts, 'nonce-0123456789abcdef', b), ...over },
      });
      const ok = await handlePluginEndpoint(deps(), cb());
      expect(ok).toMatchObject({ status: 200, body: { data: { received: { order: 'o-1' } } } });
      expect(await handlePluginEndpoint(deps(), cb())).toMatchObject({ status: 409, body: { errors: [{ code: 'REPLAYED' }] } });
      expect((await handlePluginEndpoint(deps(), cb({ nonce: 'nonce-other-0123456789' }))).status).toBe(401); // signature covers the nonce
      expect((await handlePluginEndpoint(deps(), cb({ signature: signCallback('not-the-secret', ts, 'nonce-x-0123456789abc', body), nonce: 'nonce-x-0123456789abc' }))).status).toBe(401);
      const old = String(Number(ts) - 3600);
      expect(await handlePluginEndpoint(deps(), cb({ timestamp: old, nonce: 'nonce-old-0123456789', signature: signCallback(secret, old, 'nonce-old-0123456789', body) }))).toMatchObject({ status: 401, body: { errors: [{ code: 'STALE_TIMESTAMP' }] } });
      // Site B has no secret: the same signed request is not valid there.
      expect((await handlePluginEndpoint(deps(), { ...cb({ nonce: 'nonce-b-0123456789ab', signature: signCallback(secret, ts, 'nonce-b-0123456789ab', body) }), host: 'b.example.com' })).status).toBe(401);
    });

    it('a disabled plugin or one without ext:endpoints has no endpoints', async () => {
      await setEnabled(A, 'forms', false);
      expect((await handlePluginEndpoint(deps(), form())).status).toBe(404);
      await setEnabled(A, 'forms', true);
      await db.update(extensions).set({ capabilities: [] }).where(and(eq(extensions.siteId, A), eq(extensions.name, 'forms')));
      expect((await handlePluginEndpoint(deps(), form())).status).toBe(404);
    });
  });

  // ─── 3.4 events and pre-publish hooks ───────────────────────────────────────

  describe('events', () => {
    async function emit(siteId: string, itemId: string, collection = 'articles') {
      await raw`INSERT INTO lumibase_cdc_change_events (id, site_id, collection, item_id, operation, actor_type, source)
                VALUES (${`ev_${itemId}_${Math.random().toString(36).slice(2, 8)}`}, ${siteId}, ${collection}, ${itemId}, 'update', 'system', 'system')`;
    }

    it('a subscription that was off continues from its position, at least once, own collections only', async () => {
      const seen: string[] = [];
      globalThis.__p12rt!.register.listener = (ctx) =>
        ctx.extensionPoints.register('events', {
          kind: 'subscription',
          name: 'changes',
          collections: ['articles', 'pages'],
          handle: async (e: { itemId: string; siteId: string }) => {
            seen.push(`${e.siteId}:${e.itemId}`);
          },
        });
      await install(A, 'listener', ['ext:events', 'cdc:subscribe:articles']);
      const consumers = async () => {
        const loaded = await host().loadAll(A, 'events');
        return loaded.flatMap(consumersOf);
      };
      const runner = new EventConsumerRunner(db);
      const [def] = await consumers();
      expect(def!.name).toBe(`plugin:${A}:listener:changes`);
      await runner.register(def!);
      await emit(A, 'one');
      await runner.runOnce(def!);
      expect(seen).toEqual([`${A}:one`]);

      // Off: no consumer is built, events keep coming.
      await setEnabled(A, 'listener', false);
      expect(await consumers()).toEqual([]);
      await emit(A, 'two');
      await emit(A, 'p', 'pages'); // no cdc:subscribe:pages
      await emit(B, 'other-site');
      await emit(A, 'three');
      await setEnabled(A, 'listener', true);
      const [again] = await consumers();
      await runner.runOnce(again!);
      expect(seen).toEqual([`${A}:one`, `${A}:two`, `${A}:three`]);
    });

    it('a pre-publish hook can only veto: veto, an edit attempt and a timeout leave the item as it was', async () => {
      globalThis.__p12rt!.register.guard = (ctx) => {
        ctx.extensionPoints.register('events', {
          kind: 'pre-publish',
          name: 'needs-summary',
          collections: ['articles'],
          check: (item: { data: Record<string, unknown> }) => (item.data.summary ? undefined : { veto: 'An article needs a summary.' }),
        });
        ctx.extensionPoints.register('events', {
          kind: 'pre-publish',
          name: 'meddler',
          collections: ['articles'],
          check: (item: { data: Record<string, unknown> }) => {
            if (item.data.title === 'edit-in-place') item.data.title = 'changed by plugin';
            if (item.data.title === 'edit-by-answer') return { data: { title: 'changed by plugin' } };
            if (item.data.title === 'slow') return new Promise((r) => setTimeout(r, 1_000));
            return undefined;
          },
          timeoutMs: 200,
        });
      };
      await install(A, 'guard', ['ext:events']);
      const svc = new ItemService({ db, siteId: A });
      const created = (await svc.create('articles', { data: { title: 'draft' } })) as { id: string; version: number };
      const state = async () => (await db.select({ s: items.status, v: items.version, d: items.data }).from(items).where(eq(items.id, created.id)))[0]!;

      const vetoed = (await svc.patch('articles', created.id, { status: 'published', expectedVersion: created.version } as never).catch((e: unknown) => e)) as { code?: string; vetoes?: Array<{ kind: string; reason: string }> };
      expect(vetoed.code).toBe('PUBLISH_VETOED');
      expect(vetoed.vetoes).toEqual([expect.objectContaining({ kind: 'veto', reason: 'An article needs a summary.' })]);
      expect(await state()).toMatchObject({ s: 'draft', v: created.version });

      for (const [title, kind] of [['edit-in-place', 'modified'], ['edit-by-answer', 'modified'], ['slow', 'timeout']] as const) {
        const { v } = await state();
        const err = (await svc
          .patch('articles', created.id, { data: { title, summary: 'ok' }, status: 'published', expectedVersion: v } as never)
          .catch((e: unknown) => e)) as { code?: string; vetoes?: Array<{ kind: string }> };
        expect(err.code, title).toBe('PUBLISH_VETOED');
        expect(err.vetoes?.map((x) => x.kind), title).toEqual([kind]);
        expect(await state()).toMatchObject({ s: 'draft', v, d: { title: 'draft' } });
      }
      // Recorded.
      const audit = (await db.execute(sql`SELECT metadata FROM lumibase_audit_log WHERE site_id = ${A} AND event = 'extension_prepublish_veto'`)) as unknown as Array<{ metadata: { kind: string } }>;
      expect(audit.map((r) => r.metadata.kind).sort()).toEqual(['modified', 'modified', 'timeout', 'veto']);

      // Nothing to object to: published. A draft save does not ask the hooks.
      const { v } = await state();
      await svc.patch('articles', created.id, { data: { title: 'fine', summary: 'ok' }, status: 'published', expectedVersion: v } as never);
      expect((await state()).s).toBe('published');
      // Created published without a summary: refused before anything is written.
      await expect(svc.create('articles', { data: { title: 'direct' }, status: 'published' })).rejects.toMatchObject({ code: 'PUBLISH_VETOED' });
      // Disabled plugin: no hooks.
      await setEnabled(A, 'guard', false);
      await expect(svc.create('articles', { data: { title: 'direct' }, status: 'published' })).resolves.toBeTruthy();
    });
    it('fails closed: a plugin with ext:events whose bundle does not load blocks publishing until it is disabled', async () => {
      globalThis.__p12rt!.register.broken = () => {
        throw new Error('bundle crashed while loading');
      };
      await install(A, 'broken', ['ext:events']);
      const svc = new ItemService({ db, siteId: A });
      const created = (await svc.create('articles', { data: { title: 'draft' } })) as { id: string; version: number };
      const state = async () => (await db.select({ s: items.status, v: items.version }).from(items).where(eq(items.id, created.id)))[0]!;

      // Manual publish: refused with the reason, the version unchanged.
      const err = (await svc.patch('articles', created.id, { status: 'published', expectedVersion: created.version } as never).catch((e: unknown) => e)) as {
        code?: string;
        message?: string;
        vetoes?: Array<{ extension: string; kind: string; reason: string }>;
      };
      expect(err.code).toBe('PUBLISH_VETOED');
      expect(err.vetoes).toEqual([{ extension: 'broken', hook: '*', kind: 'load-failed', reason: 'plugin broken failed to load; disable or fix it to publish' }]);
      expect(err.message).toContain('plugin broken failed to load; disable or fix it to publish');
      expect(await state()).toMatchObject({ s: 'draft', v: created.version });
      await expect(svc.create('articles', { data: { title: 'direct' }, status: 'published' })).rejects.toMatchObject({ code: 'PUBLISH_VETOED' });
      const audit = (await db.execute(sql`SELECT metadata FROM lumibase_audit_log WHERE site_id = ${A} AND event = 'extension_prepublish_veto'`)) as unknown as Array<{ metadata: { kind: string } }>;
      expect(audit.map((r) => r.metadata.kind)).toContain('load-failed');
      // Another site is not affected.
      await expect(new ItemService({ db, siteId: B }).create('articles', { data: { title: 'b' }, status: 'published' })).resolves.toBeTruthy();

      // Scheduled publish: the sweep refuses it the same way and leaves the item as it was.
      const past = new Date(Date.now() - 60_000);
      await db.update(items).set({ publishAt: past }).where(eq(items.id, created.id));
      await sweepDuePublish({ db });
      expect(await state()).toMatchObject({ s: 'draft', v: created.version });

      // Disabled: the block is gone — the sweep and a manual publish go through.
      await setEnabled(A, 'broken', false);
      await sweepDuePublish({ db });
      expect((await state()).s).toBe('published');
      await expect(svc.create('articles', { data: { title: 'direct' }, status: 'published' })).resolves.toBeTruthy();
    });
  });

  // ─── 3.7 private storage ────────────────────────────────────────────────────

  describe('private storage', () => {
    it('isolates plugins and sites, needs declared indexes, survives disabling', async () => {
      const probes: Record<string, unknown> = {};
      globalThis.__p12rt!.register.owner = (ctx) =>
        ctx.extensionPoints.register('jobs', {
          name: 'write',
          run: async (job: { siteId: string }) => {
            await ctx.storage.collection('results').put('r1', { url: 'https://example.com/a', status: 404, site: job.siteId });
          },
        });
      globalThis.__p12rt!.register.snoop = (ctx) =>
        ctx.extensionPoints.register('jobs', {
          name: 'read',
          run: async () => {
            probes.foreign = await Promise.resolve()
              .then(() => ctx.storage.collection('results').get('r1'))
              .then(() => 'read', (e: Error) => e.name);
            probes.own = await ctx.storage.collection('mine').query();
          },
        });
      await install(A, 'owner', ['ext:jobs'], { storage: { results: { indexes: [['status']] } } });
      await install(B, 'owner', ['ext:jobs'], { storage: { results: { indexes: [['status']] } } });
      await install(A, 'snoop', ['ext:jobs'], { storage: { mine: { indexes: [] } } });
      const h = host();
      const runner = new PluginJobRunner({ db, host: h });
      expect(await runner.run({ siteId: A, extensionName: 'owner', jobName: 'write', trigger: 'manual' })).toMatchObject({ status: 'succeeded' });
      expect(await runner.run({ siteId: A, extensionName: 'snoop', jobName: 'read', trigger: 'manual' })).toMatchObject({ status: 'succeeded' });
      expect(probes.foreign).toBe('CapabilityError');
      expect(probes.own).toEqual({ documents: [], next: null });
      const denied = (await db.execute(sql`SELECT metadata FROM lumibase_audit_log WHERE site_id = ${A} AND event = 'extension_capability_denied'`)) as unknown as Array<{ metadata: { capability: string } }>;
      expect(denied.map((d) => d.metadata.capability)).toContain('storage:results');

      // Site B's copy of the same plugin sees nothing of A.
      const storageB = h.storageOf({ name: 'owner', manifest: { storage: { results: { indexes: [['status']] } } } }, B);
      expect(await storageB.collection('results').count()).toBe(0);
      const storageA = h.storageOf({ name: 'owner', manifest: { storage: { results: { indexes: [['status']] } } } }, A);
      expect((await storageA.collection('results').query({ where: { status: 404 } })).documents.map((d) => d.id)).toEqual(['r1']);
      await expect(storageA.collection('results').query({ where: { url: 'x' } })).rejects.toMatchObject({ code: 'INDEX_REQUIRED' });

      // Disabled: kept, and exportable.
      await setEnabled(A, 'owner', false);
      const exported = await storageA.exportAll();
      expect(exported.namespaces.results?.map((d) => d.id)).toEqual(['r1']);
      expect(await db.select().from(pluginStorage).where(and(eq(pluginStorage.siteId, A), eq(pluginStorage.extensionName, 'owner')))).toHaveLength(1);
    });

    it('a plugin reads its own settings on this site, as saved in its panel, without being reloaded', async () => {
      const seen: Array<Record<string, unknown>> = [];
      globalThis.__p12rt!.register.configured = (ctx) =>
        ctx.extensionPoints.register('jobs', { name: 'read', run: async () => void seen.push(await ctx.settings.all()) });
      const manifest = { admin: { settings: [{ key: 'depth', type: 'integer', default: 2 }, { key: 'label', type: 'string' }] } };
      await install(A, 'configured', ['ext:jobs'], manifest);
      await install(B, 'configured', ['ext:jobs'], manifest);
      const runner = new PluginJobRunner({ db, host: host() });
      const req = { siteId: A, extensionName: 'configured', jobName: 'read', trigger: 'manual' as const };
      await runner.run(req);
      await db.update(extensions).set({ settings: { depth: 5, undeclared: 'x' } }).where(and(eq(extensions.siteId, A), eq(extensions.name, 'configured')));
      await runner.run(req);
      await runner.run({ ...req, siteId: B });
      expect(seen).toEqual([{ depth: 2, label: null }, { depth: 5, label: null }, { depth: 2, label: null }]);
    });
  });
});
