/**
 * The briefing-style rewrite (HeoPress v1.1 backlog P09; spec ai/content-pipeline "简报式改写"), against the real
 * database with a stub model gateway: the production generates a structured brief first and writes the draft from it,
 * the brief is inspectable on the run record and on the draft item, and the ledger bills the brief call under `brief`
 * and the article call under `write` — once each, never double counted.
 *
 * Model calls are stubbed, but their ledger rows are real: the stub writes the same `lumibase_llm_calls` /
 * `lumibase_llm_attempts` rows the gateway writes, with a price per capability, so the pipeline's own cost lookup
 * (`costOf`) is what the assertions read.
 */
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  aiProductions,
  aiProductionSteps,
  contentProvenance,
  items,
  llmAttempts,
  llmCalls,
  scopedDatabase,
  siteContentSettings,
  type Database,
} from '@heopress/database';
import type { StorageObject, StorageProvider } from '@heopress/runtime';
import { IngestSourceService } from '../services/ingest/source-service';
import { operationIdFor, registerSourceDocument } from '../services/ingest/source-documents';
import type { ChatCallInput, ChatCallResult } from '../services/llm/gateway';
import { ContentPipeline } from '../services/pipeline/content-pipeline';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { ensureContentSettings, upgradeSitePreset } from '../services/site-network/preset-installer';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/** Enough storage for the snapshot the source-document writer takes (its bytes are never read by this suite). */
class MemoryStorage implements StorageProvider {
  objects = new Map<string, Buffer>();
  async put(key: string, data: ReadableStream | Buffer): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(data) ? data : Buffer.from(await new Response(data).arrayBuffer()));
  }
  async get(key: string): Promise<StorageObject | null> {
    const body = this.objects.get(key);
    return body ? { key, body, size: body.byteLength } : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(prefix = ''): Promise<{ keys: string[] }> {
    return { keys: [...this.objects.keys()].filter((k) => k.startsWith(prefix)) };
  }
}

/** Micros per capability: the brief and the article are priced apart. */
const PRICE = { value_assessment: 10, brief: 30, write: 70 } as const;
const priceOf = (capability: string): number => (capability in PRICE ? PRICE[capability as keyof typeof PRICE] : 0);

const BRIEF = {
  thesis: 'The harbour reopened after the storm, and the ferry timetable is the proof.',
  audience: 'Commuters in Example Town.',
  angle: 'What the timetable means for the morning crossing.',
  sections: [{ heading: 'What changed', keyPoints: ['The first ferry leaves at 06:10'], sourceIds: [] as string[] }],
  tone: 'Plain and practical.',
  wordBudget: 800,
  seo: { title: 'Example Town ferries after the storm', description: 'The new timetable.', keywords: ['ferries'] },
};

