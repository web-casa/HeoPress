import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  aiProductions,
  collections,
  constitutions,
  editorialProfileVersions,
  ingestSourceDocuments,
  ingestSources,
  items,
  qualityGateResults,
  qualityGateReviews,
  qualityGateSettings,
  siteContentSettings,
  sites,
  translationGroupMembers,
  type Database,
} from '@heopress/database';
import type { UsageOperation } from '@heopress/contracts/schemas';
import { AuditLogger } from '../../modules/audit/logger';
import type { ConstitutionEvaluator, LlmJudgeEvaluator } from '../constitution-service';
import { hashData } from '../content-version-service';
import { fetchPage } from '../ingest/fetcher';
import { assertUsageAllowed } from '../ingest/usage';
import type { LlmGateway } from '../llm/gateway';
import { DATA_NOT_INSTRUCTIONS, asData, parseModelJson, sanitizeModelText } from '../pipeline/safety';
import { runSiteTransaction, withSiteScope, type SiteTransaction } from '../rls-transaction';
import { installedPluginGateChecks, type GateCheckSubject, type GateOutcome, type PluginGateChecks, type QualityGateRunner } from '../pipeline/extension-points';
import { PLUGIN_GATE_VERDICTS, isPluginGateRule, type PluginGateVerdict } from '@heopress/contracts/extensions';
import { declaredGateChecks, type DeclaredGateCheck } from '../../extensions/pipeline/declarations';
import {
  DEFAULT_LEVELS,
  DEFAULT_THRESHOLDS,
  GATE_CHECKS,
  MANDATORY_CHECKS,
  citations,
  draftView,
  editorialRules,
  factCheck,
  hiddenContent,
  linksOf,
  literalIntegrity,
  nearDuplicate,
  plainText,
  safety,
  seoCompleteness,
  seoLengths,
  sourceRights,
  textOverlap,
  type GateCheck,
  type GateLevel,
  type GateThresholds,
  type PublishedCandidate,
  type RuleOutcome,
  type SourceView,
  type Verdict,
} from './rules';

/**
 * The quality gate (HeoPress P09 tasks 2.1, 2.2, 2.4–2.7; spec ai/quality-gate; design decision 4).
 *
 * `run` checks a production's draft with every rule (`rules.ts`), applies the site's check levels and stores the
 * result **bound** to the item version and content hash, the gate policy hash (levels, thresholds, editorial profile
 * version, the active constitution's hash — LumiBase's versioned, hashed rule DSL) and the sources' licence
 * revisions. `current` answers whether that result still applies: any change means the gate must run again before
 * publishing. A person decides `needs_review` results (`review`), for that version only; blocked results are fixed and
 * re-run, never approved. `setLevel` changes a check's level (mandatory checks always block), is audited, and re-judges
 * the stored results under the new levels.
 *
 * Model calls (an `llm_judge` constitution evaluator, the optional fact check) go through the model gateway with the
 * `constitution` / `fact_check` capabilities: ledger and site budget. Cross-site near-duplicate candidates are read in
 * each site's scope by this internal service; the evidence keeps only ids and a similarity, never another site's text.
 */

type Tx = SiteTransaction;

export class QualityGateError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'VALIDATION' | 'MANDATORY_CHECK' | 'STALE_VERSION' | 'NOT_REVIEWABLE' | 'FORBIDDEN',
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'QualityGateError';
  }
}

/** Whether a cited URL answers (through the SSRF-guarded outbound fetch in production). */
export type UrlChecker = (url: string) => Promise<{ ok: boolean; status?: number; error?: string }>;

