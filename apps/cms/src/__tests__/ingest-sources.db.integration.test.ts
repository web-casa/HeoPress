import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { ingestSchedule, ingestSourceRuns, ingestSources, notifications, type Database } from '@heopress/database';
import type { IngestLicenceResource, IngestSourceResource } from '@heopress/contracts/schemas';
import type { JobOptions, QueueProvider } from '@heopress/runtime';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { runSiteTransaction } from '../services/rls-transaction';
import { processSourceJob, scheduleDueSources, setSourceRunner, SourceRunError, type SourceJobPayload } from '../services/ingest/source-worker';
import { assertUsageAllowed } from '../services/ingest/usage';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Content sources (HeoPress P08 tasks 1.1, 1.2, 1.4, 1.5; spec ingest/sources), through the whole app and the
 * scheduler: defaults of a new source, another site out of reach, terms only by administrators with a revision each,
 * an expired licence leaving only the lead, two sites' schedules in their own time zones without duplicate runs, and
 * a source paused after five failures with its administrators told why.
 */

const JWT_SECRET = 'ingest-sources-test-secret';

class FakeQueue implements QueueProvider {
  jobs: Array<{ data: SourceJobPayload; options?: JobOptions }> = [];
  async enqueue<T>(_queue: string, _name: string, data: T, options?: JobOptions): Promise<string> {
    this.jobs.push({ data: data as unknown as SourceJobPayload, options });
    return String(this.jobs.length);
  }
  process(): void {}
  async getStatus() {
    return null;
  }
}

