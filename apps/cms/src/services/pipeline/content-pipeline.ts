import { and, asc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { parseFragment, serializeOuter } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { AiCapability, UsageOperation } from '@heopress/contracts/schemas';
import {
  aiProductions,
  aiProductionSteps,
  collections,
  contentProvenance,
  contentVersions,
  editorialProfileVersions,
  fields as fieldsTable,
  ingestSourceDocuments,
  ingestSources,
  items,
  llmAttempts,
  llmSiteSettings,
  translationBlockMap,
  translationGroups,
  type Database,
} from '@heopress/database';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { blockFieldsOf, replaceHtmlBlock, type BlockFieldKind } from '../block-ids';
import { hashData } from '../content-version-service';
import { assertUsageAllowed, type UsageDecision } from '../ingest/usage';
import { recordDerivation } from '../ingest/licence-lapse';
import { itemServiceForSystem } from '../item-service-factory';
import type { ChatCallInput, ChatCallResult, LlmGateway } from '../llm/gateway';
import { claimDailyProcessing, type QuotaPlan } from '../llm/daily';
import { afterTaskFailure } from '../llm/governance';
import { assertPipelineRunnable } from '../llm/pipeline-control';
import { LlmTranslationService, type TranslationService } from '../llm/translation-service';
import { runSiteTransaction, withSiteScope, type SiteTransaction } from '../rls-transaction';
import { blocksOfItem, retranslation } from '../site-network/freshness';
import { htmlBlocks } from '../site-network/freshness-blocks';
import { TranslationGroupService } from '../site-network/translation-group-service';
import { lockMembership } from '../site-network/translation-groups';
import { DbTranslationMemory, loadGlossary, translateBlocks, type SourceBlock, type TranslationMemoryStore } from './block-translation';
import { QualityGate, qualityGateRunnerFor, type UrlChecker } from '../quality-gate/quality-gate';
import { publishProposer, qualityGateRunner, type GateOutcome, type PublishProposal } from './extension-points';
import { DEFAULT_RESEARCH_LIMITS, ResearchTerminatedError, runResearch, type ResearchLimits } from './research';
import { DATA_NOT_INSTRUCTIONS, asData, keepOnlyLinks, parseModelJson, productionKey, sanitizeModelHtml, sanitizeModelText, slugOf } from './safety';

/**
 * The AI content pipeline (HeoPress P09 tasks 1.1–1.10; spec ai/content-pipeline; design decisions 1–3).
 *
 * A production turns source documents — or a translation group's source item — into a **draft** of this site:
 *
 *   - `translate`: block by block, translation memory → glossary → model (`block-translation.ts`);
 *   - `rewrite`: one or more licensed sources rewritten for the site's audience, following its editorial profile, with
 *     citations;
 *   - `write`: an original piece from facts, after a bounded research run (`research.ts`), with citations;
 *   - `retranslate`: only the stale, not human-edited blocks of a translation (the P05 contract `retranslation`), into a
 *     new draft revision (a content version) — the live item stays as it is.
 *
 * Every production:
 *   - starts only when the site's pipeline is runnable (`assertPipelineRunnable`: budget/manual/incident pauses, kill
 *     switch); source documents enter processing through the daily quota (`claimDailyProcessing`, `fetchSources`);
 *   - is idempotent: its key (`productionKey`) is unique per site, so a second trigger returns the first production;
 *   - checks before each step that every source's **current** terms allow the operation (`assertUsageAllowed`) —
 *     a discovery-only source is never translated — and records provenance (`recordDerivation`) for the draft;
 *   - assesses value before rewriting or writing: below the site's threshold, no draft;
 *   - records every step and model call (model, prompt version, editorial profile version, tokens, cost) and the full
 *     source records (URL, snapshot, licence) as read from the database;
 *   - on failure follows `afterTaskFailure`: a deferral (rate limit, open breaker, daily budget) reschedules without
 *     spending a retry; any other error spends one.
 *
 * Nothing here publishes. `runGate` runs the quality gate (built in, or the runner installed at the extension point);
 * `proposePublish` calls the publish decision extension point (auto-publish, slice 4).
 */

type Tx = SiteTransaction;
type Element = DefaultTreeAdapterMap['element'];
type ProductionRow = typeof aiProductions.$inferSelect;

type ProductionMode = 'translate' | 'rewrite' | 'write' | 'retranslate';

const PROMPT_VERSIONS = {
  translate: 'translate@1',
  retranslate: 'translate@1',
  rewrite: 'rewrite@1',
  write: 'write@1',
  seo_copy: 'seo-copy@1',
  value_assessment: 'value@1',
} as const;

/** The usage operation each mode needs from every source (P08 usage contract). */
const MODE_OPERATION: Record<ProductionMode, UsageOperation> = {
  translate: 'translate',
  retranslate: 'translate',
  rewrite: 'rewrite',
  write: 'extract_facts',
};

class PipelineError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'BAD_REQUEST' | 'BAD_OUTPUT' | 'NO_CITATIONS' | 'NOT_DRAFTED',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PipelineError';
  }
}

/** A source's current terms do not allow the step. Never retried: a person must change the terms. */
class UsageRefusedError extends Error {
  constructor(readonly refusals: Array<{ sourceDocumentId: string; decision: UsageDecision }>) {
    super(`USAGE_REFUSED: ${refusals.map((r) => `${r.sourceDocumentId} (${r.decision.allowed ? '' : r.decision.reason})`).join(', ')}`);
    this.name = 'UsageRefusedError';
  }
}

export interface PipelineDeps {
  db: Database;
  siteId: string;
  gateway: Pick<LlmGateway, 'chat'>;
  /** Default: the LLM implementation over `gateway`. */
  translator?: TranslationService;
  /** Default: the site's database memory for the language pair. */
  memoryFor?: (from: string, to: string) => TranslationMemoryStore;
  researchLimits?: Partial<ResearchLimits>;
  /** How the quality gate checks cited URLs (default: the SSRF-guarded outbound fetch). */
  urlChecker?: UrlChecker;
  flowRunId?: string | null;
  now?: () => Date;
}

/** A source document as the pipeline uses it: content plus its record, terms as they are **now**. */
export interface SourceRecord {
  id: string;
  sourceId: string;
  /** The document's content hash: its version. */
  version: string;
  url: string;
  finalUrl: string;
  snapshotId: string;
  title: string;
  language: string | null;
  bodyHtml: string;
  bodyText: string;
  source: typeof ingestSources.$inferSelect;
}

export interface ProduceRequest {
  mode: 'translate' | 'rewrite' | 'write';
  sourceDocumentIds: string[];
  targetLocale: string;
  /** Default `articles`. */
  collection?: string;
  promptVersion?: string;
  /** The source language when the document does not say (default `en`). */
  sourceLocale?: string;
}

export interface ProduceResult {
  productionId: string;
  status: ProductionRow['status'];
  itemId: string | null;
  /** True when an earlier trigger made (or is making) this production. */
  duplicate: boolean;
  reason?: string | null;
}

