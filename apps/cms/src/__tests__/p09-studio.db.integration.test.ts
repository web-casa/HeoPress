import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { aiProductions, autoPublishCandidates, flowDrafts, flows, items, llmAttempts, qualityGateResults, siteContentSettings, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import type { StorageObject, StorageProvider } from '@heopress/runtime';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { AutoPublisher } from '../services/auto-publish/auto-publish';
import { AutonomyService } from '../services/autonomy-service';
import { FlowDraftService, type ApprovalMode } from '../services/flow-drafts/flow-draft-service';
import { operationIdFor, registerSourceDocument } from '../services/ingest/source-documents';
import { IngestSourceService } from '../services/ingest/source-service';
import { ItemService } from '../services/item-service';
import type { ChatCallInput, ChatCallResult } from '../services/llm/gateway';
import { ContentPipeline } from '../services/pipeline/content-pipeline';
import { PromptWorkbench, locateParagraphs, type TrialEvent } from '../services/pipeline/prompt-workbench';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { ensureContentSettings, upgradeSitePreset } from '../services/site-network/preset-installer';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * HeoPress P09 Studio slice against the real database: the review queue's batch decisions (task 2.3), the prompt
 * workbench writes no content (task 4.1) and agent-drafted flows follow ADR-0012 (task 5.1). Model answers are mocked.
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

const JWT_SECRET = 'p09-studio-secret';
const DAY = 86_400_000;
const PARA = 'The harbour authority in Example Town reported a busy season for ferries and fishing boats, with record passenger numbers.';
const PARA2 = 'Fishing crews said the cold spring delayed the first catches, but prices recovered by early summer across the coast.';
const DESC = 'Ferry and fishing figures from the Example Town harbour this season, with the record passenger numbers explained.';

describe.skipIf(!hasDbIntegrationUrl)('P09 studio slice — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let siteId = '';
  let env: Record<string, unknown> = {};
  const answers: string[] = [];
  const gateway = {
    chat: async (req: ChatCallInput): Promise<ChatCallResult> => {
      let content: string;
      if (req.capability === 'translate') {
        const payload = JSON.parse(String(req.messages[0]!.content)) as { segments: Array<{ id: string; text: string }> };
        content = JSON.stringify({ segments: payload.segments.map((s) => ({ id: s.id, text: `ZH:${s.text}` })) });
      } else {
        content = answers.shift() ?? '{}';
      }
      return { response: { content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }, provider: 'mock', model: 'mock-1', callId: `call_${Math.random()}`, attemptIds: [] };
    },
  };
  const pipeline = () => new ContentPipeline({ db, siteId, gateway, urlChecker: async () => ({ ok: true, status: 200 }) });

  beforeAll(async () => {
    db = await connectDbIntegration('p09-studio');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  afterAll(() => setRuntimeFactory(null));
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'p09st', jwtSecret: JWT_SECRET });
    siteId = fx.sites.a;
    await upgradeSitePreset(db, siteId);
    await db.transaction((tx) => ensureContentSettings(tx as never, siteId));
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    await new ContentSettingsService({ db, siteId, actor: { userId: null } }).update({
      availableLocales: ['en', 'zh-CN'],
      timezone: r!.timezone,
      siteType: 'blog',
      trailingSlash: r!.trailingSlash as 'always',
      localeStrategy: r!.localeStrategy as 'subdirectory',
      localePrefixMode: r!.localePrefixMode as 'default_at_root',
      localePrefixes: r!.localePrefixes,
      permalinks: r!.permalinks,
      allowCrossSiteTranslations: false,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: r!.version,
    } as never);
  });
  afterEach(async () => {
    if (fx) await fx.teardown();
  });

  const cleared = { licenceStatus: 'licensed', usageMode: 'licensed_derivative', commercialUse: true, trustLevel: 'high', reviewDueAt: new Date(Date.now() + 300 * DAY).toISOString() };
  const sources = () => new IngestSourceService({ db, siteId, actor: { isAdmin: true, userId: null } });
  async function sourceDoc(path: string, body: string): Promise<{ src: string; doc: string }> {
    const s = await sources().create({ name: `Wire${Math.random().toString(36).slice(2, 7)}`, type: 'url', url: `https://wire${Math.random().toString(36).slice(2, 7)}.example.com/`, scheduleTimes: ['08:00'], timezone: 'UTC' });
    await sources().reviseLicence(s.id, { evidence: 'Signed agreement EX-1', ...cleared });
    const url = `https://wire.example.com${path}`;
    const res = await registerSourceDocument(
      { db, storage: new MemoryStorage() },
      {
        siteId,
        sourceId: s.id,
        run: null,
        operationId: operationIdFor(s.id, 'manual', url),
        url,
        page: { url, finalUrl: url, status: 200, contentType: 'text/html', headers: new Headers(), body: Buffer.from(`<html><body>${body}</body></html>`), durationMs: 3 },
        extracted: {
          title: 'Harbour season report',
          author: null,
          publishedAt: new Date(Date.now() - 2 * DAY),
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
    return { src: s.id, doc: res.documentId };
  }
  const countOf = async (table: typeof items | typeof aiProductions | typeof qualityGateResults) =>
    Number((await db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.siteId, siteId)))[0]!.n);

  // ── 2.3 review queue ────────────────────────────────────────────────

  it('2.3: the review queue shows score, evidence and suggestions; a batch decides each entry and reports each result', async () => {
    const made: Array<{ src: string; itemId: string; productionId: string }> = [];
    for (const path of ['/one', '/two']) {
      const { src, doc } = await sourceDoc(path, `<p>${PARA} (${path})</p>`);
      const res = await pipeline().produce({ mode: 'translate', sourceDocumentIds: [doc], targetLocale: 'zh-CN' });
      expect(res.status, res.reason ?? '').toBe('drafted');
      const it = (await db.select().from(items).where(eq(items.id, res.itemId!)))[0]!;
      await new ItemService({ db, siteId }).patch('articles', it.id, { data: { slug: `harbour${path.slice(1)}`, seo_title: 'Harbour season report 2026', seo_description: DESC }, expectedVersion: it.version });
      made.push({ src, itemId: res.itemId!, productionId: res.productionId });
    }
    // The first source's terms change after translation: the gate now needs a person (source rights).
    await sources().reviseLicence(made[0]!.src, { evidence: 'Leads only now', ...cleared, usageMode: 'discovery_only' });
    for (const m of made) await pipeline().runGate(m.productionId);
    await new AutonomyService({ db, siteId }).setGrant('content-pipeline', 'publish', 2);
    for (const m of made) expect((await pipeline().proposePublish(m.productionId)).decision).toBe('review_queue');

    const h = fx.headers('a', await fx.session('adminA', 'a'));
    const queue = (await (await app.request('/api/v1/auto-publish/review-queue', { headers: h }, env)).json()) as {
      data: Array<{ id: string; itemId: string; title: string; gate: { state: string; result: { score: number; checks: Array<{ rule: string; status: string; evidence: unknown; suggestions: string[] }> } } }>;
    };
    const first = queue.data.find((e) => e.itemId === made[0]!.itemId)!;
    const second = queue.data.find((e) => e.itemId === made[1]!.itemId)!;
    expect(first.title).toContain('ZH:');
    expect(first.gate.state).toBe('needs_review');
    const rights = first.gate.result.checks.find((c) => c.rule === 'source_rights')!;
    expect(rights.status).toBe('needs_review');
    expect(rights.suggestions.length).toBeGreaterThan(0);
    expect(first.gate.result.score).toBeLessThan(100);
    expect(second.gate.state).toBe('passed');

    // Approve both: the first is approved for its version (still in review: its terms no longer allow it), the second
    // has nothing to approve — reported, not fatal.
    const batch = await app.request('/api/v1/auto-publish/review/batch', { method: 'POST', headers: h, body: JSON.stringify({ action: 'approve', candidateIds: [first.id, second.id, 'missing'], reason: 'Checked by hand' }) }, env);
    expect(batch.status).toBe(200);
    const results = ((await batch.json()) as { data: Array<{ id: string; ok: boolean; status?: string; error?: { code: string } }> }).data;
    expect(results.find((r) => r.id === first.id)).toMatchObject({ ok: true, status: 'review_queue' });
    expect(results.find((r) => r.id === second.id)).toMatchObject({ ok: false, error: { code: 'NOT_REVIEWABLE' } });
    expect(results.find((r) => r.id === 'missing')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect((await db.select().from(items).where(eq(items.id, made[0]!.itemId)))[0]!.status).toBe('draft');

    // Dismiss what is left; an API key cannot decide.
    const open = await db.select().from(autoPublishCandidates).where(and(eq(autoPublishCandidates.siteId, siteId), eq(autoPublishCandidates.status, 'review')));
    const key = await app.request('/api/v1/auto-publish/review/batch', { method: 'POST', headers: fx.headers('a', fx.apiKeys.aEditor.token), body: JSON.stringify({ action: 'dismiss', candidateIds: open.map((o) => o.id), reason: 'x' }) }, env);
    expect(key.status).toBe(403);
    const dismissed = await new AutoPublisher({ db, siteId }).decideBatch({ action: 'dismiss', candidateIds: open.map((o) => o.id), reason: 'Handled by hand', userId: fx.users.adminA.id });
    expect(dismissed.every((r) => r.ok && r.status === 'dismissed')).toBe(true);
  });

  // ── 4.1 prompt workbench ────────────────────────────────────────────

  it('4.1: a trial streams output and diagnostics, bills the site, and writes no content item, production or gate result', async () => {
    const { doc } = await sourceDoc('/trial', `<p>${PARA}</p><p>${PARA2}</p>`);
    const before = { items: await countOf(items), productions: await countOf(aiProductions), gates: await countOf(qualityGateResults) };
    answers.push(
      JSON.stringify({
        title: 'Harbour season in review',
        summary: DESC,
        bodyHtml: `<p>Passenger numbers hit a record this season, the harbour authority said <a href="https://wire.example.com/trial">(source)</a>.</p><p>Fishing crews said the cold spring delayed the first catches but prices recovered by summer.</p>`,
        citations: [doc],
      }),
    );
    const events: TrialEvent[] = [];
    await new PromptWorkbench({ db, siteId, gateway }).trial(
      { sourceDocumentId: doc, mode: 'rewrite', targetLocale: 'en', prompt: 'Rewrite for local readers.', editorialPolicy: { forbiddenTopics: ['gambling'] } },
      (e) => void events.push(e),
    );
    expect(events.filter((e) => e.type === 'output')).toHaveLength(2);
    const diag = events.find((e) => e.type === 'diagnostics') as Extract<TrialEvent, { type: 'diagnostics' }>;
    expect(diag.checks.map((c) => c.rule)).toContain('citations');
    // The uncited paragraph is marked, with the source passage it comes from.
    const uncited = diag.paragraphs.find((p) => !p.cited)!;
    expect(uncited.text).toContain('Fishing crews');
    expect(uncited.source?.text).toContain('cold spring');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect({ items: await countOf(items), productions: await countOf(aiProductions), gates: await countOf(qualityGateResults) }).toEqual(before);
    expect(locateParagraphs('<p>Nothing alike here at all.</p>', [{ id: 'x', bodyHtml: '<p>完全不同</p>' }])[0]!.source).toBeNull();

    // Through HTTP: an event stream; an API key is refused; an unknown document is an error event.
    const h = fx.headers('a', await fx.session('adminA', 'a'));
    const res = await app.request('/api/v1/prompt-workbench/trial', { method: 'POST', headers: h, body: JSON.stringify({ sourceDocumentId: 'nope', mode: 'rewrite', targetLocale: 'en', prompt: 'x' }) }, env);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('"code":"NOT_FOUND"');
    const byKey = await app.request('/api/v1/prompt-workbench/trial', { method: 'POST', headers: fx.headers('a', fx.apiKeys.aEditor.token), body: JSON.stringify({ sourceDocumentId: doc, mode: 'rewrite', targetLocale: 'en', prompt: 'x' }) }, env);
    expect(byKey.status).toBe(403);
    // The gateway mock is not the ledger; the real gateway bills `workbench_trial` (covered by the cost matrix test).
    expect(llmAttempts).toBeDefined();
  });

  // ── 5.1 flow authoring ──────────────────────────────────────────────

  const graph = { entry: 'a', nodes: [{ id: 'a', key: 'log', options: { message: 'hello' } }] };
  const service = (mode: ApprovalMode, verify: (u: string, c: string) => Promise<boolean> = async () => false) =>
    new FlowDraftService({ db, siteId, approvalMode: async () => mode, verifySecondFactor: verify });
  const agent = () => ({ userId: null, apiKeyId: fx.apiKeys.aEditor.id });

  it('5.1: an unregistered operation is refused and named; nothing is stored', async () => {
    await expect(service('team').submit({ name: 'Bad', triggerType: 'manual', graph: { entry: 'a', nodes: [{ id: 'a', key: 'shell_exec' }] } }, agent())).rejects.toMatchObject({
      code: 'VALIDATION',
      status: 422,
      errors: [expect.objectContaining({ code: 'UNKNOWN_OPERATION', message: expect.stringContaining('shell_exec') })],
    });
    const res = await app.request('/api/v1/flow-drafts', { method: 'POST', headers: fx.headers('a', fx.apiKeys.aEditor.token), body: JSON.stringify({ name: 'Bad', triggerType: 'manual', graph: { entry: 'a', nodes: [{ id: 'a', key: 'shell_exec' }] } }) }, env);
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('UNKNOWN_OPERATION');
    expect(await db.select().from(flowDrafts).where(eq(flowDrafts.siteId, siteId))).toHaveLength(0);
  });

  it('5.1: team mode — the drafter cannot approve (403); someone else can, and the flow is created', async () => {
    const draft = await service('team').submit({ name: 'Nightly log', triggerType: 'manual', graph }, { userId: fx.users.adminA.id, apiKeyId: null }, 'agent');
    expect(draft).toMatchObject({ status: 'pending', draftedVia: 'agent', approvalMode: 'team', draftedBy: fx.users.adminA.id });
    await expect(service('team').approve(draft.id, { userId: fx.users.adminA.id, apiKeyId: null })).rejects.toMatchObject({ code: 'SELF_APPROVAL', status: 403 });
    expect((await service('team').get(draft.id)).status).toBe('pending');
    const approved = await service('team').approve(draft.id, { userId: fx.users.both.id, apiKeyId: null });
    expect(approved).toMatchObject({ status: 'approved', decidedBy: fx.users.both.id });
    const [flow] = await db.select().from(flows).where(eq(flows.id, approved.flowId!));
    expect(flow).toMatchObject({ status: 'active', name: 'Nightly log' });
  });

  it('5.1: solo mode — the drafter needs a second factor; an agent channel can never approve', async () => {
    const verify = async (_u: string, code: string) => code === '123456';
    const draft = await service('solo', verify).submit({ name: 'Solo', triggerType: 'manual', graph }, { userId: fx.users.adminA.id, apiKeyId: null }, 'agent');
    await expect(service('solo', verify).approve(draft.id, { userId: fx.users.adminA.id, apiKeyId: null })).rejects.toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', status: 403 });
    await expect(service('solo', verify).approve(draft.id, { userId: fx.users.adminA.id, apiKeyId: null }, { secondFactor: '000000' })).rejects.toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
    await expect(service('solo', verify).approve(draft.id, agent())).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    // Over HTTP: an API key is refused; a session without a code too (no TOTP enrolled).
    const viaKey = await app.request(`/api/v1/flow-drafts/${draft.id}/approve`, { method: 'POST', headers: fx.headers('a', fx.apiKeys.aEditor.token), body: '{}' }, env);
    expect(viaKey.status).toBe(403);
    expect((await service('solo').get(draft.id)).status).toBe('pending');
    const ok = await service('solo', verify).approve(draft.id, { userId: fx.users.adminA.id, apiKeyId: null }, { secondFactor: '123456' });
    expect(ok).toMatchObject({ status: 'approved', verification: 'totp' });
    // The agent tool: drafts through the harness skill (agent channel), drafter from its key.
    const viaAgent = await service('solo').submit({ name: 'From agent', triggerType: 'manual', graph }, agent());
    expect(viaAgent).toMatchObject({ draftedVia: 'agent', apiKeyId: fx.apiKeys.aEditor.id });
  });
});