describe.skipIf(!hasDbIntegrationUrl)('content sources — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('ingest-sources');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'ing', jwtSecret: JWT_SECRET });
  });
  afterEach(() => setSourceRunner(null));
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const as = async (who: 'adminA' | 'adminB' | 'onlyA' | 'onlyB', site: 'a' | 'b') => fx.headers(site, await fx.session(who, site));
  const call = (pathname: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(pathname, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const create = async (headers: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const res = await call('/api/v1/ingest/sources', 'POST', headers, {
      name: 'Example feed',
      type: 'rss',
      url: 'https://news.example.com/feed.xml',
      scheduleTimes: ['08:00'],
      timezone: 'UTC',
      ...extra,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { data: IngestSourceResource }).data;
  };
  const sourceRow = async (siteId: string, id: string) =>
    runSiteTransaction(db, siteId, async (tx) => (await tx.select().from(ingestSources).where(and(eq(ingestSources.siteId, siteId), eq(ingestSources.id, id))))[0]!);

  it('an editor adds an RSS source without terms: licence unknown, discovery only, not commercial, low trust, scheduled', async () => {
    const editor = await as('onlyA', 'a');
    const s = await create(editor);
    expect(s).toMatchObject({ licenceStatus: 'unknown', usageMode: 'discovery_only', commercialUse: false, trustLevel: 'low', status: 'active', maxItemsPerRun: 20, effectiveUsageMode: 'discovery_only' });
    expect(s.nextRunAt).not.toBeNull();
    const history = ((await (await call(`/api/v1/ingest/sources/${s.id}/licences`, 'GET', editor)).json()) as { data: IngestLicenceResource[] }).data;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ licenceStatus: 'unknown', usageMode: 'discovery_only', setBy: fx.users.onlyA.id });
    // A list page needs its selectors.
    const res = await call('/api/v1/ingest/sources', 'POST', editor, { name: 'List', type: 'list_page', url: 'https://news.example.com/', scheduleTimes: ['08:00'], timezone: 'UTC' });
    expect(res.status).toBe(400);
  });

  it('a user with permissions only in site A cannot add to or change site B (403); B\'s sources are out of reach from A (404)', async () => {
    const b = await create(await as('adminB', 'b'));
    const body = { name: 'x', type: 'rss', url: 'https://x.example.com/', scheduleTimes: ['08:00'], timezone: 'UTC' };
    // Editor of A, only a reader in B (write permission only in A): adding to B is 403; reading B is fine.
    const bothOnB = fx.headers('b', await fx.session('both', 'b'));
    expect((await call('/api/v1/ingest/sources', 'POST', bothOnB, body)).status).toBe(403);
    expect((await call(`/api/v1/ingest/sources/${b.id}/pause`, 'POST', bothOnB)).status).toBe(403);
    // A's principals with no membership in B: refused (401 for credentials of another site, 403 for a non-member).
    for (const headers of [fx.headers('b', await fx.session('onlyA', 'b')), fx.headers('b', fx.apiKeys.aEditor.token), fx.headers('b', await fx.session('onlyA', 'a'))]) {
      for (const [method, path] of [['POST', '/api/v1/ingest/sources'], ['GET', '/api/v1/ingest/sources'], ['POST', `/api/v1/ingest/sources/${b.id}/pause`]] as const) {
        const res = await call(path, method, headers, method === 'POST' ? body : undefined);
        expect([401, 403], `${method} ${path}`).toContain(res.status);
        expect(await res.text()).not.toContain('New York');
      }
    }
    // B's source id addressed through site A: not there.
    const adminA = await as('adminA', 'a');
    expect((await call(`/api/v1/ingest/sources/${b.id}`, 'GET', adminA)).status).toBe(404);
    expect((await call(`/api/v1/ingest/sources/${b.id}/licences`, 'POST', adminA, { licenceStatus: 'own', usageMode: 'facts_only' })).status).toBe(404);
    expect((await sourceRow(fx.sites.b, b.id)).licenceStatus).toBe('unknown');
  });

  it('only administrators set licence, usage and trust, each change a revision with its evidence; an editor cannot raise them', async () => {
    const editor = await as('onlyA', 'a');
    const admin = await as('adminA', 'a');
    expect((await call('/api/v1/ingest/sources', 'POST', editor, { name: 'Sneaky', type: 'rss', url: 'https://x.example.com/', scheduleTimes: ['08:00'], timezone: 'UTC', licenceStatus: 'licensed', trustLevel: 'high' })).status).toBe(403);
    const s = await create(editor);
    expect((await call(`/api/v1/ingest/sources/${s.id}`, 'PATCH', editor, { trustLevel: 'high' })).status).toBe(403);
    expect((await call(`/api/v1/ingest/sources/${s.id}/licences`, 'POST', editor, { licenceStatus: 'licensed', usageMode: 'licensed_derivative', evidence: 'x' })).status).toBe(403);
    // An administrator still goes through a revision.
    expect((await call(`/api/v1/ingest/sources/${s.id}`, 'PATCH', admin, { usageMode: 'facts_only' })).status).toBe(400);
    // Derivative use needs a known licence and its evidence.
    expect((await call(`/api/v1/ingest/sources/${s.id}/licences`, 'POST', admin, { licenceStatus: 'unknown', usageMode: 'licensed_derivative' })).status).toBe(400);
    const res = await call(`/api/v1/ingest/sources/${s.id}/licences`, 'POST', admin, {
      licenceStatus: 'licensed',
      usageMode: 'licensed_derivative',
      commercialUse: true,
      trustLevel: 'high',
      evidence: 'Contract EX-2026-14',
      scope: 'Translation into Chinese, with credit',
      validUntil: '2027-10-01T00:00:00Z',
      reviewDueAt: '2027-04-01T00:00:00Z',
      attribution: 'Source: Example News',
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const after = ((await (await call(`/api/v1/ingest/sources/${s.id}`, 'GET', editor)).json()) as { data: IngestSourceResource }).data;
    expect(after).toMatchObject({ licenceStatus: 'licensed', usageMode: 'licensed_derivative', commercialUse: true, trustLevel: 'high', licenceEffective: true, effectiveUsageMode: 'licensed_derivative' });
    // Editing what the source is does not touch the terms.
    expect((await call(`/api/v1/ingest/sources/${s.id}`, 'PATCH', editor, { url: 'https://news.example.com/rss' })).status).toBe(200);
    const history = ((await (await call(`/api/v1/ingest/sources/${s.id}/licences`, 'GET', editor)).json()) as { data: IngestLicenceResource[] }).data;
    expect(history.map((h) => h.licenceStatus)).toEqual(['licensed', 'unknown']);
    expect(history[0]).toMatchObject({ evidence: 'Contract EX-2026-14', setBy: fx.users.adminA.id, validUntil: '2027-10-01T00:00:00.000Z' });
  });

  it('an expired licence no longer allows derivative use: the source shows discovery only and the contract refuses translation', async () => {
    const admin = await as('adminA', 'a');
    const s = await create(admin);
    await call(`/api/v1/ingest/sources/${s.id}/licences`, 'POST', admin, {
      licenceStatus: 'licensed',
      usageMode: 'licensed_derivative',
      evidence: 'Letter of 2025-01-01',
      validFrom: '2025-01-01T00:00:00Z',
      validUntil: '2026-01-01T00:00:00Z',
    });
    const read = ((await (await call(`/api/v1/ingest/sources/${s.id}`, 'GET', admin)).json()) as { data: IngestSourceResource }).data;
    expect(read).toMatchObject({ usageMode: 'licensed_derivative', licenceEffective: false, effectiveUsageMode: 'discovery_only' });
    const row = await sourceRow(fx.sites.a, s.id);
    expect(assertUsageAllowed(row, 'translate')).toMatchObject({ allowed: false, reason: 'licence_expired', reviewRequired: true });
    expect(assertUsageAllowed(row, 'use_as_lead').allowed).toBe(true);
  });

  it('two sites with different time zones: each source runs at its own local time, once per slot, one job per source', async () => {
    const a = await create(await as('adminA', 'a'), { name: 'Shanghai feed', scheduleTimes: ['08:00'], timezone: 'Asia/Shanghai' });
    const b = await create(await as('adminB', 'b'), { name: 'New York feed', scheduleTimes: ['08:00'], timezone: 'America/New_York' });
    // Both due from a known point: the schedule rows set to their next 08:00 after 2026-10-25T12:00Z.
    await db.update(ingestSchedule).set({ nextRunAt: new Date('2026-10-26T00:00:00Z') }).where(eq(ingestSchedule.sourceId, a.id));
    await db.update(ingestSchedule).set({ nextRunAt: new Date('2026-10-26T12:00:00Z') }).where(eq(ingestSchedule.sourceId, b.id));
    const queue = new FakeQueue();
    const tick = (iso: string) => scheduleDueSources({ db, queue, now: () => new Date(iso) });

    expect(await tick('2026-10-25T23:59:00Z')).toEqual([]);
    // 08:00 in Shanghai: A only; two schedulers at once enqueue it once.
    const [first, second] = await Promise.all([tick('2026-10-26T00:00:30Z'), tick('2026-10-26T00:00:30Z')]);
    expect([...first!, ...second!].map((j) => j.sourceId)).toEqual([a.id]);
    expect(queue.jobs[0]!.options?.singletonKey).toBe(`ingest-source:${a.id}`);
    expect(await tick('2026-10-26T00:01:30Z')).toEqual([]);
    // 08:00 in New York (EDT): B only.
    expect((await tick('2026-10-26T12:00:10Z')).map((j) => j.sourceId)).toEqual([b.id]);
    // Next slots: tomorrow 08:00 local each.
    const next = await db.select().from(ingestSchedule).where(inArray(ingestSchedule.sourceId, [a.id, b.id]));
    expect(Object.fromEntries(next.map((r) => [r.sourceId === a.id ? 'a' : 'b', r.nextRunAt.toISOString()]))).toEqual({
      a: '2026-10-27T00:00:00.000Z',
      b: '2026-10-27T12:00:00.000Z',
    });
    expect(queue.jobs.map((j) => [j.data.siteId, j.data.scheduledFor])).toEqual([
      [fx.sites.a, '2026-10-26T00:00:00.000Z'],
      [fx.sites.b, '2026-10-26T12:00:00.000Z'],
    ]);

    // A job delivered twice runs once.
    expect(await processSourceJob({ db }, queue.jobs[0]!.data)).toBe('succeeded');
    expect(await processSourceJob({ db }, queue.jobs[0]!.data)).toBe('duplicate');
    const runs = await runSiteTransaction(db, fx.sites.a, (tx) => tx.select().from(ingestSourceRuns).where(and(eq(ingestSourceRuns.siteId, fx.sites.a), eq(ingestSourceRuns.sourceId, a.id))));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'succeeded', itemsFound: 0 });
  });

  it('five failures in a row pause the source and notify the site\'s administrators with the category; a success resets the count; an administrator resumes it', async () => {
    const editor = await as('onlyA', 'a');
    const admin = await as('adminA', 'a');
    const s = await create(editor);
    let slot = Date.parse('2026-10-01T08:00:00Z');
    const job = () => {
      slot += 86_400_000;
      return processSourceJob({ db, threshold: 5 }, { siteId: fx.sites.a, sourceId: s.id, scheduledFor: new Date(slot).toISOString() });
    };
    const failing = () => setSourceRunner(async () => {
      throw new SourceRunError('network', 'connection reset');
    });

    failing();
    expect(await job()).toBe('failed');
    expect(await job()).toBe('failed');
    setSourceRunner(async () => ({ itemsFound: 3 }));
    expect(await job()).toBe('succeeded');
    expect((await sourceRow(fx.sites.a, s.id)).consecutiveFailures).toBe(0);

    failing();
    for (let i = 0; i < 4; i += 1) expect(await job()).toBe('failed');
    expect((await sourceRow(fx.sites.a, s.id)).status).toBe('active');
    expect(await job()).toBe('paused');
    const paused = await sourceRow(fx.sites.a, s.id);
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'failures', consecutiveFailures: 5, lastFailureCategory: 'network' });
    expect(await db.select().from(ingestSchedule).where(eq(ingestSchedule.sourceId, s.id))).toEqual([]);
    // A paused source's jobs do nothing.
    expect(await job()).toBe('skipped');

    const notes = await db.select().from(notifications).where(and(eq(notifications.siteId, fx.sites.a), eq(notifications.item, s.id)));
    expect(notes.map((n) => n.recipient)).toEqual([fx.users.adminA.id]);
    expect(notes[0]!.message).toContain('network');

    // Resuming is an administrator's decision.
    expect((await call(`/api/v1/ingest/sources/${s.id}/resume`, 'POST', editor)).status).toBe(403);
    const resumed = await call(`/api/v1/ingest/sources/${s.id}/resume`, 'POST', admin);
    expect(((await resumed.json()) as { data: IngestSourceResource }).data).toMatchObject({ status: 'active', consecutiveFailures: 0, pausedReason: null });
    expect(await db.select().from(ingestSchedule).where(eq(ingestSchedule.sourceId, s.id))).toHaveLength(1);
    // An editor may pause by hand.
    const res = await call(`/api/v1/ingest/sources/${s.id}/pause`, 'POST', editor);
    expect(((await res.json()) as { data: IngestSourceResource }).data).toMatchObject({ status: 'paused', pausedReason: 'manual' });
  });
});