const guardedUrlChecker: UrlChecker = async (url) => {
  try {
    const page = await fetchPage(url, { accept: /./, maxBytes: 512 * 1024, timeoutMs: 15_000, limiter: null });
    return { ok: page.status >= 200 && page.status < 400, status: page.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
};

export interface QualityGateDeps {
  db: Database;
  siteId: string;
  /** For `llm_judge` evaluators and the fact check; without it they are not run (needs review / a warning). */
  gateway?: Pick<LlmGateway, 'chat'> | null;
  urlChecker?: UrlChecker;
  now?: () => Date;
  /** Upper bounds of the cross-site candidate scan. */
  candidateLimit?: number;
  siteLimit?: number;
  /** Plugin gate checks (P12 task 4.2); default: the ones installed for the process (`setPluginGateChecks`). */
  pluginGateChecks?: PluginGateChecks | null;
}

export interface GateSettingsView {
  levels: Record<GateCheck, GateLevel>;
  thresholds: GateThresholds;
  mandatory: GateCheck[];
  version: number;
}

export interface StoredCheck {
  /** A core check, or a plugin's (`ext:<namespace>:<id>`, P12 task 4.2: always at `block`, never mandatory). */
  rule: GateCheck | `ext:${string}`;
  verdict: Verdict;
  level: GateLevel;
  mandatory: boolean;
  /** After the level: `passed` | `blocked` | `needs_review` | `warning` | `off`. */
  status: 'passed' | 'blocked' | 'needs_review' | 'warning' | 'off';
  score: number;
  evidence: Record<string, unknown>;
  suggestions: string[];
}

type ResultRow = typeof qualityGateResults.$inferSelect;

export interface GateState {
  /**
   * `missing`: never run; `stale`: the content, policy or a source licence changed since (re-run); otherwise the
   * result's status, or `approved` / `rejected` when a person decided a `needs_review` result of this version.
   */
  state: 'missing' | 'stale' | 'passed' | 'blocked' | 'needs_review' | 'approved' | 'rejected';
  /** True only for `passed` and `approved`. */
  publishable: boolean;
  staleReasons: string[];
  result: ResultRow | null;
  review: typeof qualityGateReviews.$inferSelect | null;
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * The gate policy's identity. `pluginRules` (P12 task 4.2): the plugin checks the site's plugins declare — enabling,
 * disabling or changing one makes earlier results stale. Without any the hash is the P09 one (stored results stay valid).
 */
function policyHash(
  levels: Record<string, string>,
  thresholds: Record<string, number>,
  editorialProfileVersion: number | null,
  constitutionHash: string | null,
  pluginRules: readonly DeclaredGateCheck[] = [],
): string {
  const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const plugins = pluginRules.map((p) => [p.rule, p.collections ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return sha(['gate@1', sorted(levels), sorted(thresholds), editorialProfileVersion ?? 0, constitutionHash ?? '', ...(plugins.length ? [plugins] : [])]);
}

/** The level a stored check is judged at: a plugin check always blocks (a site cannot relax it). */
const levelOf = (rule: StoredCheck['rule'], levels: Record<GateCheck, GateLevel>): GateLevel => (isPluginGateRule(rule) ? 'block' : levels[rule]);

/** A deep-frozen copy: what a plugin check reads, never the gate's own data. */
function frozenCopy<T>(v: T): T {
  const copy = structuredClone(v);
  const freeze = (o: unknown) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const k of Object.keys(o)) freeze((o as Record<string, unknown>)[k]);
    }
  };
  freeze(copy);
  return copy;
}

const MAX_PLUGIN_EVIDENCE = 8 * 1024;

/** A plugin check's answer as a stored check: anything but a known verdict needs review; evidence is plain JSON, capped. */
function pluginCheckOf(d: DeclaredGateCheck, raw: unknown, failure?: string): StoredCheck {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const given = o?.verdict;
  const known = typeof given === 'string' && (PLUGIN_GATE_VERDICTS as readonly string[]).includes(given);
  const verdict: PluginGateVerdict = failure || !known ? 'needs_review' : (given as PluginGateVerdict);
  let evidence: Record<string, unknown> = {};
  if (!failure && o?.evidence && typeof o.evidence === 'object') {
    try {
      const text = JSON.stringify(o.evidence);
      evidence = text.length <= MAX_PLUGIN_EVIDENCE ? (JSON.parse(text) as Record<string, unknown>) : { truncated: true, excerpt: text.slice(0, 1000) };
    } catch {
      evidence = { unreadable: true };
    }
  }
  const score = !failure && typeof o?.score === 'number' && Number.isFinite(o.score) ? Math.round(Math.min(100, Math.max(0, o.score))) : verdict === 'passed' ? 100 : verdict === 'needs_review' ? 50 : 0;
  const suggestions = !failure && Array.isArray(o?.suggestions) ? o!.suggestions.filter((x): x is string => typeof x === 'string').slice(0, 5).map((x) => x.slice(0, 300)) : [];
  const reason = failure ?? (known ? undefined : 'invalid_verdict');
  return {
    rule: d.rule,
    verdict,
    level: 'block',
    mandatory: false,
    status: applyLevel(verdict, 'block'),
    score,
    evidence: { ...evidence, plugin: d.plugin, check: d.checkId, ...(reason ? { reason } : {}) },
    suggestions,
  };
}

/** Run one plugin check against its time limit. */
async function runPluginCheck(d: DeclaredGateCheck, fn: ((s: Readonly<GateCheckSubject>) => unknown) | undefined, subject: Readonly<GateCheckSubject>): Promise<StoredCheck> {
  if (!fn) return pluginCheckOf(d, null, 'not_registered');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => fn(subject)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), d.timeoutMs);
      }),
    ]);
    return pluginCheckOf(d, raw);
  } catch (err) {
    return pluginCheckOf(d, null, err instanceof Error && err.message === 'timeout' ? 'timeout' : 'error');
  } finally {
    clearTimeout(timer);
  }
}

/** The status a raw verdict gets under a level. */
export function applyLevel(verdict: Verdict, level: GateLevel): StoredCheck['status'] {
  if (level === 'off') return 'off';
  if (verdict === 'passed' || verdict === 'warning') return verdict;
  return level === 'warn' ? 'warning' : verdict;
}

/** The overall status of the checks: any block blocks; else any review needs a person; else passed. */
export function overall(checks: StoredCheck[]): { status: 'passed' | 'blocked' | 'needs_review'; score: number } {
  const counted = checks.filter((c) => c.status !== 'off');
  const status = counted.some((c) => c.status === 'blocked') ? 'blocked' : counted.some((c) => c.status === 'needs_review') ? 'needs_review' : 'passed';
  const score = counted.length ? Math.round(counted.reduce((n, c) => n + c.score, 0) / counted.length) : 100;
  return { status, score };
}

