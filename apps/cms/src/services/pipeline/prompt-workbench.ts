import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { UsageOperation } from '@heopress/contracts/schemas';
import { ingestSourceDocuments, ingestSources, llmAttempts, type Database } from '@heopress/database';
import { assertUsageAllowed } from '../ingest/usage';
import type { LlmGateway } from '../llm/gateway';
import { QualityGate, type StoredCheck } from '../quality-gate/quality-gate';
import { runSiteTransaction } from '../rls-transaction';
import { DATA_NOT_INSTRUCTIONS, asData, keepOnlyLinks, parseModelJson, sanitizeModelHtml, sanitizeModelText } from './safety';

/**
 * The prompt workbench (HeoPress P09 task 4.1; spec ai/prompt-workbench). An editor tries an **unsaved** prompt and
 * editorial policy on a sample source document: one model call through the gateway with the `workbench_trial`
 * capability (ledger and site budget, like every AI call), the output streamed back, then the gate's rules on it
 * (`QualityGate.diagnose`: nothing stored) and each paragraph located in the source. No production, draft, item or
 * gate result is written — only the ledger rows of the call.
 */

type TrialMode = 'translate' | 'rewrite' | 'write';

export interface TrialRequest {
  sourceDocumentId: string;
  mode: TrialMode;
  targetLocale: string;
  /** The unsaved prompt: the task instructions (the data-not-instructions rule and the answer format are added). */
  prompt: string;
  /** The unsaved editorial policy (forbidden topics, glossary, tone, …). */
  editorialPolicy: Record<string, unknown>;
}

export type TrialEvent =
  | { type: 'stage'; stage: 'source' | 'model' | 'diagnostics' }
  | { type: 'output'; index: number; html: string; title?: string }
  | { type: 'diagnostics'; status: string; score: number; checks: StoredCheck[]; notRun: string[]; paragraphs: ParagraphDiagnostic[] }
  | { type: 'usage'; callId: string; provider: string; model: string; inputTokens: number | null; outputTokens: number | null; costMicros: number }
  | { type: 'done'; trialId: string }
  | { type: 'error'; code: string; message: string };

export interface ParagraphDiagnostic {
  index: number;
  text: string;
  cited: boolean;
  /** The source passage the paragraph most likely comes from (null when nothing overlaps). */
  source: { paragraph: number; text: string; similarity: number } | null;
}

export class WorkbenchError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'USAGE_REFUSED' | 'BAD_OUTPUT', message: string, readonly status: 404 | 409 | 502 = 409) {
    super(message);
    this.name = 'WorkbenchError';
  }
}

const OPERATION: Record<TrialMode, UsageOperation> = { translate: 'translate', rewrite: 'rewrite', write: 'extract_facts' };