describe.skipIf(!hasDbIntegrationUrl)('briefing-style rewrite — DB integration', () => {
  let db: Database; // the application role: the code under test
  let fixtures: Database; // the owner: test data and stored-row checks
  let fx: CrossSiteFixture;
  let siteId = '';
  const calls: ChatCallInput[] = [];
  let seq = 0;

  /** The brief answers with `doc` as the source its article must cite. */
  const briefFor = (doc: string) => ({ ...BRIEF, sections: BRIEF.sections.map((s) => ({ ...s, sourceIds: [doc] })) });

  /** The stub gateway: fixed answers, and ledger rows (calls + settled attempts) like the real one. */
  const gateway = {
    chat: async (req: ChatCallInput): Promise<ChatCallResult> => {
      calls.push(req);
      const capability = req.capability ?? 'chat';
      const payload = JSON.parse(String(req.messages[0]!.content)) as { sources?: Array<{ id: string }> };
      const doc = payload.sources?.[0]?.id ?? '';
      seq += 1;
      const callId = `call_${seq}`;
      const period = new Date().toISOString().slice(0, 7);
      await fixtures.insert(llmCalls).values({
        id: callId,
        siteId,
        callKey: req.callKey ?? `k${seq}`,
        taskType: req.taskType,
        originKind: req.origin.kind,
        originId: req.origin.id ?? null,
        capability: req.capability ?? null,
        requestDigest: 'd',
        candidates: [],
        deadlineAt: new Date(Date.now() + 60_000),
        // A stand-in terminal state: this stub wrote no winner, and the ledger is what the test reads.
        status: 'failed',
        terminalReason: 'TEST',
      });
      await fixtures.insert(llmAttempts).values({
        siteId,
        callId,
        seq: 1,
        position: 0,
        source: 'instance',
        instanceRef: 'llm-default',
        snapshot: { name: 'Mock', model: 'mock-model-1', pricing: { kind: 'per_request', requestMicros: priceOf(capability) }, currency: 'USD' },
        requestDigest: 'd',
        period,
        outcome: 'succeeded',
        billing: 'settled',
        reservedMicros: priceOf(capability),
        actualMicros: priceOf(capability),
        inputTokens: 100,
        outputTokens: 50,
        settledBy: 'auto',
      });
      const content =
        capability === 'value_assessment'
          ? JSON.stringify({ score: 90, reasons: ['Timely'] })
          : capability === 'brief'
            ? JSON.stringify(briefFor(doc))
            : JSON.stringify({ title: 'From the brief', summary: 'Summary.', bodyHtml: '<p>The ferry leaves at 06:10.</p>', citations: [doc] });
      return { response: { content, toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } }, provider: 'mock', model: 'mock-model-1', callId, attemptIds: [] };
    },
  };

  const pipeline = () => new ContentPipeline({ db: scopedDatabase(db, { site: siteId }), siteId, gateway });

  beforeAll(async () => {
    db = await connectDbIntegration('brief-rewrite');
    fixtures = await connectDbFixtures('brief-rewrite');
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(fixtures, { prefix: 'briefrw', jwtSecret: 'brief-rewrite-secret' });
    siteId = fx.sites.a;
    calls.length = 0;
    seq = 0;
    for (const s of [fx.sites.a, fx.sites.b]) {
      await upgradeSitePreset(db, s);
      await fixtures.transaction((tx) => ensureContentSettings(tx as never, s));
    }
    const [row] = await fixtures.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    await new ContentSettingsService({ db: scopedDatabase(db, { site: siteId }), siteId, actor: { userId: null } }).update({
      availableLocales: ['en', 'zh-CN'],
      timezone: row!.timezone,
      siteType: 'blog',
      trailingSlash: row!.trailingSlash as 'always',
      localeStrategy: row!.localeStrategy as 'subdirectory',
      localePrefixMode: row!.localePrefixMode as 'default_at_root',
      localePrefixes: row!.localePrefixes,
      permalinks: row!.permalinks,
      allowCrossSiteTranslations: row!.allowCrossSiteTranslations,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: row!.version,
    } as never);
  });
  afterEach(async () => {
    if (fx) await fx.teardown();
  });

  /** A licensed source document, written as the owner and read back by the pipeline. */
  async function sourceDocument(storage: MemoryStorage): Promise<string> {
    const svc = new IngestSourceService({ db: scopedDatabase(db, { site: siteId }), siteId, actor: { isAdmin: true, userId: null } });
    const source = await svc.create({ name: 'Wire', type: 'url', url: 'https://wire.example.com/', scheduleTimes: ['08:00'], timezone: 'UTC' });
    await svc.reviseLicence(source.id, {
      evidence: 'Signed agreement EX-1',
      licenceStatus: 'licensed',
      usageMode: 'licensed_derivative',
      commercialUse: true,
      reviewDueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const url = 'https://wire.example.com/harbour-brief';
    const body = '<p>The harbour authority in Example Town reported a busy season for ferries and fishing boats.</p>';
    const res = await registerSourceDocument(
      { db: scopedDatabase(db, { site: siteId }), storage },
      {
        siteId,
        sourceId: source.id,
        run: null,
        operationId: operationIdFor(source.id, 'manual', url),
        url,
        page: { url, finalUrl: url, status: 200, contentType: 'text/html', headers: new Headers(), body: Buffer.from(body), durationMs: 3 },
        extracted: {
          title: 'Harbour season',
          author: null,
          publishedAt: null,
          language: 'en',
          canonicalCandidate: null,
          bodyHtml: body,
          bodyText: body.replace(/<[^>]+>/g, ' ').trim(),
          contentHash: 'brief-rewrite-hash',
          hiddenContent: [],
          linkDensity: 0,
          ruleVersion: 'test@1',
        },
        startedAt: new Date(),
      },
    );
    return res.documentId;
  }

  it('persists the brief on the run record and the draft, and bills brief and write apart', async () => {
    const doc = await sourceDocument(new MemoryStorage());
    const res = await pipeline().produce({ mode: 'brief', sourceDocumentIds: [doc], targetLocale: 'en' });
    expect(res.status, res.reason ?? '').toBe('drafted');
    expect(res.itemId).toBeTruthy();

    const [prod] = await fixtures.select().from(aiProductions).where(and(eq(aiProductions.siteId, siteId), eq(aiProductions.id, res.productionId)));
    expect(prod).toMatchObject({ mode: 'brief', status: 'drafted', itemId: res.itemId });

    // The brief is on the run record, and the draft says what it was written from.
    const steps = await fixtures.select().from(aiProductionSteps).where(eq(aiProductionSteps.productionId, res.productionId));
    const briefStep = steps.find((s) => s.step === 'brief')!;
    const writeStep = steps.find((s) => s.step === 'write')!;
    const expected = briefFor(doc);
    expect(briefStep).toMatchObject({ capability: 'brief', promptVersion: 'brief@1', outcome: 'ok', costMicros: PRICE.brief });
    expect(briefStep.detail).toMatchObject({ attempt: 1, brief: expected });
    expect(writeStep).toMatchObject({ capability: 'write', promptVersion: 'write@1', outcome: 'ok', costMicros: PRICE.write });
    const [item] = await fixtures.select().from(items).where(and(eq(items.siteId, siteId), eq(items.id, res.itemId!)));
    expect(item!.status).toBe('draft');
    expect((item!.data as Record<string, unknown>).brief).toEqual(expected);

    // Ledger: one call per capability, each attempt billed once — the brief's cost is not folded into the article's.
    const briefCall = await fixtures.select().from(llmCalls).where(and(eq(llmCalls.siteId, siteId), eq(llmCalls.capability, 'brief')));
    const writeCall = await fixtures.select().from(llmCalls).where(and(eq(llmCalls.siteId, siteId), eq(llmCalls.capability, 'write')));
    expect(briefCall).toHaveLength(1);
    expect(writeCall).toHaveLength(1);
    expect(briefCall[0]!.id).toBe(briefStep.callId);
    expect(writeCall[0]!.id).toBe(writeStep.callId);
    expect(briefStep.callId).not.toBe(writeStep.callId);
    const attempts = await fixtures.select().from(llmAttempts).where(and(eq(llmAttempts.siteId, siteId), eq(llmAttempts.billing, 'settled')));
    const briefAttempts = attempts.filter((a) => a.callId === briefStep.callId);
    const writeAttempts = attempts.filter((a) => a.callId === writeStep.callId);
    expect(briefAttempts).toHaveLength(1);
    expect(writeAttempts).toHaveLength(1);
    expect(briefAttempts[0]!.actualMicros).toBe(PRICE.brief);
    expect(writeAttempts[0]!.actualMicros).toBe(PRICE.write);
    // The production's steps total the ledger exactly: 10 (value) + 30 (brief) + 70 (write), not 200.
    expect(steps.reduce((sum, s) => sum + (s.costMicros ?? 0), 0)).toBe(PRICE.brief + PRICE.write + PRICE.value_assessment);
    expect(attempts.reduce((sum, a) => sum + (a.actualMicros ?? 0), 0)).toBe(steps.reduce((sum, s) => sum + (s.costMicros ?? 0), 0));

    // The sources are the draft's provenance, under the facts operation (a briefing-style rewrite writes its own text).
    expect(await fixtures.select().from(contentProvenance).where(and(eq(contentProvenance.siteId, siteId), eq(contentProvenance.itemId, res.itemId!)))).toEqual([
      expect.objectContaining({ sourceDocumentId: doc, operation: 'extract_facts' }),
    ]);
    // The write call was given the brief as its outline.
    const writeRequest = calls.find((c) => c.capability === 'write')!;
    expect(JSON.parse(String(writeRequest.messages[0]!.content))).toMatchObject({ brief: expected });
  });
});
