import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, autoPublishCandidates, items, siteContentSettings, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import type { StorageObject, StorageProvider } from '@heopress/runtime';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { AutoPublisher, type GateCheck } from '../services/auto-publish/auto-publish';
import { LocaleSetService } from '../services/auto-publish/locale-set-service';
import { AutonomyService } from '../services/autonomy-service';
import { recordDerivation } from '../services/ingest/licence-lapse';
import { operationIdFor, registerSourceDocument } from '../services/ingest/source-documents';
import { IngestSourceService } from '../services/ingest/source-service';
import { ItemService } from '../services/item-service';
import { KillSwitchService } from '../services/kill-switch-service';
import { nextDayStart } from '../services/llm/daily';
import type { ChatCallInput, ChatCallResult } from '../services/llm/gateway';
import { ContentPipeline } from '../services/pipeline/content-pipeline';
import { runDueAutoPublish } from '../services/auto-publish/auto-publish';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { ensureContentSettings, upgradeSitePreset } from '../services/site-network/preset-installer';
import { TranslationGroupService } from '../services/site-network/translation-group-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Auto-publish (HeoPress P09 tasks 3.1–3.7; spec ai/auto-publish) against the real database: the three preconditions,
 * the tiers (review / veto window / immediate), the cadence, Hold and kill switch, the final re-check, source
 * freshness and the required language set. Model answers are mocked; no key, no network.
 */

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

const JWT_SECRET = 'auto-publish-secret';
const zh = (text: string) => (text.startsWith('<') ? text.replace(/>/, '>ZH:') : `ZH:${text}`);
const PARA = 'The harbour authority in Example Town reported a busy season for ferries and fishing boats, with record passenger numbers.';
const DESC = 'Ferry and fishing figures from the Example Town harbour this season, with the record passenger numbers explained.';
const DAY = 86_400_000;
const MIN = 60_000;