function normaliseLevels(stored: Record<string, string> | undefined): Record<GateCheck, GateLevel> {
  const out = { ...DEFAULT_LEVELS };
  for (const check of GATE_CHECKS) {
    const v = stored?.[check];
    if (v === 'block' || v === 'warn' || v === 'off') out[check] = v;
    if (MANDATORY_CHECKS.has(check)) out[check] = 'block';
  }
  return out;
}

const MODE_OPERATION: Record<string, UsageOperation> = { translate: 'translate', retranslate: 'translate', rewrite: 'rewrite', write: 'extract_facts' };

export class QualityGate {
  constructor(private readonly deps: QualityGateDeps) {}

  private get siteId() {
    return this.deps.siteId;
  }
  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.siteId, fn);
  }

  // ── settings ────────────────────────────────────────────────────────

  private async settingsIn(tx: Tx): Promise<GateSettingsView> {
    const [row] = await tx.select().from(qualityGateSettings).where(eq(qualityGateSettings.siteId, this.siteId));
    return {
      levels: normaliseLevels(row?.levels),
      thresholds: { ...DEFAULT_THRESHOLDS, ...(row?.thresholds ?? {}) } as GateThresholds,
      mandatory: [...MANDATORY_CHECKS],
      version: row?.version ?? 0,
    };
  }

  async settings(): Promise<GateSettingsView> {
    return this.tx((tx) => this.settingsIn(tx));
  }

  /**
   * Set one check's level. Mandatory checks cannot be turned off or downgraded; the fact check is advisory (at most
   * `warn`). The change is audited (who, why, from, to) and the stored results are re-judged under the new levels.
   */
  async setLevel(input: { check: string; level: string; reason: string; userId: string | null }): Promise<GateSettingsView & { rejudged: number }> {
    const check = input.check as GateCheck;
    if (!GATE_CHECKS.includes(check)) throw new QualityGateError('VALIDATION', `Unknown check "${input.check}".`);
    if (input.level !== 'block' && input.level !== 'warn' && input.level !== 'off') throw new QualityGateError('VALIDATION', 'The level is block, warn or off.');
    if (!input.reason?.trim()) throw new QualityGateError('VALIDATION', 'A level change needs a reason.');
    const level = input.level as GateLevel;
    if (MANDATORY_CHECKS.has(check) && level !== 'block') throw new QualityGateError('MANDATORY_CHECK', `"${check}" is mandatory: it cannot be turned off or downgraded.`, 409);
    if (check === 'fact_check' && level === 'block') throw new QualityGateError('VALIDATION', 'The fact check is advisory: warn or off.');
    return this.tx(async (tx) => {
      const before = await this.settingsIn(tx);
      const levels = { ...before.levels, [check]: level };
      const [saved] = await tx
        .insert(qualityGateSettings)
        .values({ siteId: this.siteId, levels, thresholds: before.thresholds, version: 1, updatedBy: input.userId, updatedAt: this.now() })
        .onConflictDoUpdate({
          target: qualityGateSettings.siteId,
          set: { levels, version: before.version + 1, updatedBy: input.userId, updatedAt: this.now() },
        })
        .returning();
      await new AuditLogger({ db: tx as unknown as Database, siteId: this.siteId }).writeInTransaction(tx, {
        siteId: this.siteId,
        event: 'quality_gate_level_changed',
        metadata: { check, from: before.levels[check], to: level, reason: input.reason.trim(), by: input.userId },
      });
      const rejudged = await this.rejudge(tx, before, levels);
      return { levels, thresholds: before.thresholds, mandatory: [...MANDATORY_CHECKS], version: saved!.version, rejudged };
    });
  }

  /** Re-judge the results made under the old levels (same policy otherwise): new statuses, new policy hash. */
  private async rejudge(tx: Tx, before: GateSettingsView, levels: Record<GateCheck, GateLevel>): Promise<number> {
    const rows = await tx.select().from(qualityGateResults).where(eq(qualityGateResults.siteId, this.siteId));
    const plugins = await declaredGateChecks(tx, this.siteId);
    let n = 0;
    for (const r of rows) {
      if (r.policyHash !== policyHash(before.levels, before.thresholds, r.editorialProfileVersion, r.constitutionHash, plugins)) continue;
      const checks = (r.checks as unknown as StoredCheck[]).map((c) => ({ ...c, level: levelOf(c.rule, levels), status: applyLevel(c.verdict, levelOf(c.rule, levels)) }));
      const { status, score } = overall(checks);
      await tx
        .update(qualityGateResults)
        .set({ checks: checks as unknown as Array<Record<string, unknown>>, status, score, policyHash: policyHash(levels, before.thresholds, r.editorialProfileVersion, r.constitutionHash, plugins), updatedAt: this.now() })
        .where(and(eq(qualityGateResults.siteId, this.siteId), eq(qualityGateResults.id, r.id)));
      n++;
    }
    return n;
  }

  // ── inputs ──────────────────────────────────────────────────────────

  private async policyIn(tx: Tx) {
    const [profile] = await tx
      .select({ version: editorialProfileVersions.version, content: editorialProfileVersions.content })
      .from(editorialProfileVersions)
      .where(and(eq(editorialProfileVersions.siteId, this.siteId), eq(editorialProfileVersions.status, 'published')));
    const [constitution] = await tx
      .select({ hash: constitutions.hash, evaluators: constitutions.evaluators })
      .from(constitutions)
      .where(and(eq(constitutions.siteId, this.siteId), eq(constitutions.status, 'active')));
    return {
      profileVersion: profile?.version ?? null,
      profile: (profile?.content ?? {}) as Record<string, unknown>,
      constitutionHash: constitution?.hash ?? null,
      evaluators: (constitution?.evaluators ?? []) as ConstitutionEvaluator[],
      // The site's plugins' gate checks (P12 task 4.2): part of the policy.
      pluginChecks: await declaredGateChecks(tx, this.siteId),
    };
  }

  /** The production's sources with their **current** terms, licence revisions and content. */
  private async sourcesIn(tx: Tx, prod: typeof aiProductions.$inferSelect | null): Promise<{ views: SourceView[]; revisions: Record<string, string | null> }> {
    if (!prod) return { views: [], revisions: {} };
    const docIds = prod.sources.filter((s) => s.kind === 'source_document').map((s) => String(s.id));
    const itemIds = prod.sources.filter((s) => s.kind === 'item').map((s) => String(s.id));
    const operation = MODE_OPERATION[prod.mode] ?? 'rewrite';
    const views: SourceView[] = [];
    const revisions: Record<string, string | null> = {};
    if (docIds.length) {
      const rows = await tx
        .select({ doc: ingestSourceDocuments, source: ingestSources })
        .from(ingestSourceDocuments)
        .innerJoin(ingestSources, and(eq(ingestSources.siteId, ingestSourceDocuments.siteId), eq(ingestSources.id, ingestSourceDocuments.sourceId)))
        .where(and(eq(ingestSourceDocuments.siteId, this.siteId), inArray(ingestSourceDocuments.id, docIds)));
      for (const { doc, source } of rows) {
        const usage = assertUsageAllowed(source, operation, this.now());
        revisions[doc.id] = source.licenceRevisionId ?? null;
        views.push({
          id: doc.id,
          kind: 'source_document',
          licenceStatus: source.licenceStatus,
          usageMode: source.usageMode,
          usageAllowed: usage.allowed,
          ...(usage.allowed ? {} : { usageReason: usage.reason }),
          title: doc.title,
          url: doc.finalUrl,
          bodyHtml: doc.bodyHtml,
        });
      }
      for (const id of docIds) if (!(id in revisions)) views.push({ id, kind: 'source_document', licenceStatus: null, usageMode: null, usageAllowed: false, usageReason: 'source_gone', title: '', url: null, bodyHtml: '' });
    }
    if (itemIds.length) {
      const rows = await tx.select({ id: items.id, data: items.data }).from(items).where(and(eq(items.siteId, this.siteId), inArray(items.id, itemIds)));
      for (const r of rows) {
        const data = r.data as Record<string, unknown>;
        views.push({ id: r.id, kind: 'item', licenceStatus: 'own', usageMode: null, usageAllowed: true, title: String(data.title ?? ''), url: null, bodyHtml: typeof data.body === 'string' ? data.body : '' });
      }
    }
    return { views, revisions };
  }

  /** Published items of this site and (in each site's scope) of the others, as text plus translation group. */
  private async candidates(tx: Tx): Promise<PublishedCandidate[]> {
    const limit = this.deps.candidateLimit ?? 500;
    const readSite = async (site: string) => {
      const rows = await tx
        .select({ id: items.id, data: items.data, groupId: translationGroupMembers.groupId, memberLocale: translationGroupMembers.locale })
        .from(items)
        .leftJoin(translationGroupMembers, eq(translationGroupMembers.itemId, items.id))
        .where(and(eq(items.siteId, site), eq(items.status, 'published'), isNull(items.deletedAt)))
        .orderBy(desc(items.updatedAt))
        .limit(limit);
      return rows.map((r) => {
        const data = r.data as Record<string, unknown>;
        const text = `${String(data.title ?? '')}\n${Object.entries(data)
          .filter(([k, v]) => typeof v === 'string' && k !== 'title' && k !== 'slug' && (v as string).length > 40)
          .map(([, v]) => plainText(v as string))
          .join('\n')}`;
        return { siteId: site, itemId: r.id, locale: r.memberLocale ?? String(data.locale ?? ''), groupId: r.groupId ?? null, text };
      });
    };
    const out = await readSite(this.siteId);
    const others = await tx.select({ id: sites.id }).from(sites).limit(this.deps.siteLimit ?? 200);
    for (const s of others) {
      if (s.id === this.siteId) continue;
      out.push(...(await withSiteScope(tx, s.id, () => readSite(s.id))));
    }
    return out;
  }

  // ── model calls ─────────────────────────────────────────────────────

  private async judge(evaluators: ConstitutionEvaluator[], content: Record<string, unknown>, key: string) {
    const out: Array<{ evaluatorId: string; status: 'pass' | 'fail' | 'error'; blocking: boolean; message?: string }> = [];
    for (const e of evaluators.filter((x): x is LlmJudgeEvaluator => x.type === 'llm_judge')) {
      const blocking = e.blocking !== false;
      if (!this.deps.gateway) {
        out.push({ evaluatorId: e.id, status: 'error', blocking, message: 'no_model_gateway' });
        continue;
      }
      try {
        const res = await this.deps.gateway.chat({
          siteId: this.siteId,
          taskType: 'constitution',
          capability: 'constitution',
          origin: { kind: 'quality_gate', id: key },
          callKey: `gate:${key}:judge:${e.id}`,
          systemPrompt: `You are a content constitution judge. ${DATA_NOT_INSTRUCTIONS}\nAnswer with JSON only: {"verdict": "PASS" | "FAIL", "reason": "..."}.`,
          tools: false,
          messages: [{ role: 'user', content: asData({ rule: e.prompt, content: JSON.stringify(content).slice(0, 6000) }) }],
          maxOutputTokens: 200,
        });
        const json = parseModelJson(res.response.content);
        const verdict = String(json?.verdict ?? '').toUpperCase();
        out.push(verdict === 'PASS' ? { evaluatorId: e.id, status: 'pass', blocking } : verdict === 'FAIL' ? { evaluatorId: e.id, status: 'fail', blocking, message: sanitizeModelText(json?.reason, 300) } : { evaluatorId: e.id, status: 'error', blocking, message: 'unparseable_verdict' });
      } catch (err) {
        out.push({ evaluatorId: e.id, status: 'error', blocking, message: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      }
    }
    return out;
  }

  private async factCheck(text: string, sources: SourceView[], key: string): Promise<RuleOutcome> {
    if (!this.deps.gateway) return factCheck(null, 'no_model_gateway');
    try {
      const res = await this.deps.gateway.chat({
        siteId: this.siteId,
        taskType: 'generation',
        capability: 'fact_check',
        origin: { kind: 'quality_gate', id: key },
        callKey: `gate:${key}:fact_check`,
        systemPrompt: `You check the factual claims of an article against its sources. ${DATA_NOT_INSTRUCTIONS}\nAnswer with JSON only: {"issues": [{"claim": "...", "problem": "..."}]} (an empty list when nothing is wrong).`,
        tools: false,
        messages: [{ role: 'user', content: asData({ article: text.slice(0, 12_000), sources: sources.map((s) => ({ id: s.id, text: plainText(s.bodyHtml).slice(0, 8000) })) }) }],
        maxOutputTokens: 800,
      });
      const json = parseModelJson(res.response.content);
      if (!json || !Array.isArray(json.issues)) return factCheck(null, 'bad_answer');
      const issues = json.issues
        .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === 'object')
        .map((i) => ({ claim: sanitizeModelText(i.claim, 300), problem: sanitizeModelText(i.problem, 300) }))
        .filter((i) => i.claim)
        .slice(0, 20);
      return factCheck(issues);
    } catch (err) {
      return factCheck(null, err instanceof Error ? err.message.slice(0, 200) : String(err));
    }
  }

  // ── plugin checks (P12 task 4.2) ─────────────────────────────────────

  /** The site's plugin checks that apply to the collection, each on a frozen copy of the draft. */
  private async pluginChecks(declared: DeclaredGateCheck[], subject: GateCheckSubject): Promise<StoredCheck[]> {
    const applicable = declared.filter((d) => !d.collections || d.collections.includes(subject.collection));
    if (!applicable.length) return [];
    const provider = this.deps.pluginGateChecks === undefined ? installedPluginGateChecks() : this.deps.pluginGateChecks;
    let registered: ReadonlyMap<string, (s: Readonly<GateCheckSubject>) => unknown> = new Map();
    try {
      if (provider) registered = await provider(this.siteId);
    } catch (err) {
      console.error('[quality-gate] plugin checks could not be loaded', err instanceof Error ? err.message : String(err));
    }
    const view = frozenCopy(subject);
    const out: StoredCheck[] = [];
    for (const d of applicable) out.push(await runPluginCheck(d, registered.get(d.rule), view));
    return out;
  }

  // ── run ─────────────────────────────────────────────────────────────

  /** Run every check on a production's draft and store the result bound to what it checked. */
  async run(req: { productionId: string }): Promise<GateOutcome & { resultId: string; score: number }> {
    const loaded = await this.tx(async (tx) => {
      const [prod] = await tx.select().from(aiProductions).where(and(eq(aiProductions.siteId, this.siteId), eq(aiProductions.id, req.productionId)));
      if (!prod?.itemId) throw new QualityGateError('NOT_FOUND', 'The production has no draft.', 404);
      const [item] = await tx
        .select({ id: items.id, data: items.data, version: items.version, collection: collections.name })
        .from(items)
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .where(and(eq(items.siteId, this.siteId), eq(items.id, prod.itemId)));
      if (!item) throw new QualityGateError('NOT_FOUND', 'The draft item is gone.', 404);
      const [member] = await tx.select({ groupId: translationGroupMembers.groupId }).from(translationGroupMembers).where(eq(translationGroupMembers.itemId, item.id));
      const [content] = await tx.select({ locales: siteContentSettings.availableLocales }).from(siteContentSettings).where(eq(siteContentSettings.siteId, this.siteId));
      return {
        prod,
        item,
        groupId: member?.groupId ?? null,
        locales: content?.locales ?? [],
        settings: await this.settingsIn(tx),
        policy: await this.policyIn(tx),
        sources: await this.sourcesIn(tx, prod),
        candidates: await this.candidates(tx),
      };
    });
    const { prod, item, settings, policy } = loaded;
    const data = item.data as Record<string, unknown>;
    const draft = draftView(data, typeof data.body === 'string' ? 'body' : (Object.keys(data).find((k) => typeof data[k] === 'string' && /<[a-z]/i.test(data[k] as string)) ?? 'body'));
    const key = `${prod.id}:v${item.version}`;
    const sources = loaded.sources.views;

    const reach = new Map<string, { ok: boolean; status?: number; error?: string }>();
    if (settings.levels.citations !== 'off') {
      const { cited, all } = linksOf(draft.bodyHtml);
      const check = this.deps.urlChecker ?? guardedUrlChecker;
      for (const u of (cited.length ? cited : all).slice(0, 20)) reach.set(u, await check(u));
    }
    const outcomes: RuleOutcome[] = [
      sourceRights(sources),
      nearDuplicate({ siteId: this.siteId, itemId: item.id, locale: draft.locale, groupId: loaded.groupId, text: `${draft.title}\n${plainText(draft.bodyHtml)}` }, loaded.candidates, settings.thresholds.near_duplicate),
      citations(prod.mode, draft.bodyHtml, reach),
      editorialRules(
        draft,
        {
          version: policy.profileVersion,
          forbiddenTopics: Array.isArray(policy.profile.forbiddenTopics) ? (policy.profile.forbiddenTopics as string[]) : [],
          glossary: Array.isArray(policy.profile.glossary) ? (policy.profile.glossary as Array<{ term: string; preferred?: string; avoid?: string[] }>) : [],
        },
        {
          hash: policy.constitutionHash,
          evaluators: policy.evaluators,
          judged: settings.levels.editorial_rules === 'off' ? [] : await this.judge(policy.evaluators, { ...draft.fields }, key),
        },
      ),
      safety(draft),
      seoCompleteness(draft, loaded.locales),
      seoLengths(draft),
      literalIntegrity(prod.mode, sources, draft),
      textOverlap(sources, draft, settings.thresholds.text_overlap),
      hiddenContent(draft),
      settings.levels.fact_check === 'off' ? factCheck([]) : await this.factCheck(`${draft.title}\n${plainText(draft.bodyHtml)}`, sources, key),
    ];
    const checks: StoredCheck[] = outcomes.map((o) => ({
      ...o,
      level: settings.levels[o.rule],
      mandatory: MANDATORY_CHECKS.has(o.rule),
      status: applyLevel(o.verdict, settings.levels[o.rule]),
    }));
    // Plugin checks (P12 task 4.2) come after every core check and are only added: a plugin's `passed` never lifts a
    // core block or review, and no core check can be skipped by one.
    checks.push(
      ...(await this.pluginChecks(policy.pluginChecks, {
        siteId: this.siteId,
        collection: item.collection,
        itemId: item.id,
        itemVersion: item.version,
        mode: prod.mode,
        locale: draft.locale || null,
        title: draft.title,
        bodyHtml: draft.bodyHtml,
        fields: { ...draft.fields },
        sources: sources.map((v) => ({ id: v.id, kind: v.kind, url: v.url, licenceStatus: v.licenceStatus, usageMode: v.usageMode })),
      })),
    );
    const { status, score } = overall(checks);
    const [row] = await this.tx((tx) =>
      tx
        .insert(qualityGateResults)
        .values({
          siteId: this.siteId,
          productionId: prod.id,
          collection: item.collection,
          itemId: item.id,
          itemVersion: item.version,
          contentHash: hashData(data),
          policyHash: policyHash(settings.levels, settings.thresholds, policy.profileVersion, policy.constitutionHash, policy.pluginChecks),
          editorialProfileVersion: policy.profileVersion,
          constitutionHash: policy.constitutionHash,
          licenceRevisions: loaded.sources.revisions,
          status,
          score,
          checks: checks as unknown as Array<Record<string, unknown>>,
        })
        .returning(),
    );
    return {
      resultId: row!.id,
      status,
      score,
      itemVersion: item.version,
      checks: checks.flatMap((c) => (c.status === 'off' ? [] : [{ rule: c.rule, status: c.status, score: c.score, evidence: c.evidence }])),
    };
  }

  /**
   * The gate's rules on an unsaved draft (the prompt workbench, HeoPress P09 task 4.1): nothing is stored, no model is
   * called (constitution judges and the fact check are reported as not run), cited URLs are not fetched. `policy`
   * replaces the site's editorial profile (the editor's unsaved one).
   */
  async diagnose(input: {
    mode: 'translate' | 'rewrite' | 'write';
    data: Record<string, unknown>;
    sourceDocumentIds: string[];
    policy?: { forbiddenTopics?: string[]; glossary?: Array<{ term: string; preferred?: string; avoid?: string[] }> } | null;
  }): Promise<{ status: 'passed' | 'blocked' | 'needs_review'; score: number; checks: StoredCheck[]; notRun: string[] }> {
    const loaded = await this.tx(async (tx) => {
      const [content] = await tx.select({ locales: siteContentSettings.availableLocales }).from(siteContentSettings).where(eq(siteContentSettings.siteId, this.siteId));
      const pseudo = { mode: input.mode, sources: input.sourceDocumentIds.map((id) => ({ kind: 'source_document', id })) } as unknown as typeof aiProductions.$inferSelect;
      return {
        locales: content?.locales ?? [],
        settings: await this.settingsIn(tx),
        policy: await this.policyIn(tx),
        sources: await this.sourcesIn(tx, pseudo),
        candidates: await this.candidates(tx),
      };
    });
    const { settings, policy } = loaded;
    const draft = draftView(input.data, 'body');
    const sources = loaded.sources.views;
    const profile = input.policy ?? policy.profile;
    const outcomes: RuleOutcome[] = [
      sourceRights(sources),
      nearDuplicate({ siteId: this.siteId, itemId: '__workbench__', locale: draft.locale, groupId: null, text: `${draft.title}\n${plainText(draft.bodyHtml)}` }, loaded.candidates, settings.thresholds.near_duplicate),
      citations(input.mode, draft.bodyHtml, new Map()),
      editorialRules(
        draft,
        {
          version: policy.profileVersion,
          forbiddenTopics: Array.isArray(profile.forbiddenTopics) ? (profile.forbiddenTopics as string[]) : [],
          glossary: Array.isArray(profile.glossary) ? (profile.glossary as Array<{ term: string; preferred?: string; avoid?: string[] }>) : [],
        },
        { hash: policy.constitutionHash, evaluators: [], judged: [] },
      ),
      safety(draft),
      seoCompleteness(draft, loaded.locales),
      seoLengths(draft),
      literalIntegrity(input.mode, sources, draft),
      textOverlap(sources, draft, settings.thresholds.text_overlap),
      hiddenContent(draft),
    ];
    const checks: StoredCheck[] = outcomes.map((o) => ({ ...o, level: settings.levels[o.rule], mandatory: MANDATORY_CHECKS.has(o.rule), status: applyLevel(o.verdict, settings.levels[o.rule]) }));
    const notRun = [...(policy.evaluators.some((e) => e.type === 'llm_judge') ? ['constitution_judges'] : []), ...(settings.levels.fact_check === 'off' ? [] : ['fact_check']), 'citation_reachability'];
    return { ...overall(checks), checks, notRun };
  }

  // ── validity and review ─────────────────────────────────────────────

  /** The latest result for an item and whether it still applies (task 2.2). */
  async current(itemId: string): Promise<GateState> {
    return this.tx((tx) => this.currentIn(tx, itemId));
  }

  /** As `current`, inside a caller's transaction (the final publish re-check runs it with its own locks). */
  async currentIn(tx: Tx, itemId: string): Promise<GateState> {
    const [result] = await tx
      .select()
      .from(qualityGateResults)
      .where(and(eq(qualityGateResults.siteId, this.siteId), eq(qualityGateResults.itemId, itemId)))
      .orderBy(desc(qualityGateResults.createdAt))
      .limit(1);
    if (!result) return { state: 'missing', publishable: false, staleReasons: [], result: null, review: null };
    const reasons: string[] = [];
    const [item] = await tx.select({ data: items.data, version: items.version }).from(items).where(and(eq(items.siteId, this.siteId), eq(items.id, itemId)));
    if (!item) reasons.push('item_gone');
    else {
      if (item.version !== result.itemVersion) reasons.push('item_version_changed');
      if (hashData(item.data as Record<string, unknown>) !== result.contentHash) reasons.push('content_changed');
    }
    const settings = await this.settingsIn(tx);
    const policy = await this.policyIn(tx);
    if (policyHash(settings.levels, settings.thresholds, policy.profileVersion, policy.constitutionHash, policy.pluginChecks) !== result.policyHash) reasons.push('policy_changed');
    const ids = Object.keys(result.licenceRevisions);
    if (ids.length) {
      const rows = await tx
        .select({ id: ingestSourceDocuments.id, revision: ingestSources.licenceRevisionId })
        .from(ingestSourceDocuments)
        .innerJoin(ingestSources, and(eq(ingestSources.siteId, ingestSourceDocuments.siteId), eq(ingestSources.id, ingestSourceDocuments.sourceId)))
        .where(and(eq(ingestSourceDocuments.siteId, this.siteId), inArray(ingestSourceDocuments.id, ids)));
      const now = new Map(rows.map((r) => [r.id, r.revision ?? null]));
      if (ids.some((id) => !now.has(id) || now.get(id) !== result.licenceRevisions[id])) reasons.push('licence_changed');
    }
    const [review] = await tx
      .select()
      .from(qualityGateReviews)
      .where(and(eq(qualityGateReviews.siteId, this.siteId), eq(qualityGateReviews.resultId, result.id)))
      .orderBy(desc(qualityGateReviews.createdAt))
      .limit(1);
    if (reasons.length) return { state: 'stale', publishable: false, staleReasons: reasons, result, review: review ?? null };
    if (result.status === 'needs_review' && review && review.itemVersion === result.itemVersion && review.contentHash === result.contentHash) {
      const state = review.decision === 'approve' ? 'approved' : 'rejected';
      return { state, publishable: state === 'approved', staleReasons: [], result, review };
    }
    const state = result.status as 'passed' | 'blocked' | 'needs_review';
    return { state, publishable: state === 'passed', staleReasons: [], result, review: review ?? null };
  }

  /**
   * A person's decision on a `needs_review` result, for the version it checked. A blocked result (a safety block
   * above all) is not reviewable: fix and re-run. A stale result is not reviewable either.
   */
  async review(input: { resultId: string; decision: 'approve' | 'reject'; reason: string; reviewerId: string | null; itemVersion: number }): Promise<GateState> {
    const reviewerId = input.reviewerId;
    if (!reviewerId) throw new QualityGateError('FORBIDDEN', 'Only a signed-in person can review a gate result.', 403);
    if (input.decision !== 'approve' && input.decision !== 'reject') throw new QualityGateError('VALIDATION', 'The decision is approve or reject.');
    if (!input.reason?.trim()) throw new QualityGateError('VALIDATION', 'A review needs a reason.');
    return this.tx(async (tx) => {
      const [result] = await tx.select().from(qualityGateResults).where(and(eq(qualityGateResults.siteId, this.siteId), eq(qualityGateResults.id, input.resultId)));
      if (!result) throw new QualityGateError('NOT_FOUND', 'No such gate result.', 404);
      const state = await this.currentIn(tx, result.itemId);
      if (state.result?.id !== result.id || state.state === 'stale') throw new QualityGateError('STALE_VERSION', 'The content or policy changed since this result: run the gate again.', 409);
      if (input.itemVersion !== result.itemVersion) throw new QualityGateError('STALE_VERSION', 'The review names another version than the result checked.', 409);
      if (result.status !== 'needs_review') {
        throw new QualityGateError('NOT_REVIEWABLE', result.status === 'blocked' ? 'A blocked result is fixed and re-run, never approved.' : 'Only results that need review are reviewed.', 409);
      }
      await tx.insert(qualityGateReviews).values({
        siteId: this.siteId,
        resultId: result.id,
        itemId: result.itemId,
        itemVersion: result.itemVersion,
        contentHash: result.contentHash,
        decision: input.decision,
        reason: input.reason.trim(),
        reviewerId,
      });
      await new AuditLogger({ db: tx as unknown as Database, siteId: this.siteId }).writeInTransaction(tx, {
        siteId: this.siteId,
        event: 'quality_gate_reviewed',
        metadata: { resultId: result.id, itemId: result.itemId, itemVersion: result.itemVersion, decision: input.decision, by: input.reviewerId },
      });
      return this.currentIn(tx, result.itemId);
    });
  }

  /** The results of a production, newest first. */
  async resultsOf(productionId: string): Promise<ResultRow[]> {
    return this.tx((tx) =>
      tx
        .select()
        .from(qualityGateResults)
        .where(and(eq(qualityGateResults.siteId, this.siteId), eq(qualityGateResults.productionId, productionId)))
        .orderBy(desc(qualityGateResults.createdAt)),
    );
  }
}