const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Block-level paragraphs of an HTML fragment (outer HTML), headings and list items included. */
function blocksOf(html: string): string[] {
  const out = [...String(html ?? '').matchAll(/<(p|li|blockquote|h[1-6])\b[^>]*>[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return out.length ? out : strip(html) ? [`<p>${strip(html)}</p>`] : [];
}

/** Words (Latin) and character pairs (CJK): enough to match a paragraph to its source. */
function tokensOf(text: string): Set<string> {
  const lower = text.toLowerCase();
  const words = (lower.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !/[぀-ヿ㐀-鿿]/u.test(w) && w.length >= 3);
  const cjk = (lower.match(/[぀-ヿ㐀-鿿]+/gu) ?? []).flatMap((run) => (run.length < 2 ? [run] : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2))));
  return new Set([...words, ...cjk]);
}

/**
 * Each output paragraph: whether it cites (a link or a `[source id]` marker) and the source paragraph sharing most of
 * its words. In rewrite and write modes an uncited paragraph is what the editor fixes; the passage shows where from.
 */
export function locateParagraphs(outputHtml: string, sources: Array<{ id: string; bodyHtml: string }>): ParagraphDiagnostic[] {
  const sourceParas = sources.flatMap((s) => blocksOf(s.bodyHtml).map((h) => strip(h))).filter(Boolean);
  const sourceTokens = sourceParas.map(tokensOf);
  const ids = sources.map((s) => s.id);
  return blocksOf(outputHtml)
    .filter((h) => !/^<h[1-6]/i.test(h))
    .map((html, index) => {
      const text = strip(html);
      const cited = /<a\s[^>]*href=/i.test(html) || ids.some((id) => text.includes(`[${id}]`)) || /\[\d{1,2}\]/.test(text);
      const mine = tokensOf(text);
      let best: ParagraphDiagnostic['source'] = null;
      sourceTokens.forEach((st, i) => {
        if (!mine.size || !st.size) return;
        let shared = 0;
        for (const t of mine) if (st.has(t)) shared++;
        const similarity = Math.round((shared / mine.size) * 100) / 100;
        if (similarity > 0 && (!best || similarity > best.similarity)) best = { paragraph: i, text: sourceParas[i]!.slice(0, 600), similarity };
      });
      return { index, text: text.slice(0, 600), cited, source: best };
    });
}

export class PromptWorkbench {
  constructor(private readonly deps: { db: Database; siteId: string; gateway: Pick<LlmGateway, 'chat'>; now?: () => Date }) {}

  private async costOf(callId: string): Promise<number> {
    const [row] = await runSiteTransaction(this.deps.db, this.deps.siteId, (tx) =>
      tx
        .select({
          total: sql<string>`COALESCE(SUM(CASE WHEN ${llmAttempts.billing} = 'settled' THEN ${llmAttempts.actualMicros} WHEN ${llmAttempts.billing} IN ('reserved', 'unknown') THEN ${llmAttempts.reservedMicros} ELSE 0 END), 0)::text`,
        })
        .from(llmAttempts)
        .where(and(eq(llmAttempts.siteId, this.deps.siteId), eq(llmAttempts.callId, callId))),
    );
    return Number(row?.total ?? 0);
  }

  /** Run one trial, reporting each step through `emit`. Errors are thrown (the route turns them into an `error` event). */
  async trial(req: TrialRequest, emit: (e: TrialEvent) => Promise<void> | void, signal?: AbortSignal): Promise<void> {
    const trialId = randomUUID();
    await emit({ type: 'stage', stage: 'source' });
    const [row] = await runSiteTransaction(this.deps.db, this.deps.siteId, (tx) =>
      tx
        .select({ doc: ingestSourceDocuments, source: ingestSources })
        .from(ingestSourceDocuments)
        .innerJoin(ingestSources, and(eq(ingestSources.siteId, ingestSourceDocuments.siteId), eq(ingestSources.id, ingestSourceDocuments.sourceId)))
        .where(and(eq(ingestSourceDocuments.siteId, this.deps.siteId), eq(ingestSourceDocuments.id, req.sourceDocumentId))),
    );
    if (!row) throw new WorkbenchError('NOT_FOUND', 'The source document does not exist on this site.', 404);
    const usage = assertUsageAllowed(row.source, OPERATION[req.mode], this.deps.now?.() ?? new Date());
    if (!usage.allowed) throw new WorkbenchError('USAGE_REFUSED', `The source's current terms do not allow ${req.mode} (${usage.reason}).`, 409);

    await emit({ type: 'stage', stage: 'model' });
    const result = await this.deps.gateway.chat({
      siteId: this.deps.siteId,
      taskType: 'generation',
      capability: 'workbench_trial',
      origin: { kind: 'prompt_workbench', id: trialId },
      callKey: `workbench:${trialId}`,
      systemPrompt: `${req.prompt.trim()}
${DATA_NOT_INSTRUCTIONS}
Write in the language targetLocale. Follow the editorial policy.
Answer with JSON only: {"title": "...", "summary": "...", "bodyHtml": "<p>...</p>...", "citations": ["<source id>", ...]}.`,
      tools: false,
      messages: [
        {
          role: 'user',
          content: asData({
            targetLocale: req.targetLocale,
            mode: req.mode,
            editorialPolicy: req.editorialPolicy,
            sources: [{ id: row.doc.id, title: row.doc.title, url: row.doc.finalUrl, attribution: row.source.attribution, text: row.doc.bodyText.slice(0, 20_000) }],
          }),
        },
      ],
      maxOutputTokens: 4000,
      signal,
    });
    const json = parseModelJson(result.response.content);
    const rawBody = typeof json?.bodyHtml === 'string' ? json.bodyHtml : typeof result.response.content === 'string' && !json ? `<p>${sanitizeModelText(result.response.content, 20_000)}</p>` : '';
    if (!rawBody) throw new WorkbenchError('BAD_OUTPUT', 'The model answer is not the expected JSON.', 502);
    const title = sanitizeModelText(json?.title, 300);
    const summary = sanitizeModelText(json?.summary, 1000);
    const bodyHtml = keepOnlyLinks(sanitizeModelHtml(rawBody), [row.doc.finalUrl, row.doc.url]);
    const blocks = blocksOf(bodyHtml);
    for (const [index, html] of blocks.entries()) await emit({ type: 'output', index, html, ...(index === 0 ? { title } : {}) });
    await emit({
      type: 'usage',
      callId: result.callId,
      provider: result.provider,
      model: result.model,
      inputTokens: result.response.usage?.inputTokens ?? null,
      outputTokens: result.response.usage?.outputTokens ?? null,
      costMicros: await this.costOf(result.callId),
    });

    await emit({ type: 'stage', stage: 'diagnostics' });
    const policy = req.editorialPolicy as { forbiddenTopics?: string[]; glossary?: Array<{ term: string; preferred?: string; avoid?: string[] }> };
    const gate = await new QualityGate({ db: this.deps.db, siteId: this.deps.siteId }).diagnose({
      mode: req.mode,
      data: { title, summary, seo_description: summary, locale: req.targetLocale, body: bodyHtml },
      sourceDocumentIds: [row.doc.id],
      policy,
    });
    const paragraphs = locateParagraphs(bodyHtml, [{ id: row.doc.id, bodyHtml: row.doc.bodyHtml }]).map((p) => (req.mode === 'translate' ? { ...p, cited: true } : p));
    await emit({ type: 'diagnostics', ...gate, paragraphs });
    await emit({ type: 'done', trialId });
  }
}