const recordOf = (s: SourceRecord) => ({
  kind: 'source_document',
  id: s.id,
  version: s.version,
  sourceId: s.sourceId,
  url: s.url,
  finalUrl: s.finalUrl,
  snapshotId: s.snapshotId,
  title: s.title,
  licenceRevisionId: s.source.licenceRevisionId,
  licenceStatus: s.source.licenceStatus,
  usageMode: s.source.usageMode,
  attribution: s.source.attribution,
});

const isElement = (n: { nodeName: string }): n is Element => 'tagName' in n;

/** Top-level elements of an HTML fragment (outer HTML, `data-block-id` dropped), with their block ids. */
function elementsOf(html: string): Array<{ id: string | null; html: string }> {
  const out: Array<{ id: string | null; html: string }> = [];
  for (const node of parseFragment(html ?? '').childNodes) {
    if (!isElement(node)) continue;
    const id = node.attrs.find((a) => a.name === 'data-block-id')?.value ?? null;
    node.attrs = node.attrs.filter((a) => a.name !== 'data-block-id');
    out.push({ id, html: serializeOuter(node) });
  }
  return out;
}

/** One translated element with block id `id` (any id the model added is replaced). */
function withBlockId(html: string, id: string): string {
  const el = elementsOf(html)[0];
  if (!el) throw new PipelineError('BAD_OUTPUT', 'A translated block is not an element.');
  return el.html.replace(/^<([a-zA-Z][a-zA-Z0-9]*)/, `<$1 data-block-id="${id.replace(/"/g, '')}"`);
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class ContentPipeline {
  private readonly translator: TranslationService;

  constructor(private readonly deps: PipelineDeps) {
    this.translator = deps.translator ?? new LlmTranslationService(deps.gateway);
  }

  private get siteId(): string {
    return this.deps.siteId;
  }
  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.siteId, fn);
  }
  private memory(from: string, to: string): TranslationMemoryStore {
    return this.deps.memoryFor?.(from, to) ?? new DbTranslationMemory({ db: this.deps.db, siteId: this.siteId, from, to });
  }
  /** Draft writes: an agent's (never marks a translation block as a person's edit). */
  private items(db: Database = this.deps.db) {
    return itemServiceForSystem({ db, siteId: this.siteId, provenance: { authorType: 'agent', runId: this.deps.flowRunId ?? null } }, 'background-worker');
  }

  // ── sources ─────────────────────────────────────────────────────────

  private async loadSources(ids: string[]): Promise<SourceRecord[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) throw new PipelineError('BAD_REQUEST', 'No source documents given.');
    const rows = await this.tx((tx) =>
      tx
        .select({ doc: ingestSourceDocuments, source: ingestSources })
        .from(ingestSourceDocuments)
        .innerJoin(ingestSources, and(eq(ingestSources.siteId, ingestSourceDocuments.siteId), eq(ingestSources.id, ingestSourceDocuments.sourceId)))
        .where(and(eq(ingestSourceDocuments.siteId, this.siteId), inArray(ingestSourceDocuments.id, unique))),
    );
    if (rows.length !== unique.length) throw new PipelineError('NOT_FOUND', 'A source document does not exist on this site.');
    return rows
      .map(({ doc, source }) => ({
        id: doc.id,
        sourceId: doc.sourceId,
        version: doc.contentHash,
        url: doc.url,
        finalUrl: doc.finalUrl,
        snapshotId: doc.snapshotId,
        title: doc.title,
        language: doc.language,
        bodyHtml: doc.bodyHtml,
        bodyText: doc.bodyText,
        source,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Every source's current terms against `operation`; refused → `UsageRefusedError` (recorded by the caller). */
  private usage(sources: Array<{ id: string; source: typeof ingestSources.$inferSelect }>, operation: UsageOperation) {
    const now = this.now();
    const decisions = sources.map((s) => ({ sourceDocumentId: s.id, decision: assertUsageAllowed(s.source, operation, now) }));
    return { decisions, refused: decisions.filter((d) => !d.decision.allowed) };
  }

  /** Re-read the sources' terms (they may change mid-run) and check `operation` before `step`. */
  private async checkUsage(prod: ProductionRow, sourceIds: string[], operation: UsageOperation, before: string): Promise<void> {
    if (!sourceIds.length) return;
    const current = await this.tx((tx) =>
      tx
        .select({ id: ingestSourceDocuments.id, source: ingestSources })
        .from(ingestSourceDocuments)
        .innerJoin(ingestSources, and(eq(ingestSources.siteId, ingestSourceDocuments.siteId), eq(ingestSources.id, ingestSourceDocuments.sourceId)))
        .where(and(eq(ingestSourceDocuments.siteId, this.siteId), inArray(ingestSourceDocuments.id, sourceIds))),
    );
    const { decisions, refused } = this.usage(current, operation);
    await this.step(prod, 'usage_check', {
      outcome: refused.length ? 'refused' : 'ok',
      detail: { before, operation, decisions },
    });
    if (refused.length) throw new UsageRefusedError(refused);
  }

  /**
   * Admit source documents into today's processing (the daily quota, site time zone) and check each may be used at
   * all (`use_as_lead`). The rest is deferred by priority to later days.
   */
  async fetchSources(ids: string[], opts: { priority?: number } = {}): Promise<{
    admitted: Array<ReturnType<typeof recordOf>>;
    deferred: QuotaPlan['deferred'];
    refused: Array<{ sourceDocumentId: string; reason: string }>;
  }> {
    await this.tx((tx) => assertPipelineRunnable(tx, this.siteId, this.now()));
    const sources = await this.loadSources(ids);
    const plan = await claimDailyProcessing(
      { db: this.deps.db, now: () => this.now() },
      this.siteId,
      sources.map((s) => ({ id: s.id, priority: opts.priority ?? 0, eligibleAt: this.now() })),
    );
    const admitted = sources.filter((s) => plan.admitted.includes(s.id));
    const { refused } = this.usage(admitted, 'use_as_lead');
    const refusedIds = new Set(refused.map((r) => r.sourceDocumentId));
    return {
      admitted: admitted.filter((s) => !refusedIds.has(s.id)).map(recordOf),
      deferred: plan.deferred,
      refused: refused.map((r) => ({ sourceDocumentId: r.sourceDocumentId, reason: r.decision.allowed ? '' : r.decision.reason })),
    };
  }

  // ── the run record ──────────────────────────────────────────────────

  private async step(
    prod: ProductionRow,
    step: string,
    fields: { outcome?: string; detail?: Record<string, unknown>; capability?: AiCapability; call?: { callId: string; provider: string; model: string; usage?: { inputTokens: number | null; outputTokens: number | null } }; promptVersion?: string },
  ): Promise<void> {
    const cost = fields.call ? await this.costOf(fields.call.callId) : null;
    await this.tx((tx) =>
      tx.insert(aiProductionSteps).values({
        siteId: this.siteId,
        productionId: prod.id,
        step,
        capability: fields.capability ?? null,
        callId: fields.call?.callId ?? null,
        provider: fields.call?.provider ?? null,
        model: fields.call?.model ?? null,
        promptVersion: fields.promptVersion ?? (fields.call ? prod.promptVersion : null),
        editorialProfileVersion: prod.editorialProfileVersion,
        inputTokens: fields.call?.usage?.inputTokens ?? null,
        outputTokens: fields.call?.usage?.outputTokens ?? null,
        costMicros: cost,
        outcome: fields.outcome ?? 'ok',
        detail: fields.detail ?? {},
      }),
    );
  }

  /** What a call cost, from the ledger: settled attempts at their actual cost, others at their reservation. */
  async costOf(callId: string): Promise<number> {
    const [row] = await this.tx((tx) =>
      tx
        .select({
          total: sql<string>`COALESCE(SUM(CASE WHEN ${llmAttempts.billing} = 'settled' THEN ${llmAttempts.actualMicros} WHEN ${llmAttempts.billing} IN ('reserved', 'unknown') THEN ${llmAttempts.reservedMicros} ELSE 0 END), 0)::text`,
        })
        .from(llmAttempts)
        .where(and(eq(llmAttempts.siteId, this.siteId), eq(llmAttempts.callId, callId))),
    );
    return Number(row?.total ?? 0);
  }

  /** A model call for a step, recorded with its tokens and cost; the answer as JSON (null when it is not). */
  private async call(
    prod: ProductionRow,
    step: string,
    capability: AiCapability,
    input: { systemPrompt: string; data: unknown; maxOutputTokens: number; n?: number; promptVersion?: string },
  ): Promise<{ json: Record<string, unknown> | null; result: ChatCallResult }> {
    const req: ChatCallInput = {
      siteId: this.siteId,
      taskType: 'generation',
      capability,
      origin: { kind: 'ai_production', id: prod.id },
      callKey: `production:${prod.id}:${step}:${input.n ?? 1}:a${prod.attempts}`,
      systemPrompt: input.systemPrompt,
      tools: false,
      messages: [{ role: 'user', content: asData(input.data) }],
      maxOutputTokens: input.maxOutputTokens,
    };
    const result = await this.deps.gateway.chat(req);
    const json = parseModelJson(result.response.content);
    await this.step(prod, step, {
      capability,
      call: { callId: result.callId, provider: result.provider, model: result.model, usage: result.response.usage },
      promptVersion: input.promptVersion,
      outcome: json ? 'ok' : 'failed',
    });
    return { json, result };
  }

  // ── productions ─────────────────────────────────────────────────────

  private async editorialProfile(): Promise<{ version: number | null; content: Record<string, unknown> }> {
    const [row] = await this.tx((tx) =>
      tx
        .select({ version: editorialProfileVersions.version, content: editorialProfileVersions.content })
        .from(editorialProfileVersions)
        .where(and(eq(editorialProfileVersions.siteId, this.siteId), eq(editorialProfileVersions.status, 'published'))),
    );
    return { version: row?.version ?? null, content: row?.content ?? {} };
  }

  /**
   * Claim the production of `key`: a new row, or an earlier one whose retry is due. Otherwise the earlier one is the
   * answer (duplicate trigger: no second draft).
   */
  private async claim(values: typeof aiProductions.$inferInsert): Promise<{ row: ProductionRow; fresh: boolean }> {
    return this.tx(async (tx) => {
      const [created] = await tx.insert(aiProductions).values(values).onConflictDoNothing().returning();
      if (created) return { row: created, fresh: true };
      const key = and(eq(aiProductions.siteId, this.siteId), eq(aiProductions.idempotencyKey, values.idempotencyKey));
      const [resumed] = await tx
        .update(aiProductions)
        .set({ status: 'running', updatedAt: this.now() })
        .where(and(key, eq(aiProductions.status, 'retry_scheduled'), or(isNull(aiProductions.notBefore), sql`${aiProductions.notBefore} <= ${this.now().toISOString()}::timestamptz`)))
        .returning();
      if (resumed) return { row: resumed, fresh: true };
      const [existing] = await tx.select().from(aiProductions).where(key);
      return { row: existing!, fresh: false };
    });
  }

  private async finish(prod: ProductionRow, set: Partial<typeof aiProductions.$inferInsert>): Promise<ProductionRow> {
    const [row] = await this.tx((tx) =>
      tx
        .update(aiProductions)
        .set({ ...set, updatedAt: this.now() })
        .where(and(eq(aiProductions.siteId, this.siteId), eq(aiProductions.id, prod.id)))
        .returning(),
    );
    return row!;
  }

  /** A step threw: refusals and caps end the production; anything else follows `afterTaskFailure`. */
  private async fail(prod: ProductionRow, err: unknown): Promise<ProductionRow> {
    if (err instanceof UsageRefusedError) {
      return this.finish(prod, { status: 'refused_usage', statusReason: err.refusals.map((r) => (r.decision.allowed ? '' : r.decision.reason)).join(',') });
    }
    if (err instanceof ResearchTerminatedError) {
      await this.step(prod, 'research', { outcome: 'terminated', capability: 'write', detail: { reason: err.reason, steps: err.steps } });
      return this.finish(prod, { status: 'terminated', statusReason: err.reason });
    }
    const out = afterTaskFailure({ attempts: prod.attempts, maxAttempts: prod.maxAttempts, notBefore: prod.notBefore }, err, this.now());
    const message = err instanceof Error ? err.message : String(err);
    return this.finish(prod, {
      status: out.action === 'fail' ? 'failed' : 'retry_scheduled',
      statusReason: message.slice(0, 1000),
      attempts: out.state.attempts,
      notBefore: out.state.notBefore,
    });
  }

  private resultOf(row: ProductionRow, duplicate: boolean): ProduceResult {
    return { productionId: row.id, status: row.status, itemId: row.itemId, duplicate, reason: row.statusReason };
  }

  /** Translate, rewrite or write source documents into a new draft. */
  async produce(req: ProduceRequest): Promise<ProduceResult> {
    await this.tx((tx) => assertPipelineRunnable(tx, this.siteId, this.now()));
    const sources = await this.loadSources(req.sourceDocumentIds);
    if (req.mode === 'translate' && sources.length !== 1) throw new PipelineError('BAD_REQUEST', 'A translation takes exactly one source document.');
    const profile = await this.editorialProfile();
    const promptVersion = req.promptVersion ?? PROMPT_VERSIONS[req.mode];
    const collection = req.collection ?? 'articles';
    const idempotencyKey = productionKey({
      siteId: this.siteId,
      sources: sources.map((s) => `source_document:${s.id}@${s.version}`),
      targetLocale: req.targetLocale,
      mode: req.mode,
      promptVersion,
      editorialProfileVersion: profile.version,
    });
    const { row, fresh } = await this.claim({
      siteId: this.siteId,
      idempotencyKey,
      mode: req.mode,
      targetLocale: req.targetLocale,
      collection,
      sources: sources.map(recordOf),
      promptVersion,
      editorialProfileVersion: profile.version,
      flowRunId: this.deps.flowRunId ?? null,
    });
    if (!fresh) return this.resultOf(row, true);
    const prod = row;
    const operation = MODE_OPERATION[req.mode];
    const ids = sources.map((s) => s.id);
    try {
      await this.step(prod, 'fetch_source', { detail: { sources: sources.map(recordOf) } });
      await this.checkUsage(prod, ids, operation, 'value_assessment');
      if (req.mode !== 'translate') {
        const value = await this.assessValue(prod, sources, profile.content);
        if (value.score < value.threshold) {
          return this.resultOf(
            await this.finish(prod, { status: 'low_value', valueScore: value.score, valueReasons: value.reasons, valueThreshold: value.threshold, statusReason: 'below_threshold' }),
            false,
          );
        }
        await this.finish(prod, { valueScore: value.score, valueReasons: value.reasons, valueThreshold: value.threshold });
      }
      await this.checkUsage(prod, ids, operation, req.mode);
      const fieldsOf = await this.collectionFields(collection);
      const draft =
        req.mode === 'translate'
          ? await this.translateDocument(prod, sources[0]!, req)
          : req.mode === 'rewrite'
            ? await this.compose(prod, 'rewrite', sources, profile.content, req.targetLocale, null)
            : await this.compose(prod, 'write', sources, profile.content, req.targetLocale, await this.research(prod, sources, profile.content, req.targetLocale));
      // The draft write is a step too: the terms may have changed during the model calls.
      await this.checkUsage(prod, ids, operation, 'draft');
      const bodyField = [...fieldsOf.blocks].find(([, k]) => k === 'html')?.[0] ?? 'body';
      const data = this.only(fieldsOf.names, {
        title: draft.title,
        slug: slugOf(draft.title, `${req.mode}-${prod.id.slice(0, 10).toLowerCase()}`),
        locale: req.targetLocale,
        [bodyField]: draft.bodyHtml,
        excerpt: draft.summary,
      });
      const created = (await this.items().create(collection, { data, status: 'draft' })) as { id: string };
      // Block map of a translation: source block → the draft's block (ids assigned on write).
      let blockMap = draft.blockMap;
      if (blockMap.length) {
        const [stored] = await this.tx((tx) => tx.select({ data: items.data }).from(items).where(and(eq(items.siteId, this.siteId), eq(items.id, created.id))));
        const keys = htmlBlocks(bodyField, ((stored?.data ?? {}) as Record<string, unknown>)[bodyField]).map((b) => b.key);
        let i = 0;
        blockMap = blockMap.map((m) => (String(m.sourceKey).startsWith('body#') ? { ...m, targetKey: keys[i++] ?? null } : m));
      }
      for (const s of sources) await recordDerivation(this.deps.db, { siteId: this.siteId, itemId: created.id, sourceDocumentId: s.id, operation });
      return this.resultOf(await this.finish(prod, { status: 'drafted', statusReason: null, itemId: created.id, blockMap }), false);
    } catch (err) {
      return this.resultOf(await this.fail(prod, err), false);
    }
  }

  /** The collection's field names and block fields. */
  private async collectionFields(collection: string): Promise<{ names: Set<string>; blocks: Map<string, BlockFieldKind> }> {
    const rows = await this.tx((tx) =>
      tx
        .select({ name: fieldsTable.name, interface: fieldsTable.interface })
        .from(fieldsTable)
        .innerJoin(collections, eq(collections.id, fieldsTable.collectionId))
        .where(and(eq(collections.siteId, this.siteId), eq(collections.name, collection))),
    );
    if (!rows.length) throw new PipelineError('NOT_FOUND', `No collection "${collection}" with fields on this site.`);
    return { names: new Set(rows.map((r) => r.name)), blocks: blockFieldsOf(rows) };
  }

  private only(names: Set<string>, data: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(data).filter(([k, v]) => names.has(k) && v !== undefined && v !== null && v !== ''));
  }

  /** Value assessment (task 1.10): a score 0–100 and reasons, against the site's threshold. */
  private async assessValue(prod: ProductionRow, sources: SourceRecord[], policy: Record<string, unknown>): Promise<{ score: number; reasons: string[]; threshold: number }> {
    const [settings] = await this.tx((tx) => tx.select({ t: llmSiteSettings.valueThreshold }).from(llmSiteSettings).where(eq(llmSiteSettings.siteId, this.siteId)));
    const threshold = settings?.t ?? 60;
    const { json } = await this.call(prod, 'value_assessment', 'value_assessment', {
      systemPrompt: `You judge whether source documents are worth turning into an article for this site, by its editorial policy (audience, topics, forbidden topics): new information, relevance, depth, timeliness.
${DATA_NOT_INSTRUCTIONS}
Answer with JSON only: {"score": <integer 0-100>, "reasons": ["<short reason>", ...]}.`,
      data: { editorialPolicy: policy, sources: sources.map((s) => ({ id: s.id, title: s.title, text: s.bodyText.slice(0, 8000) })) },
      maxOutputTokens: 400,
      promptVersion: PROMPT_VERSIONS.value_assessment,
    });
    const score = Number(json?.score);
    if (!json || !Number.isFinite(score)) throw new PipelineError('BAD_OUTPUT', 'The value assessment did not answer with a score.');
    const reasons = Array.isArray(json.reasons) ? json.reasons.map((r) => sanitizeModelText(r, 300)).filter(Boolean).slice(0, 10) : [];
    return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, threshold };
  }

  /** Translate one source document: title and top-level blocks. */
  private async translateDocument(prod: ProductionRow, source: SourceRecord, req: ProduceRequest) {
    const from = source.language ?? req.sourceLocale ?? 'en';
    const elements = elementsOf(source.bodyHtml);
    const blocks: SourceBlock[] = [
      { key: 'title', text: source.title, plain: true },
      ...elements.map((e, i) => ({ key: `body#s${i + 1}`, text: e.html })),
    ];
    const profile = await this.editorialProfile();
    const glossary = await loadGlossary(this.deps.db, this.siteId, from, req.targetLocale, (profile.content.glossary as Array<{ term: string; preferred?: string }>) ?? []);
    const out = await translateBlocks({
      siteId: this.siteId,
      from,
      to: req.targetLocale,
      blocks,
      memory: this.memory(from, req.targetLocale),
      glossary,
      service: this.translator,
      callKey: `production:${prod.id}:translate:a${prod.attempts}`,
      origin: { kind: 'ai_production', id: prod.id },
      capability: 'translate',
      context: `source_document:${source.id}`,
    });
    await this.step(prod, 'translate', {
      capability: out.call ? 'translate' : undefined,
      call: out.call ? { callId: out.call.callId, provider: out.call.provider, model: out.call.model } : undefined,
      detail: { memoryHits: out.memoryHits, fuzzyReferences: out.fuzzyReferences, glossaryApplied: out.glossaryApplied, forbiddenFound: out.forbiddenFound, engine: out.call?.engine ?? 'memory' },
    });
    const byKey = new Map(out.blocks.map((b) => [b.key, b]));
    const bodyHtml = out.blocks.filter((b) => b.key.startsWith('body#')).map((b) => b.text).join('');
    const attribution = source.source.attribution ? `<p>${escapeHtml(source.source.attribution)}</p>` : '';
    return {
      title: byKey.get('title')!.text,
      bodyHtml: bodyHtml + this.citations([source]) + attribution,
      summary: undefined as string | undefined,
      blockMap: blocks
        .filter((b) => b.key.startsWith('body#'))
        .map((b) => ({ sourceKey: b.key, sourceHash: htmlBlocks('x', `<div data-block-id="h">${b.text}</div>`)[0]?.hash ?? null, origin: byKey.get(b.key)!.origin })),
    };
  }

  /** The citations block, from the database records (a model never supplies these URLs). */
  private citations(sources: SourceRecord[]): string {
    const li = sources.map((s) => `<li><a href="${escapeHtml(s.finalUrl)}" rel="nofollow noopener noreferrer">${escapeHtml(s.title)}</a></li>`).join('');
    return `<section data-citations="true"><h2>Sources</h2><ul>${li}</ul></section>`;
  }

  /** Research for `write` (bounded agent, whitelisted tools). */
  private async research(prod: ProductionRow, sources: SourceRecord[], policy: Record<string, unknown>, targetLocale: string): Promise<string> {
    const limits = { ...DEFAULT_RESEARCH_LIMITS, ...this.deps.researchLimits };
    const byId = new Map(sources.map((s) => [s.id, s]));
    const { notes } = await runResearch(
      {
        chat: (input) => this.deps.gateway.chat(input),
        costOf: (callId) => this.costOf(callId),
        onCall: (result, st) =>
          this.step(prod, 'research', {
            capability: 'write',
            call: { callId: result.callId, provider: result.provider, model: result.model, usage: result.response.usage },
            outcome: st.outcome === 'refused' ? 'refused' : 'ok',
            detail: { n: st.n, tool: st.tool, outcome: st.outcome },
          }),
        tools: {
          read_source: async (args) => {
            const s = byId.get(String(args.sourceDocumentId ?? args.id ?? ''));
            return s ? { id: s.id, title: s.title, text: s.bodyText.slice(0, 12_000) } : { error: 'not_a_source_of_this_production' };
          },
          site_search: async (args) => recommendInternalLinks(this.deps.db, this.siteId, { text: String(args.query ?? ''), limit: 5 }),
        },
        now: () => this.now().getTime(),
      },
      {
        siteId: this.siteId,
        productionId: prod.id,
        brief: { targetLocale, editorialPolicy: policy, sources: sources.map((s) => ({ id: s.id, title: s.title })) },
        limits,
        editorialProfileVersion: prod.editorialProfileVersion,
        promptVersion: prod.promptVersion,
      },
    );
    return notes;
  }

  /** Rewrite or write: the editorial policy, the sources as data, citations required. */
  private async compose(prod: ProductionRow, mode: 'rewrite' | 'write', sources: SourceRecord[], policy: Record<string, unknown>, targetLocale: string, notes: string | null) {
    const task =
      mode === 'rewrite'
        ? 'Rewrite the sources into one article for this site: adapt it to the audience, add background and analysis the sources support, follow the editorial policy.'
        : 'Write an original article for this site from the facts in the sources and the research notes; do not copy their wording; follow the editorial policy.';
    const { json } = await this.call(prod, mode, mode, {
      systemPrompt: `${task}
${DATA_NOT_INSTRUCTIONS}
Write in the language targetLocale. Cite the sources you use by their ids.
Answer with JSON only: {"title": "...", "summary": "...", "bodyHtml": "<p>...</p>...", "citations": ["<source id>", ...]}.`,
      data: {
        targetLocale,
        editorialPolicy: policy,
        sources: sources.map((s) => ({ id: s.id, title: s.title, url: s.finalUrl, attribution: s.source.attribution, text: mode === 'rewrite' ? s.bodyText.slice(0, 20_000) : s.bodyText.slice(0, 8000) })),
        ...(notes !== null ? { researchNotes: notes } : {}),
      },
      maxOutputTokens: 4000,
    });
    if (!json || typeof json.bodyHtml !== 'string' || typeof json.title !== 'string') throw new PipelineError('BAD_OUTPUT', `The ${mode} answer is not the expected JSON.`);
    const ids = new Set(sources.map((s) => s.id));
    const cited = Array.isArray(json.citations) ? [...new Set(json.citations.filter((c): c is string => typeof c === 'string' && ids.has(c)))] : [];
    if (!cited.length) throw new PipelineError('NO_CITATIONS', `The ${mode} answer cites none of its sources.`);
    const citedSources = sources.filter((s) => cited.includes(s.id));
    const body = keepOnlyLinks(sanitizeModelHtml(json.bodyHtml), sources.flatMap((s) => [s.finalUrl, s.url]));
    return {
      title: sanitizeModelText(json.title, 300) || sources[0]!.title,
      summary: sanitizeModelText(json.summary, 1000) || undefined,
      bodyHtml: body + this.citations(citedSources),
      blockMap: [] as Array<Record<string, unknown>>,
    };
  }

  private async production(id: string): Promise<ProductionRow> {
    const [row] = await this.tx((tx) => tx.select().from(aiProductions).where(and(eq(aiProductions.siteId, this.siteId), eq(aiProductions.id, id))));
    if (!row) throw new PipelineError('NOT_FOUND', 'No such production.');
    return row;
  }

  private sourceDocIds(prod: ProductionRow): string[] {
    return prod.sources.filter((s) => s.kind === 'source_document').map((s) => String(s.id));
  }

  /** SEO copy for a drafted production: title, description (and nothing else), written into the draft. */
  async seoCopy(productionId: string): Promise<{ productionId: string; itemId: string; seoTitle: string; seoDescription: string }> {
    await this.tx((tx) => assertPipelineRunnable(tx, this.siteId, this.now()));
    const prod = await this.production(productionId);
    if (prod.status !== 'drafted' || !prod.itemId || prod.mode === 'retranslate') throw new PipelineError('NOT_DRAFTED', 'The production has no draft item.');
    await this.checkUsage(prod, this.sourceDocIds(prod), MODE_OPERATION[prod.mode as ProductionMode], 'seo_copy');
    const [item] = await this.tx((tx) => tx.select({ data: items.data, version: items.version }).from(items).where(and(eq(items.siteId, this.siteId), eq(items.id, prod.itemId!))));
    if (!item) throw new PipelineError('NOT_FOUND', 'The draft item is gone.');
    const data = item.data as Record<string, unknown>;
    const { json } = await this.call(prod, 'seo_copy', 'seo_copy', {
      systemPrompt: `You write the SEO title (max 60 characters) and meta description (max 155 characters) of an article, in its language.
${DATA_NOT_INSTRUCTIONS}
Answer with JSON only: {"seoTitle": "...", "seoDescription": "..."}.`,
      data: { locale: prod.targetLocale, title: data.title, text: JSON.stringify(data).slice(0, 8000) },
      maxOutputTokens: 300,
      promptVersion: PROMPT_VERSIONS.seo_copy,
    });
    const seoTitle = sanitizeModelText(json?.seoTitle, 70);
    const seoDescription = sanitizeModelText(json?.seoDescription, 170);
    if (!seoTitle || !seoDescription) throw new PipelineError('BAD_OUTPUT', 'The SEO copy is incomplete.');
    const fieldsOf = await this.collectionFields(prod.collection);
    const patch = this.only(fieldsOf.names, { seo_title: seoTitle, seo_description: seoDescription });
    if (Object.keys(patch).length) await this.items().patch(prod.collection, prod.itemId, { data: patch, expectedVersion: item.version });
    return { productionId, itemId: prod.itemId, seoTitle, seoDescription };
  }

  /** Run the installed quality gate on the draft (bound to the item version it checked). */
  async runGate(productionId: string): Promise<GateOutcome> {
    const prod = await this.production(productionId);
    if (prod.status !== 'drafted' || !prod.itemId) throw new PipelineError('NOT_DRAFTED', 'The production has no draft.');
    const [item] = await this.tx((tx) => tx.select({ version: items.version }).from(items).where(and(eq(items.siteId, this.siteId), eq(items.id, prod.itemId!))));
    if (!item) throw new PipelineError('NOT_FOUND', 'The draft item is gone.');
    const runner = qualityGateRunner() ?? qualityGateRunnerFor({ db: this.deps.db, gateway: this.deps.gateway, urlChecker: this.deps.urlChecker, now: this.deps.now });
    const outcome = await runner.run({ siteId: this.siteId, productionId, collection: prod.collection, itemId: prod.itemId, itemVersion: item.version });
    await this.finish(prod, { gate: outcome as unknown as Record<string, unknown> });
    await this.step(prod, 'gate', { outcome: outcome.status === 'blocked' ? 'refused' : 'ok', detail: { status: outcome.status, itemVersion: outcome.itemVersion } });
    return outcome;
  }

  /** Hand the draft to the installed publish decision (until slice 4: always the review queue). Never publishes here. */
  async proposePublish(productionId: string): Promise<PublishProposal> {
    const prod = await this.production(productionId);
    if (prod.status !== 'drafted' || !prod.itemId) throw new PipelineError('NOT_DRAFTED', 'The production has no draft.');
    const [item] = await this.tx((tx) => tx.select({ version: items.version }).from(items).where(and(eq(items.siteId, this.siteId), eq(items.id, prod.itemId!))));
    if (!item) throw new PipelineError('NOT_FOUND', 'The draft item is gone.');
    const gate = prod.gate as unknown as GateOutcome | null;
    // A gate result of another version does not count (it lapsed with the change); a stored result must also still
    // match the content, the gate policy and the sources' licence revisions.
    let current = gate && gate.itemVersion === item.version ? gate : null;
    if (current?.resultId) {
      const state = await new QualityGate({ db: this.deps.db, siteId: this.siteId }).current(prod.itemId);
      if (state.result?.id !== current.resultId || state.state === 'stale') current = null;
    }
    const proposal = await publishProposer().propose({ siteId: this.siteId, productionId, collection: prod.collection, itemId: prod.itemId, itemVersion: item.version, gate: current });
    await this.finish(prod, { publishProposal: proposal as unknown as Record<string, unknown> });
    await this.step(prod, 'propose_publish', { detail: { ...proposal } });
    return proposal;
  }

  // ── translations of items (translation groups, P05 block maps) ─────

  /** Source documents an item derives from, with their sources' current terms. */
  private async provenanceOf(tx: Tx, siteId: string, itemId: string) {
    return withSiteScope(tx, siteId, () =>
      tx
        .select({ id: contentProvenance.sourceDocumentId, source: ingestSources })
        .from(contentProvenance)
        .innerJoin(ingestSources, and(eq(ingestSources.siteId, contentProvenance.siteId), eq(ingestSources.id, contentProvenance.sourceId)))
        .where(and(eq(contentProvenance.siteId, siteId), eq(contentProvenance.itemId, itemId))),
    );
  }

  private groups(): TranslationGroupService {
    return new TranslationGroupService({
      db: this.deps.db,
      siteId: this.siteId,
      actor: { type: 'agent', id: this.deps.flowRunId ?? null },
      userId: null,
      itemsOn: (siteId, tx) => itemServiceForSystem({ db: tx as never, siteId, provenance: { authorType: 'agent', runId: this.deps.flowRunId ?? null } }, 'background-worker'),
    });
  }

  /** Blocks of an item to translate: its rich-text blocks (by id) and plain title / SEO fields. */
  private blocksToTranslate(data: Record<string, unknown>, blockFields: Map<string, BlockFieldKind>, only?: Set<string>): SourceBlock[] {
    const out: SourceBlock[] = [];
    for (const f of ['title', 'seo_title', 'seo_description']) {
      const key = f === 'title' ? 'title' : `${f}#$`;
      if (typeof data[f] === 'string' && data[f] && (!only || only.has(key))) out.push({ key, text: data[f] as string, plain: true });
    }
    for (const [field, kind] of blockFields) {
      if (kind !== 'html' || typeof data[field] !== 'string') continue;
      for (const el of elementsOf(data[field] as string)) {
        const key = `${field}#${el.id}`;
        if (el.id && (!only || only.has(key))) out.push({ key, text: el.html });
      }
    }
    return out;
  }

  /**
   * Translate a group's source item into a new translation draft on this site: the draft joins the group, its blocks
   * keep the source's block ids, and the P05 block map is written for every translated block.
   */
  async translateItem(req: { collection: string; sourceItemId: string; targetLocale: string; promptVersion?: string }): Promise<ProduceResult> {
    await this.tx((tx) => assertPipelineRunnable(tx, this.siteId, this.now()));
    const loaded = await this.tx(async (tx) => {
      const src = await blocksOfItem(tx, this.siteId, req.sourceItemId);
      const [row] = await tx.select({ version: items.version }).from(items).where(and(eq(items.siteId, this.siteId), eq(items.id, req.sourceItemId)));
      const prov = await this.provenanceOf(tx, this.siteId, req.sourceItemId);
      const blockRows = await tx.select({ name: fieldsTable.name, interface: fieldsTable.interface }).from(fieldsTable).where(eq(fieldsTable.collectionId, src?.collectionId ?? ''));
      return src && row ? { src, version: row.version, prov, blockFields: blockFieldsOf(blockRows) } : null;
    });
    if (!loaded || loaded.src.deleted) throw new PipelineError('NOT_FOUND', 'No such source item on this site.');
    const profile = await this.editorialProfile();
    const promptVersion = req.promptVersion ?? PROMPT_VERSIONS.translate;
    const { row, fresh } = await this.claim({
      siteId: this.siteId,
      idempotencyKey: productionKey({
        siteId: this.siteId,
        sources: [`item:${req.sourceItemId}@${loaded.version}`],
        targetLocale: req.targetLocale,
        mode: 'translate',
        promptVersion,
        editorialProfileVersion: profile.version,
      }),
      mode: 'translate',
      targetLocale: req.targetLocale,
      collection: req.collection,
      sources: [{ kind: 'item', id: req.sourceItemId, version: loaded.version }, ...loaded.prov.map((p) => ({ kind: 'source_document', id: p.id, sourceId: p.source.id, licenceRevisionId: p.source.licenceRevisionId, licenceStatus: p.source.licenceStatus, usageMode: p.source.usageMode }))],
      promptVersion,
      editorialProfileVersion: profile.version,
      flowRunId: this.deps.flowRunId ?? null,
    });
    if (!fresh) return this.resultOf(row, true);
    const prod = row;
    const docIds = loaded.prov.map((p) => p.id);
    try {
      await this.checkUsage(prod, docIds, 'translate', 'translate');
      const from = String(loaded.src.data.locale ?? 'en');
      const blocks = this.blocksToTranslate(loaded.src.data, loaded.blockFields);
      const glossary = await loadGlossary(this.deps.db, this.siteId, from, req.targetLocale, (profile.content.glossary as Array<{ term: string; preferred?: string }>) ?? []);
      const out = await translateBlocks({
        siteId: this.siteId,
        from,
        to: req.targetLocale,
        blocks,
        memory: this.memory(from, req.targetLocale),
        glossary,
        service: this.translator,
        callKey: `production:${prod.id}:translate:a${prod.attempts}`,
        origin: { kind: 'ai_production', id: prod.id },
        capability: 'translate',
        context: `item:${req.sourceItemId}`,
      });
      await this.step(prod, 'translate', {
        capability: out.call ? 'translate' : undefined,
        call: out.call ? { callId: out.call.callId, provider: out.call.provider, model: out.call.model } : undefined,
        detail: { memoryHits: out.memoryHits, fuzzyReferences: out.fuzzyReferences, glossaryApplied: out.glossaryApplied, forbiddenFound: out.forbiddenFound },
      });
      await this.checkUsage(prod, docIds, 'translate', 'draft');
      const groups = this.groups();
      const group = (await groups.forItem(req.sourceItemId)) ?? (await groups.create(req.sourceItemId));
      const { itemId } = await groups.createDraft(group.id, { locale: req.targetLocale });
      const data = this.targetData({}, loaded.src.data, out.blocks, loaded.blockFields);
      const [draft] = await this.tx((tx) => tx.select({ version: items.version }).from(items).where(and(eq(items.siteId, this.siteId), eq(items.id, itemId))));
      await this.items().patch(req.collection, itemId, { data, expectedVersion: draft!.version });
      const pairs = out.blocks.filter((b) => b.key !== 'title').map((b) => ({ sourceKey: b.key, targetKey: b.key }));
      if (pairs.length) await groups.writeMaps(group.id, { targetItemId: itemId, pairs });
      for (const id of docIds) await recordDerivation(this.deps.db, { siteId: this.siteId, itemId, sourceDocumentId: id, operation: 'translate' });
      const blockMap = out.blocks.map((b) => ({ sourceKey: b.key, targetKey: b.key, origin: b.origin }));
      return this.resultOf(await this.finish(prod, { status: 'drafted', statusReason: null, itemId, blockMap }), false);
    } catch (err) {
      return this.resultOf(await this.fail(prod, err), false);
    }
  }

  /** Apply translated blocks onto `base` (rich-text blocks by id, plain fields by name). */
  private targetData(base: Record<string, unknown>, layout: Record<string, unknown>, blocks: Array<{ key: string; text: string }>, blockFields: Map<string, BlockFieldKind>): Record<string, unknown> {
    const data: Record<string, unknown> = { ...base };
    const byKey = new Map(blocks.map((b) => [b.key, b.text]));
    if (byKey.has('title')) data.title = byKey.get('title');
    for (const f of ['seo_title', 'seo_description']) if (byKey.has(`${f}#$`)) data[f] = byKey.get(`${f}#$`);
    for (const [field, kind] of blockFields) {
      if (kind !== 'html' || typeof layout[field] !== 'string') continue;
      data[field] = elementsOf(layout[field] as string)
        .map((el) => (el.id && byKey.has(`${field}#${el.id}`) ? withBlockId(byKey.get(`${field}#${el.id}`)!, el.id) : el.id ? withBlockId(el.html, el.id) : el.html))
        .join('');
    }
    return data;
  }

  /**
   * Incremental retranslation (task 1.4; P05 contract `retranslation`): only the stale (`changed`), not human-edited
   * blocks of a translation are translated, into a new draft revision of it (a content version); the item itself —
   * and its live page — does not change until that revision goes through review and publishing. The write-back
   * checks both ends: a source block that changed again, or a target block edited, during the run is not written;
   * it goes to review instead.
   */
  async retranslate(req: { collection: string; targetItemId: string; promptVersion?: string }): Promise<ProduceResult | { status: 'nothing_to_do'; review: unknown[] }> {
    await this.tx((tx) => assertPipelineRunnable(tx, this.siteId, this.now()));
    const snap = await this.tx(async (tx) => {
      const contract = await retranslation(tx, this.siteId, req.targetItemId);
      const [target] = await tx.select({ version: items.version, data: items.data, collectionId: items.collectionId }).from(items).where(and(eq(items.siteId, this.siteId), eq(items.id, req.targetItemId)));
      if (!target) return null;
      const maps = contract.candidates.length
        ? await tx.select().from(translationBlockMap).where(and(eq(translationBlockMap.siteId, this.siteId), eq(translationBlockMap.targetItemId, req.targetItemId), inArray(translationBlockMap.targetKey, contract.candidates.map((c) => c.targetKey))))
        : [];
      const sourceItemId = contract.candidates[0]?.sourceItemId ?? null;
      const groupId = maps[0]?.groupId ?? null;
      const [group] = groupId ? await tx.select({ siteIds: translationGroups.siteIds }).from(translationGroups).where(eq(translationGroups.id, groupId)) : [];
      let source: { siteId: string; data: Record<string, unknown>; version: number; hashes: Map<string, string>; blockFields: Map<string, BlockFieldKind> } | null = null;
      for (const siteId of group?.siteIds ?? []) {
        if (!sourceItemId || source) break;
        const b = await blocksOfItem(tx, siteId, sourceItemId);
        if (!b || b.deleted) continue;
        const [v] = await withSiteScope(tx, siteId, () => tx.select({ version: items.version }).from(items).where(and(eq(items.siteId, siteId), eq(items.id, sourceItemId))));
        const fr = await withSiteScope(tx, siteId, () => tx.select({ name: fieldsTable.name, interface: fieldsTable.interface }).from(fieldsTable).where(eq(fieldsTable.collectionId, b.collectionId)));
        source = { siteId, data: b.data, version: v!.version, hashes: new Map(b.blocks.map((x) => [x.key, x.hash])), blockFields: blockFieldsOf(fr) };
      }
      const prov = source && sourceItemId ? await this.provenanceOf(tx, source.siteId, sourceItemId) : [];
      const tfr = await tx.select({ name: fieldsTable.name, interface: fieldsTable.interface }).from(fieldsTable).where(eq(fieldsTable.collectionId, target.collectionId));
      return { contract, target, maps, sourceItemId, source, prov, targetBlockFields: blockFieldsOf(tfr) };
    });
    if (!snap) throw new PipelineError('NOT_FOUND', 'No such translation on this site.');
    if (!snap.contract.candidates.length || !snap.source || !snap.sourceItemId) return { status: 'nothing_to_do', review: snap.contract.review };
    const source = snap.source;
    const profile = await this.editorialProfile();
    const promptVersion = req.promptVersion ?? PROMPT_VERSIONS.retranslate;
    const targetLocale = String((snap.target.data as Record<string, unknown>).locale ?? '') || null;
    const { row, fresh } = await this.claim({
      siteId: this.siteId,
      idempotencyKey: productionKey({
        siteId: this.siteId,
        sources: [`item:${snap.sourceItemId}@${source.version}`],
        targetLocale,
        mode: 'retranslate',
        promptVersion,
        editorialProfileVersion: profile.version,
        target: `${req.targetItemId}@${snap.target.version}`,
      }),
      mode: 'retranslate',
      targetLocale,
      collection: req.collection,
      sources: [{ kind: 'item', id: snap.sourceItemId, version: source.version, siteId: source.siteId }, ...snap.prov.map((p) => ({ kind: 'source_document', id: p.id, sourceId: p.source.id, licenceRevisionId: p.source.licenceRevisionId, licenceStatus: p.source.licenceStatus, usageMode: p.source.usageMode }))],
      promptVersion,
      editorialProfileVersion: profile.version,
      itemId: req.targetItemId,
      flowRunId: this.deps.flowRunId ?? null,
    });
    if (!fresh) return this.resultOf(row, true);
    const prod = row;
    const docIds = snap.prov.map((p) => p.id);
    try {
      await this.checkUsage(prod, docIds, 'translate', 'retranslate');
      const wanted = new Map(snap.maps.map((m) => [m.sourceKey, m]));
      const blocks = this.blocksToTranslate(source.data, source.blockFields, new Set(wanted.keys()))
        // `title` is not a mapped block.
        .filter((b) => wanted.has(b.key));
      const from = String(source.data.locale ?? 'en');
      const to = targetLocale ?? 'en';
      const out = await translateBlocks({
        siteId: this.siteId,
        from,
        to,
        blocks,
        memory: this.memory(from, to),
        glossary: await loadGlossary(this.deps.db, this.siteId, from, to, (profile.content.glossary as Array<{ term: string; preferred?: string }>) ?? []),
        service: this.translator,
        callKey: `production:${prod.id}:retranslate:a${prod.attempts}`,
        origin: { kind: 'ai_production', id: prod.id },
        capability: 'translate',
        context: `item:${snap.sourceItemId}`,
      });
      await this.step(prod, 'translate', {
        capability: out.call ? 'translate' : undefined,
        call: out.call ? { callId: out.call.callId, provider: out.call.provider, model: out.call.model } : undefined,
        detail: { memoryHits: out.memoryHits, candidates: blocks.map((b) => b.key) },
      });
      await this.checkUsage(prod, docIds, 'translate', 'draft');
      const versionKey = `ai-retranslation-${prod.id}`;
      const result = await this.tx(async (tx) => {
        // The same lock order as the target's own writes: the group, then the rows.
        await lockMembership(tx, this.siteId, req.targetItemId);
        const [target] = await tx.select({ data: items.data, version: items.version }).from(items).where(and(eq(items.siteId, this.siteId), eq(items.id, req.targetItemId))).for('update');
        const mapsNow = await tx.select().from(translationBlockMap).where(and(eq(translationBlockMap.siteId, this.siteId), eq(translationBlockMap.targetItemId, req.targetItemId)));
        const sourceNow = await blocksOfItem(tx, source.siteId, snap.sourceItemId!);
        const srcHash = new Map((sourceNow?.blocks ?? []).map((b) => [b.key, b.hash]));
        const tgtHash = new Map(
          [...snap.targetBlockFields].flatMap(([f, k]) => (k === 'html' ? htmlBlocks(f, (target!.data as Record<string, unknown>)[f]) : [])).map((b) => [b.key, b.hash]),
        );
        const written: Array<Record<string, unknown>> = [];
        const review: Array<Record<string, unknown>> = [];
        let data = { ...(target!.data as Record<string, unknown>) };
        for (const b of out.blocks) {
          const before = wanted.get(b.key)!;
          const now = mapsNow.find((m) => m.id === before.id);
          const reason = !now || !now.stale || now.staleReason !== 'changed'
            ? 'map_changed'
            : now.humanEdited
              ? 'human_edited'
              : srcHash.get(b.key) !== source.hashes.get(b.key)
                ? 'source_changed_during_run'
                : (tgtHash.get(before.targetKey) ?? (before.targetKey.endsWith('#$') ? before.targetHash : 'gone')) !== before.targetHash
                  ? 'target_changed_during_run'
                  : null;
          if (reason) {
            review.push({ targetKey: before.targetKey, sourceKey: b.key, reason });
            continue;
          }
          const [field, id] = before.targetKey.split('#') as [string, string];
          if (id === '$') data[field] = b.text;
          else data = { ...data, [field]: replaceHtmlBlock(String(data[field] ?? ''), id, withBlockId(b.text, id)) };
          written.push({ sourceKey: b.key, targetKey: before.targetKey, sourceHash: source.hashes.get(b.key), origin: b.origin });
        }
        if (written.length) {
          const [coll] = await tx.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, this.siteId), eq(collections.name, req.collection)));
          if (!coll) throw new PipelineError('NOT_FOUND', `No collection "${req.collection}".`);
          await tx.insert(contentVersions).values({
            siteId: this.siteId,
            itemId: req.targetItemId,
            collectionId: coll.id,
            key: versionKey,
            name: `AI retranslation (${written.length} blocks)`,
            data,
            hash: hashData(target!.data as Record<string, unknown>),
            createdBy: null,
          });
          await appendItemEvent(tx, {
            siteId: this.siteId,
            resource: 'content_version',
            operation: 'create',
            collection: req.collection,
            itemId: req.targetItemId,
            itemVersion: null,
            changedFields: [versionKey],
            actor: { type: 'system' },
            source: 'system',
          });
        }
        return { written, review };
      });
      const allReview = [...result.review, ...snap.contract.review.map((r) => ({ ...r }))];
      return this.resultOf(
        await this.finish(prod, {
          status: result.written.length ? 'drafted' : 'nothing_to_do',
          statusReason: result.written.length ? null : 'changed_during_run',
          contentVersionKey: result.written.length ? versionKey : null,
          blockMap: result.written,
          review: allReview,
        }),
        false,
      );
    } catch (err) {
      return this.resultOf(await this.fail(prod, err), false);
    }
  }
}

/**
 * Internal link suggestions (task 1.9): published items of **this** site only, by title words. Another site's
 * items are never returned — the query is scoped to the site (and RLS) — so there is no cross-site auto-linking.
 */
export async function recommendInternalLinks(db: Database, siteId: string, input: { text: string; limit?: number }): Promise<Array<{ itemId: string; title: string; slug: string | null }>> {
  const words = [...new Set(input.text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, 8);
  if (!words.length) return [];
  const rows = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select({ id: items.id, siteId: items.siteId, data: items.data })
      .from(items)
      .where(and(eq(items.siteId, siteId), eq(items.status, 'published'), isNull(items.deletedAt), or(...words.map((w) => ilike(sql`${items.data}->>'title'`, `%${w}%`)))))
      .orderBy(asc(items.id))
      .limit(50),
  );
  return rows
    .filter((r) => r.siteId === siteId)
    .map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      const title = String(d.title ?? '');
      return { itemId: r.id, title, slug: typeof d.slug === 'string' ? d.slug : null, score: words.filter((w) => title.toLowerCase().includes(w)).length };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 5)
    .map(({ itemId, title, slug }) => ({ itemId, title, slug }));
}