/** The gate as the pipeline's `run gate` extension point (task 1.1). */
export function qualityGateRunnerFor(deps: Omit<QualityGateDeps, 'siteId'>): QualityGateRunner {
  return {
    async run(req) {
      const out = await new QualityGate({ ...deps, siteId: req.siteId }).run({ productionId: req.productionId });
      return out;
    },
  };
}

/**
 * Evidence for a caller: a cross-site near-duplicate match names the other site and item only when `canReadSite`
 * says the caller has rights there now; otherwise it is the anonymous flag `duplicateElsewhere`.
 */
export async function redactEvidence(checks: StoredCheck[], siteId: string, canReadSite: (otherSiteId: string) => Promise<boolean>): Promise<StoredCheck[]> {
  const out: StoredCheck[] = [];
  for (const c of checks) {
    const match = c.rule === 'near_duplicate' ? (c.evidence.match as { scope?: string; siteId?: string; similarity?: number } | undefined) : undefined;
    if (match && match.scope === 'cross_site' && match.siteId !== siteId && !(await canReadSite(String(match.siteId)))) {
      out.push({ ...c, evidence: { ...c.evidence, match: { scope: 'cross_site', duplicateElsewhere: true, similarity: match.similarity } } });
    } else out.push(c);
  }
  return out;
}