describe.skipIf(!hasDbIntegrationUrl)('auto-publish — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let siteId = '';
  let storage: MemoryStorage;
  let env: Record<string, unknown> = {};
  const gateway = {
    chat: async (req: ChatCallInput): Promise<ChatCallResult> => {
      if (req.capability !== 'translate') throw new Error(`no mock answer for ${req.capability}`);
      const payload = JSON.parse(String(req.messages[0]!.content)) as { segments: Array<{ id: string; text: string }> };
      const content = JSON.stringify({ segments: payload.segments.map((s) => ({ id: s.id, text: zh(s.text) })) });
      return { response: { content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }, provider: 'mock', model: 'mock-1', callId: `call_${Math.random()}`, attemptIds: [] };
    },
  };
  const urlChecker = async () => ({ ok: true, status: 200 });
  const pipeline = () => new ContentPipeline({ db, siteId, gateway, urlChecker });
  const publisher = (opts: { at?: Date; gate?: GateCheck; site?: string } = {}) => new AutoPublisher({ db, siteId: opts.site ?? siteId, now: opts.at ? () => opts.at! : undefined, gate: opts.gate });
  /** A gate that passes every item except the blocked ones (for tests about cadence and language sets). */
  const stubGate = (blocked: Set<string> = new Set()): GateCheck => async (_tx, _site, itemId) =>
    blocked.has(itemId) ? { state: 'blocked', publishable: false, staleReasons: [], result: { id: `stub-${itemId}` } } : { state: 'passed', publishable: true, staleReasons: [], result: { id: `stub-${itemId}` } };

  beforeAll(async () => {
    db = await connectDbIntegration('auto-publish');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  afterAll(() => setRuntimeFactory(null));
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'apub', jwtSecret: JWT_SECRET });
    siteId = fx.sites.a;
    storage = new MemoryStorage();
    for (const s of [fx.sites.a, fx.sites.b]) {
      await upgradeSitePreset(db, s);
      await db.transaction((tx) => ensureContentSettings(tx as never, s));
      const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, s));
      await new ContentSettingsService({ db, siteId: s, actor: { userId: null } }).update({
        availableLocales: ['en', 'zh-CN', 'pt-BR', 'vi'],
        timezone: r!.timezone,
        siteType: 'blog',
        trailingSlash: r!.trailingSlash as 'always',
        localeStrategy: r!.localeStrategy as 'subdirectory',
        localePrefixMode: r!.localePrefixMode as 'default_at_root',
        localePrefixes: r!.localePrefixes,
        permalinks: r!.permalinks,
        allowCrossSiteTranslations: true,
        sponsorDisclosure: true,
        sponsorRel: true,
        version: r!.version,
      } as never);
    }
  });
  afterEach(async () => {
    if (fx) await fx.teardown();
  });

  const admin = { isAdmin: true, userId: null };
  const cleared = { licenceStatus: 'licensed', usageMode: 'licensed_derivative', commercialUse: true, trustLevel: 'high', reviewDueAt: new Date(Date.now() + 300 * DAY).toISOString() };
  const sources = () => new IngestSourceService({ db, siteId, actor: admin });
  async function addSource(name: string, terms: Record<string, unknown> = cleared): Promise<string> {
    const s = await sources().create({ name, type: 'url', url: `https://${name.toLowerCase()}.example.com/`, scheduleTimes: ['08:00'], timezone: 'UTC' });
    await sources().reviseLicence(s.id, { evidence: 'Signed agreement EX-1', ...terms });
    return s.id;
  }
  async function register(sourceId: string, path: string, body: string, publishedAt: Date | null = new Date(Date.now() - 2 * DAY)): Promise<string> {
    const url = `https://wire.example.com${path}`;
    const res = await registerSourceDocument(
      { db, storage },
      {
        siteId,
        sourceId,
        run: null,
        operationId: operationIdFor(sourceId, 'manual', url),
        url,
        page: { url, finalUrl: url, status: 200, contentType: 'text/html', headers: new Headers(), body: Buffer.from(`<html><body>${body}</body></html>`), durationMs: 3 },
        extracted: {
          title: 'Harbour season report',
          author: null,
          publishedAt,
          language: 'en',
          canonicalCandidate: null,
          bodyHtml: body,
          bodyText: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          contentHash: createHash('sha256').update(body).digest('hex'),
          hiddenContent: [],
          linkDensity: 0,
          ruleVersion: 'test@1',
        },
        startedAt: new Date(),
      },
    );
    return res.documentId;
  }
  const itemOf = async (id: string) => (await db.select().from(items).where(eq(items.id, id)))[0]!;
  const edit = async (id: string, data: Record<string, unknown>) => new ItemService({ db, siteId }).patch('articles', id, { data, expectedVersion: (await itemOf(id)).version });
  const grant = (level: 0 | 1 | 2 | 3 | 4, site = siteId) => new AutonomyService({ db, siteId: site }).setGrant('content-pipeline', 'publish', level);
  const candidateOf = async (itemId: string) =>
    (await db.select().from(autoPublishCandidates).where(eq(autoPublishCandidates.itemId, itemId)).orderBy(autoPublishCandidates.createdAt)).at(-1)!;

  /** A licensed, trusted English source translated into Chinese, gated: the happy path. */
  async function gated(opts: { terms?: Record<string, unknown>; publishedAt?: Date | null; path?: string } = {}) {
    const src = await addSource(`Wire${Math.random().toString(36).slice(2, 7)}`, opts.terms ?? cleared);
    const doc = await register(src, opts.path ?? '/harbour', `<p>${PARA}</p><p>Install with <code>apt install nginx</code> (edition ${opts.path ?? 'main'}).</p>`, opts.publishedAt === undefined ? new Date(Date.now() - 2 * DAY) : opts.publishedAt);
    const res = await pipeline().produce({ mode: 'translate', sourceDocumentIds: [doc], targetLocale: 'zh-CN' });
    expect(res.status, res.reason ?? '').toBe('drafted');
    await edit(res.itemId!, { slug: `harbour-${Math.random().toString(36).slice(2, 8)}`, seo_title: 'Harbour season report 2026', seo_description: DESC });
    const out = await pipeline().runGate(res.productionId);
    return { src, doc, productionId: res.productionId, itemId: res.itemId!, gate: out.status };
  }

  /** An article of site A derived from a cleared source (for the stubbed-gate tests). */
  async function derivedItem(slug: string, locale = 'zh-CN'): Promise<string> {
    const it = (await new ItemService({ db, siteId }).create('articles', { data: { title: slug, slug, locale }, status: 'draft' })) as { id: string };
    await recordDerivation(db, { siteId, itemId: it.id, sourceDocumentId: sharedDoc, operation: 'translate' });
    return it.id;
  }
  let sharedDoc = '';
  async function withSharedSource() {
    const src = await addSource('Shared');
    sharedDoc = await register(src, '/shared', `<p>${PARA}</p>`);
    return src;
  }

  // ── 3.1 ─────────────────────────────────────────────────────────────

  it('3.1: a trusted licensed source, a passed gate and L4 publish at once; L2 and no grant go to review', async () => {
    const a = await gated();
    expect(a.gate, JSON.stringify((await pipeline().runGate(a.productionId)).checks.filter((c) => c.status !== "passed"))).toBe('passed');
    expect(await pipeline().proposePublish(a.productionId)).toMatchObject({ decision: 'review_queue', reason: 'tier_l1' });
    await grant(2);
    expect(await pipeline().proposePublish(a.productionId)).toMatchObject({ decision: 'review_queue', reason: 'tier_l2' });
    expect((await itemOf(a.itemId)).status).toBe('draft');
    await grant(4);
    expect(await pipeline().proposePublish(a.productionId)).toMatchObject({ decision: 'published' });
    expect((await itemOf(a.itemId)).status).toBe('published');
    const rows = await db.select().from(autoPublishCandidates).where(eq(autoPublishCandidates.itemId, a.itemId));
    expect(rows.map((r) => r.status).sort()).toEqual(['published', 'superseded', 'superseded']);
    expect((await db.select().from(auditLog).where(and(eq(auditLog.siteId, siteId), eq(auditLog.event, 'auto_publish_published')))).length).toBe(1);
  });

  it('3.1: an `unknown` licence never auto-publishes, even after a person approves the gate; an untrusted source neither', async () => {
    await grant(4);
    const a = await gated({ terms: { ...cleared, licenceStatus: 'unknown', usageMode: 'licensed_derivative' } }).catch(() => null);
    // `unknown` with a derivative mode cannot even be translated: there is no draft, so nothing to publish.
    expect(a).toBeNull();
    // A source whose licence becomes unknown after translation: the gate needs a person, the person approves — still review.
    const b = await gated();
    await sources().reviseLicence(b.src, { evidence: 'Agreement withdrawn', licenceStatus: 'unknown', usageMode: 'facts_only', commercialUse: false, trustLevel: 'high', reviewDueAt: null });
    const run = await pipeline().runGate(b.productionId);
    expect(run.status).not.toBe('passed');
    if (run.status === 'needs_review') {
      const { QualityGate } = await import('../services/quality-gate/quality-gate');
      await new QualityGate({ db, siteId }).review({ resultId: run.resultId!, decision: 'approve', reason: 'checked', reviewerId: fx.users.adminA.id, itemVersion: (await itemOf(b.itemId)).version });
    }
    const p = await pipeline().proposePublish(b.productionId);
    expect(p.decision).toBe('review_queue');
    const c = await candidateOf(b.itemId);
    expect((c.detail as { failures: Array<{ reason: string }> }).failures.map((f) => f.reason)).toContain('licence_unknown');
    expect((await itemOf(b.itemId)).status).toBe('draft');

    const low = await gated({ terms: { ...cleared, trustLevel: 'low' }, path: '/low' });
    expect((await pipeline().proposePublish(low.productionId)).decision).toBe('review_queue');
    expect(((await candidateOf(low.itemId)).detail as { failures: Array<{ reason: string }> }).failures.map((f) => f.reason)).toContain('source_not_trusted');
  });

  // ── 3.2 ─────────────────────────────────────────────────────────────

  it('3.2: L3 opens a 30-minute veto window; a veto inside it publishes nothing and records who; silence publishes after it', async () => {
    await grant(3);
    const a = await gated();
    expect(await pipeline().proposePublish(a.productionId)).toMatchObject({ decision: 'veto_window' });
    const c = await candidateOf(a.itemId);
    expect(c.status).toBe('veto_window');
    expect(c.notBefore!.getTime() - c.createdAt.getTime()).toBeGreaterThan(29 * MIN);
    expect(c.notBefore!.getTime() - c.createdAt.getTime()).toBeLessThan(31 * MIN);
    // Still inside: nothing happens.
    expect((await publisher().processDue()).published).toBe(0);
    const vetoed = await publisher().veto(c.id, fx.users.adminA.id, 'Wrong angle');
    expect(vetoed).toMatchObject({ status: 'review', reason: 'vetoed', decidedBy: fx.users.adminA.id });
    expect((await publisher({ at: new Date(Date.now() + 31 * MIN) }).processDue()).published).toBe(0);
    expect((await itemOf(a.itemId)).status).toBe('draft');
    await expect(publisher().veto(c.id, fx.users.adminA.id)).rejects.toMatchObject({ code: 'NOT_VETOABLE' });

    // Another article, no veto (the veto demoted the tier: grant L3 again).
    await grant(3);
    const b = await gated({ path: '/other' });
    await pipeline().proposePublish(b.productionId);
    expect((await publisher({ at: new Date(Date.now() + 31 * MIN) }).processDue()).published).toBe(1);
    expect((await itemOf(b.itemId)).status).toBe('published');
  });

  // ── 3.3 ─────────────────────────────────────────────────────────────

  it('3.3: 30 produced with a daily limit of 10 → 10 today, the next 10 tomorrow, in order', async () => {
    await withSharedSource();
    await grant(4);
    await publisher().updateSettings({ dailyLimit: 10 }, null);
    const t0 = new Date();
    const gate = stubGate();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await derivedItem(`bulk-${i}`));
    const decisions = [];
    for (const id of ids) decisions.push((await publisher({ at: t0, gate }).propose({ collection: 'articles', itemId: id })).decision);
    expect(decisions.filter((d) => d === 'published')).toHaveLength(10);
    expect(decisions.filter((d) => d === 'scheduled')).toHaveLength(20);
    const published = async () => (await Promise.all(ids.map(itemOf))).filter((r) => r.status === 'published').map((r) => r.id);
    expect(await published()).toEqual(ids.slice(0, 10));
    const queued = await candidateOf(ids[10]!);
    expect(queued).toMatchObject({ status: 'queued', reason: 'cadence_daily_limit' });
    expect(queued.notBefore!.getTime()).toBe(nextDayStart(t0, 'UTC').getTime());
    // Later today: still nothing.
    expect((await publisher({ at: new Date(t0.getTime() + MIN), gate }).processDue()).published).toBe(0);
    const tomorrow = new Date(nextDayStart(t0, 'UTC').getTime() + MIN);
    expect((await publisher({ at: tomorrow, gate }).processDue()).published).toBe(10);
    expect(await published()).toEqual(ids.slice(0, 20));
  });

  it('3.3, 3.5: the minimum interval spaces publishes; two concurrent publishers never exceed the daily limit', async () => {
    await withSharedSource();
    await grant(3);
    await publisher().updateSettings({ dailyLimit: 1, minIntervalMinutes: 0 }, null);
    const gate = stubGate();
    const [x, y] = [await derivedItem('race-x'), await derivedItem('race-y')];
    for (const id of [x, y]) expect((await publisher({ gate }).propose({ collection: 'articles', itemId: id })).decision).toBe('veto_window');
    const later = new Date(Date.now() + 31 * MIN);
    const [cx, cy] = [await candidateOf(x), await candidateOf(y)];
    const outcomes = await Promise.all([publisher({ at: later, gate }).tryPublish(cx.id), publisher({ at: later, gate }).tryPublish(cy.id)]);
    expect(outcomes.sort()).toEqual(['deferred', 'published']);

    await publisher().updateSettings({ dailyLimit: null, minIntervalMinutes: 60 }, null);
    const [p, q] = [await derivedItem('gap-p'), await derivedItem('gap-q')];
    await grant(4);
    const t = new Date(later.getTime() + 2 * 3_600_000);
    expect((await publisher({ at: t, gate }).propose({ collection: 'articles', itemId: p })).decision).toBe('published');
    expect((await publisher({ at: t, gate }).propose({ collection: 'articles', itemId: q })).decision).toBe('scheduled');
    expect((await candidateOf(q))).toMatchObject({ reason: 'cadence_min_interval' });
    expect((await candidateOf(q)).notBefore!.getTime()).toBe(t.getTime() + 60 * MIN);
    expect((await publisher({ at: new Date(t.getTime() + 61 * MIN), gate }).processDue()).published).toBe(1);
  });

  // ── 3.4 ─────────────────────────────────────────────────────────────

  it('3.4: the site kill switch stops every auto-publish — new proposals and queued ones go to review; a Hold too', async () => {
    await withSharedSource();
    await grant(3);
    const gate = stubGate();
    const queued = await derivedItem('ks-queued');
    await publisher({ gate }).propose({ collection: 'articles', itemId: queued });
    await new KillSwitchService({ db, siteId }).freeze('site', { reason: 'incident' });
    await grant(4);
    const fresh = await derivedItem('ks-fresh');
    expect(await publisher({ gate }).propose({ collection: 'articles', itemId: fresh })).toMatchObject({ decision: 'review_queue', reason: 'kill_switch' });
    expect(await runDueAutoPublish(db, new Date(Date.now() + 31 * MIN))).toBe(0);
    expect(await candidateOf(queued)).toMatchObject({ status: 'review', reason: 'kill_switch' });
    for (const id of [queued, fresh]) expect((await itemOf(id)).status).toBe('draft');

    await new KillSwitchService({ db, siteId }).lift('site');
    const held = await derivedItem('held');
    await db.update(items).set({ hold: true }).where(eq(items.id, held));
    expect(await publisher({ gate }).propose({ collection: 'articles', itemId: held })).toMatchObject({ decision: 'review_queue', reason: 'hold' });
  });

  // ── 3.5 ─────────────────────────────────────────────────────────────

  it('3.5: the final publish checks again — a person\'s edit, a revoked licence, a lower tier, a policy change each stop it', async () => {
    await grant(3);
    const later = () => publisher({ at: new Date(Date.now() + 31 * MIN) });

    const edited = await gated({ path: '/edited' });
    await pipeline().proposePublish(edited.productionId);
    await edit(edited.itemId, { seo_title: 'Harbour season report, by an editor' });
    await later().processDue();
    expect(await candidateOf(edited.itemId)).toMatchObject({ status: 'review', reason: 'content_changed' });

    const revoked = await gated({ path: '/revoked' });
    await pipeline().proposePublish(revoked.productionId);
    await sources().reviseLicence(revoked.src, { evidence: 'Terminated', ...cleared, licenceStatus: 'unknown', usageMode: 'discovery_only' });
    await later().processDue();
    const rc = await candidateOf(revoked.itemId);
    expect(rc.status).toBe('review');
    expect((rc.detail as { failures: Array<{ reason: string }> }).failures.map((f) => f.reason)).toEqual(expect.arrayContaining(['licence_unknown', 'licence_changed']));

    const demoted = await gated({ path: '/demoted' });
    await pipeline().proposePublish(demoted.productionId);
    await grant(2);
    await later().processDue();
    expect(await candidateOf(demoted.itemId)).toMatchObject({ status: 'review', reason: 'tier_l2' });

    await grant(3);
    const policy = await gated({ path: '/policy' });
    await pipeline().proposePublish(policy.productionId);
    await publisher().updateSettings({ minIntervalMinutes: 5 }, null);
    await later().processDue();
    expect(await candidateOf(policy.itemId)).toMatchObject({ status: 'review', reason: 'policy_changed' });

    for (const x of [edited, revoked, demoted, policy]) expect((await itemOf(x.itemId)).status).toBe('draft');
  });

  // ── 3.6 ─────────────────────────────────────────────────────────────

  it('3.6: a source older than 60 days sends the draft to review; an exempt collection publishes', async () => {
    await grant(4);
    const old = await gated({ publishedAt: new Date(Date.now() - 90 * DAY), path: '/old' });
    expect(old.gate, JSON.stringify((await pipeline().runGate(old.productionId)).checks.filter((c) => c.status !== 'passed'))).toBe('passed');
    expect(await pipeline().proposePublish(old.productionId)).toMatchObject({ decision: 'review_queue', reason: 'source_stale' });
    await publisher().updateSettings({ freshnessExemptCollections: ['articles'] }, null);
    expect(await pipeline().proposePublish(old.productionId)).toMatchObject({ decision: 'published' });
  });

  // ── 3.7 ─────────────────────────────────────────────────────────────

  describe('3.7 required language set', () => {
    const groups = (site = siteId) => new TranslationGroupService({ db, siteId: site, actor: undefined, userId: null, itemsOn: (s, tx) => new ItemService({ db: tx as never, rootDb: db, siteId: s }) });
    const setService = (gate: GateCheck, userId: string | null = fx.users.adminA.id) =>
      new LocaleSetService({ db, siteId, userId, gate, itemsOn: (tx) => new ItemService({ db: tx as never, siteId, userId, localeSetWrite: true }) });

    async function trio() {
      await withSharedSource();
      const en = (await new ItemService({ db, siteId }).create('articles', { data: { title: 'Harbour', slug: 'harbour', locale: 'en' }, status: 'published' })) as { id: string };
      const g = await groups().create(en.id);
      const ids: Record<string, string> = {};
      for (const l of ['zh-CN', 'pt-BR', 'vi']) {
        ids[l] = (await groups().createDraft(g.id, { locale: l })).itemId;
        await recordDerivation(db, { siteId, itemId: ids[l]!, sourceDocumentId: sharedDoc, operation: 'translate' });
      }
      await publisher().updateSettings({ requiredLocales: ['zh-CN', 'pt-BR', 'vi'] }, null);
      return { en: en.id, groupId: g.id, ids };
    }

    it('one language blocked → none published, waiting for it; once it passes all three publish in one transaction', async () => {
      const { ids } = await trio();
      await grant(4);
      const blocked = new Set([ids.vi!]);
      const gate = stubGate(blocked);
      for (const l of ['zh-CN', 'pt-BR']) expect((await publisher({ gate }).propose({ collection: 'articles', itemId: ids[l]! })).decision).toBe('scheduled');
      expect(await publisher({ gate }).propose({ collection: 'articles', itemId: ids.vi! })).toMatchObject({ decision: 'review_queue', reason: 'gate_not_passed' });
      expect(await candidateOf(ids['pt-BR']!)).toMatchObject({ status: 'queued', reason: 'waiting_for_locales', detail: expect.objectContaining({ waitingFor: ['vi'] }) });
      for (const id of Object.values(ids)) expect((await itemOf(id)).status).toBe('draft');
      // A single write of a bound member is refused.
      await expect(new ItemService({ db, siteId }).patch('articles', ids['zh-CN']!, { status: 'published', expectedVersion: (await itemOf(ids['zh-CN']!)).version })).rejects.toMatchObject({ code: 'REQUIRED_LOCALE_SET' });

      blocked.clear();
      expect((await publisher({ gate }).propose({ collection: 'articles', itemId: ids.vi! })).decision).toBe('published');
      const rows = await Promise.all(Object.values(ids).map(itemOf));
      expect(rows.map((r) => r.status)).toEqual(['published', 'published', 'published']);
      // One transaction: one publish moment for the set.
      const cands = await Promise.all(Object.values(ids).map(candidateOf));
      expect(cands.map((c) => c.status)).toEqual(['published', 'published', 'published']);
      expect(new Set(cands.map((c) => c.publishedAt?.getTime())).size).toBe(1);
    });

    it('unpublishing one language unpublishes the set; a person\'s single-language exception works, without permission it fails; other sites are not bound', async () => {
      const { ids, groupId } = await trio();
      const gate = stubGate();
      // The group publish, then the group unpublish.
      expect((await setService(gate).publishSet(ids['zh-CN']!)).published).toHaveLength(3);
      expect((await setService(gate).unpublishSet(ids['pt-BR']!)).unpublished).toHaveLength(3);
      for (const id of Object.values(ids)) expect((await itemOf(id)).status).toBe('draft');

      // A blocked language stops the group publish entirely.
      await expect(setService(stubGate(new Set([ids.vi!]))).publishSet(ids['zh-CN']!)).rejects.toMatchObject({ code: 'SET_NOT_PUBLISHABLE' });
      expect((await itemOf(ids['zh-CN']!)).status).toBe('draft');

      // The exception: Chinese alone, with a reason, audited; it still respects the gate and the kill switch.
      await expect(setService(gate).single(ids['zh-CN']!, 'publish', '  ')).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(setService(stubGate(new Set([ids['zh-CN']!]))).single(ids['zh-CN']!, 'publish', 'Launch early')).rejects.toMatchObject({ code: 'SET_NOT_PUBLISHABLE' });
      await new KillSwitchService({ db, siteId }).freeze('site', { reason: 'incident' });
      await expect(setService(gate).single(ids['zh-CN']!, 'publish', 'Launch early')).rejects.toMatchObject({ code: 'SET_NOT_PUBLISHABLE' });
      await new KillSwitchService({ db, siteId }).lift('site');
      await setService(gate).single(ids['zh-CN']!, 'publish', 'Launch the Chinese edition early');
      expect((await itemOf(ids['zh-CN']!)).status).toBe('published');
      expect((await itemOf(ids.vi!)).status).toBe('draft');
      const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.siteId, siteId), eq(auditLog.event, 'locale_set_single_publish')));
      expect(entry!.metadata).toMatchObject({ exception: true, reason: 'Launch the Chinese edition early', itemId: ids['zh-CN'] });

      // Without publish permission (a reader of site B, through the API): refused.
      const call = async (site: 'a' | 'b', who: 'both' | 'adminA', path: string, body: unknown) =>
        app.request(`/api/v1/auto-publish${path}`, { method: 'POST', headers: fx.headers(site, await fx.session(who, site)), body: JSON.stringify(body) }, env);

      // Site B: a member of the same group there is not bound by A's set.
      const bDraft = (await groups(fx.sites.b).createDraft(groupId, { locale: 'vi' })).itemId;
      await new ItemService({ db, siteId: fx.sites.b }).patch('articles', bDraft, { status: 'published', expectedVersion: (await itemOf(bDraft)).version }).catch((e: { code?: string }) => {
        // The group allows one published member per language: A's vi is still a draft, so this publish must not fail on the set.
        expect(e.code).not.toBe('REQUIRED_LOCALE_SET');
      });
      expect((await itemOf(bDraft)).status).toBe('published');
      const res = await call('b', 'both', `/locale-sets/${bDraft}/single`, { action: 'unpublish', reason: 'no' });
      expect(res.status).toBe(403);
      expect((await itemOf(bDraft)).status).toBe('published');
      // A's administrator through the API: the exception unpublish works.
      const ok = await call('a', 'adminA', `/locale-sets/${ids['zh-CN']}/single`, { action: 'unpublish', reason: 'Pulled for a fix' });
      expect(ok.status).toBe(200);
      expect((await itemOf(ids['zh-CN']!)).status).toBe('draft');
    });
  });

  it('API: review queue, veto and settings', async () => {
    await grant(3);
    const a = await gated();
    await pipeline().proposePublish(a.productionId);
    const h = fx.headers('a', await fx.session('adminA', 'a'));
    const list = await app.request('/api/v1/auto-publish/candidates?status=veto_window', { headers: h }, env);
    expect(list.status).toBe(200);
    const [c] = ((await list.json()) as { data: Array<{ id: string }> }).data;
    const veto = await app.request(`/api/v1/auto-publish/candidates/${c!.id}/veto`, { method: 'POST', headers: h, body: JSON.stringify({ reason: 'not now' }) }, env);
    expect(veto.status).toBe(200);
    expect(((await veto.json()) as { data: { status: string; reason: string } }).data).toMatchObject({ status: 'review', reason: 'vetoed' });
    const settings = await app.request('/api/v1/auto-publish/settings', { method: 'PUT', headers: h, body: JSON.stringify({ dailyLimit: 5, vetoWindowMinutes: 45 }) }, env);
    expect(((await settings.json()) as { data: Record<string, unknown> }).data).toMatchObject({ dailyLimit: 5, vetoWindowMinutes: 45, version: 1 });
    const reader = fx.headers('b', await fx.session('both', 'b'));
    expect((await app.request('/api/v1/auto-publish/settings', { method: 'PUT', headers: reader, body: JSON.stringify({ dailyLimit: 1 }) }, env)).status).toBe(403);
  });
});
