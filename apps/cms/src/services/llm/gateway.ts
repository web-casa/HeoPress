import { hostname } from 'node:os';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { AI_CAPABILITY_TASK_TYPES, LLM_TASK_REQUIREMENTS, type AiCapability, type LlmTaskType } from '@heopress/contracts/schemas';
import { llmAttempts, llmCalls, llmProviders, llmRoutes, type Database } from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import { outboundBlockOf } from '@heopress/runtime/node';
import { nanoid } from 'nanoid';
import { openSecret } from '../crypto/secret-vault';
import {
  AnthropicProvider,
  GeminiProvider,
  ProviderHttpError,
  copilotSystemPrompt,
  copilotTools,
  type LLMChatOptions,
  type LLMMessage,
  type LLMProvider,
  type LLMResponse,
} from '../llm-provider';
import { runSiteTransaction } from '../rls-transaction';
import {
  LedgerRefusal,
  admit,
  digest,
  endAttempt,
  estimateTokens,
  failCall,
  insertAttempt,
  lastAttempt,
  lateUsage,
  lockLedger,
  periodOf,
  recoverAttempt,
  reservationOf,
  siteBudget,
  type AttemptRow,
  type Candidate,
  type CallRow,
  type EndKind,
  type Evidence,
  type Tx,
} from './ledger';
import { LlmGatewayError } from './gateway-error';
import { LlmDeferredError, serviceKey, sharedGovernor, type ModelCallGovernor } from './governance';
import { pauseForBudget } from './pipeline-control';
import { dailyBudgetOf, dailyCommittedMicros, nextDayStart } from './daily';
import { judgeProbe, probeRequests, sendChat, sendEmbedding, type ChatOutcome } from './openai-compatible';

type ProbeVerdict = ReturnType<typeof judgeProbe>;

/**
 * The model gateway (HeoPress P04 tasks 7.2–7.4; design "模型提供方实施方案").
 * Every model call of every AI capability goes through here: it resolves
 * the candidate chain (the task type's list → the site's default list →
 * the instance default), records each network attempt in the ledger before
 * sending it, fails over along the frozen chain, and returns the answer
 * with the provider and model actually used.
 *
 * The call/attempt state machine lives in `ledger.ts`; this module drives
 * it: T1 (create + first reservation), the send guard, T2/T4/T5 (end),
 * T6a/T6b (end the call or admit the next candidate), and the executor's
 * own T7 + T8 when its lease ran out. T7/T7b for others: `recovery.ts`.
 *
 * Leases: an attempt's lease covers its request (timeout + grace); the
 * call's lease is renewed with it, so a vanished executor's call can be
 * taken over soon after its attempt — not only after the whole deadline.
 */

const OWNER_ID = `${hostname()}:${process.pid}:${nanoid(8)}`;
/** Past a lease's end, how long before anyone else may recover it (≥ the send guard's safety margin). */
export const RECOVERY_GRACE_MS = 10_000;
/** The send guard aborts this long before the local lease end. */
const SAFETY_MS = 2_000;
const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export { LlmGatewayError };

/** The instance's own model configuration (environment), as used by the gateway. */
interface InstanceLlmEnv {
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  NVIDIA_BASE_URL?: string;
  /** Price per million tokens in currency units (decimal), e.g. `0.27`. */
  LLM_PRICE_INPUT_PER_1M?: string;
  LLM_PRICE_OUTPUT_PER_1M?: string;
  LLM_PRICE_CURRENCY?: string;
}

type ToolDefinition = ReturnType<typeof copilotTools>[number];

export interface GatewayDeps {
  db: Database;
  keys: KeyProvider;
  env: InstanceLlmEnv;
  /** Test seam: the HTTP fetch behind the OpenAI-compatible client. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Test seams: the recovery grace period, the tool definitions, and points between transitions. */
  graceMs?: number;
  tools?: () => ToolDefinition[];
  /** Model-call governance (rate limit, breaker); default: the process's shared governor (HeoPress P09 task 4.5). */
  governor?: ModelCallGovernor;
  /** Test seam: the clock for budget periods and days. */
  now?: () => Date;
  hooks?: {
    /** After a reservation is committed, before the send guard. */
    afterReserve?: (attempt: AttemptRow) => Promise<void>;
    /** After an attempt ended transferably, before the next candidate is admitted. */
    afterTransferableEnd?: (attempt: AttemptRow) => Promise<void>;
  };
}

export interface ChatCallInput {
  siteId: string;
  taskType: LlmTaskType;
  /** The AI capability making the call (ledger, budget coverage); default: from the task type. */
  capability?: AiCapability;
  origin: { kind: string; id?: string };
  /** A persistent identity for replay (`run:<id>:step:<id>:call:<n>`); a fresh one when absent. */
  callKey?: string;
  messages: LLMMessage[];
  /** As `LLMChatOptions`: the instructions, and whether the Copilot tools are offered. */
  systemPrompt?: string;
  tools?: boolean;
  maxOutputTokens?: number;
  /** The whole call, every attempt included. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface ChatCallResult {
  response: LLMResponse;
  provider: string;
  model: string;
  callId: string;
  /** Every attempt of the call, in order (replays included). */
  attemptIds: string[];
}

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  claude: 'claude-sonnet-4-20250514',
  gemini: 'gemini-3.5-flash',
  nvidia: 'meta/llama-3.1-8b-instruct',
};

/** Decimal currency units → micro-units, or null when not a non-negative number. */
function microsOf(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000) : null;
}

/** The instance default candidate, or null when none is configured; `unpriced` when it has no price. */
function instanceDefault(env: InstanceLlmEnv, instanceCurrency: string): { candidate: Candidate; unpriced: boolean } | null {
  const name = env.LLM_PROVIDER;
  if (!name || name === 'echo') return null;
  const key =
    name === 'openai' ? env.OPENAI_API_KEY : name === 'anthropic' || name === 'claude' ? env.ANTHROPIC_API_KEY : name === 'gemini' ? env.GEMINI_API_KEY : name === 'nvidia' ? env.NVIDIA_API_KEY : undefined;
  if (!key) return null;
  const protocol = name === 'claude' ? 'anthropic' : name;
  const inputMicros = microsOf(env.LLM_PRICE_INPUT_PER_1M);
  const outputMicros = microsOf(env.LLM_PRICE_OUTPUT_PER_1M);
  const model = env.LLM_MODEL ?? DEFAULT_MODELS[name] ?? 'default';
  const baseUrl = protocol === 'openai' ? 'https://api.openai.com/v1' : protocol === 'nvidia' ? (env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1') : null;
  return {
    unpriced: inputMicros === null || outputMicros === null,
    candidate: {
      source: 'instance',
      instanceRef: 'llm-default',
      name: `Instance default (${name})`,
      protocol,
      baseUrl,
      model,
      pricing: { kind: 'per_1m_tokens', inputMicros: inputMicros ?? 0, outputMicros: outputMicros ?? 0 },
      currency: (env.LLM_PRICE_CURRENCY ?? instanceCurrency).toUpperCase(),
      timeoutMs: 60_000,
      // The native protocols all support tool calls and JSON output.
      capabilities: { tools: true, json: true, maxContext: null },
      fingerprint: digest({ protocol, model, baseUrl }),
    },
  };
}

/**
 * An instance service priced per request (the decision service): its
 * candidate, or PRICE_NOT_CONFIGURED when its price is not set.
 */
export function instanceServiceCandidate(opts: {
  ref: string;
  name: string;
  protocol: string;
  baseUrl: string;
  model: string;
  /** Decimal currency units per request. */
  price: string | undefined;
  priceVariable: string;
  currency: string | undefined;
  timeoutMs: number;
}): Candidate {
  const requestMicros = microsOf(opts.price);
  if (requestMicros === null) throw new LlmGatewayError('PRICE_NOT_CONFIGURED', `Set ${opts.priceVariable} for the ${opts.name} service.`);
  return {
    source: 'instance',
    instanceRef: opts.ref,
    name: opts.name,
    protocol: opts.protocol,
    baseUrl: opts.baseUrl,
    model: opts.model,
    pricing: { kind: 'per_request', requestMicros },
    currency: (opts.currency ?? 'USD').trim().toUpperCase(),
    timeoutMs: opts.timeoutMs,
    capabilities: { tools: false, json: true, maxContext: null },
    fingerprint: digest({ protocol: opts.protocol, baseUrl: opts.baseUrl, model: opts.model }),
  };
}

type ProviderRow = typeof llmProviders.$inferSelect;

/** The capability recorded for a call that does not name one: its task type's own (HeoPress P09 task 4.7). */
function capabilityOf(taskType: string): AiCapability {
  if (taskType === 'embedding') return 'ingest_embedding';
  if (taskType === 'translation') return 'translate';
  return (taskType in AI_CAPABILITY_TASK_TYPES ? taskType : 'generation') as AiCapability;
}

function siteCandidate(row: ProviderRow): Candidate {
  const pricing: Candidate['pricing'] =
    row.pricingKind === 'per_request'
      ? { kind: 'per_request', requestMicros: row.requestPriceMicros! }
      : { kind: 'per_1m_tokens', inputMicros: row.inputPriceMicros!, outputMicros: row.outputPriceMicros! };
  return {
    source: 'site',
    providerId: row.id,
    name: row.name,
    protocol: row.kind,
    baseUrl: row.baseUrl,
    model: row.model,
    pricing,
    currency: row.currency,
    timeoutMs: row.timeoutMs,
    capabilities: row.capabilities as Candidate['capabilities'],
    fingerprint: digest({ protocol: row.kind, baseUrl: row.baseUrl, model: row.model }),
  };
}

/** A ledger call's task type: a configured one, or the capability probe (which needs nothing: it finds out). */
type CallTaskType = LlmTaskType | 'probe';

/** What a call needs from a candidate's current capabilities. */
function missingFor(caps: Candidate['capabilities'], needsTools: boolean, taskType: CallTaskType): string[] {
  const required = taskType === 'probe' ? { tools: false, json: false } : LLM_TASK_REQUIREMENTS[taskType];
  const need = { tools: needsTools || required.tools, json: required.json };
  return [...(need.tools && !caps.tools ? ['tools'] : []), ...(need.json && !caps.json ? ['json'] : [])];
}

/** A site provider still matches its frozen candidate: there, enabled, same endpoint and protocol. */
function stillMatches(row: ProviderRow | undefined, c: Candidate): row is ProviderRow {
  return Boolean(row && !row.deletedAt && !row.disabledAt && row.baseUrl === c.baseUrl && row.kind === c.protocol);
}

interface Directive {
  /** The call, open and this executor's, with an attempt to send. */
  run?: { call: CallRow; attempt: AttemptRow; candidates: Candidate[] };
  /** A finished call (replay or refusal): its stored result or reason. */
  done?: { callId: string; result?: unknown; reason?: string };
}

/** What the request should be, frozen into the call's digest. */
interface CallRequest {
  needsTools: boolean;
  systemPrompt: string;
  tools: ToolDefinition[] | undefined;
  maxOutputTokens: number;
  inputTokens: number;
}

type SendResult = { outcome: ChatOutcome; notSent?: 'cancelled' | 'deadline' | 'lease' | 'provider_changed' | 'capability'; candidate: Candidate };

type OkOutcome = Extract<ChatOutcome, { kind: 'ok' }>;

/** One logical call, whatever its protocol: how to send an attempt, and what success means. */
interface ExecSpec {
  input: Pick<ChatCallInput, 'siteId' | 'origin' | 'callKey' | 'deadlineMs' | 'signal' | 'capability'> & { taskType: CallTaskType };
  callDigest: string;
  req: CallRequest;
  /** A fixed chain (instance services with their own retries); default: resolved per site. */
  candidates?: Candidate[];
  send: (c: Candidate, key: string | null, signal: AbortSignal, timeoutMs: number) => Promise<ChatOutcome>;
  /** Whether an error response may move to the next candidate (default: yes). */
  transferable?: (o: Exclude<ChatOutcome, OkOutcome>) => boolean;
  /** Between two attempts (e.g. a backoff); may throw to stop. */
  between?: (o: ChatOutcome) => Promise<void>;
  /** What is stored and returned for a success. */
  toResult: (o: OkOutcome, c: Candidate) => Record<string, unknown>;
}

interface ExecResult {
  result: Record<string, unknown>;
  callId: string;
  attemptIds: string[];
}

export class LlmGateway {
  private readonly instanceCurrency: string;
  private readonly graceMs: number;
  /** The guard's margin before the local lease end; never more than the grace period (design). */
  private readonly safetyMs: number;

  constructor(private readonly deps: GatewayDeps) {
    const raw = (deps.env.LLM_PRICE_CURRENCY ?? 'USD').trim().toUpperCase();
    this.instanceCurrency = /^[A-Z]{3}$/.test(raw) ? raw : 'USD';
    this.graceMs = deps.graceMs ?? RECOVERY_GRACE_MS;
    this.safetyMs = Math.min(SAFETY_MS, this.graceMs);
    this.governor = deps.governor ?? sharedGovernor();
  }

  private readonly governor: ModelCallGovernor;

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ── resolution ──────────────────────────────────────────────────────

  /**
   * The candidate chain at this moment: the task type's list, else the
   * site's default list, else the instance default. A list whose providers
   * are all unavailable is an error, not a fall back to the instance.
   */
  private async resolve(tx: Tx, siteId: string, taskType: LlmTaskType): Promise<Candidate[]> {
    for (const type of taskType === 'default' ? ['default'] : [taskType, 'default']) {
      const rows = await tx
        .select({ provider: llmProviders })
        .from(llmRoutes)
        .innerJoin(llmProviders, and(eq(llmProviders.siteId, llmRoutes.siteId), eq(llmProviders.id, llmRoutes.providerId)))
        .where(and(eq(llmRoutes.siteId, siteId), eq(llmRoutes.taskType, type)))
        .orderBy(asc(llmRoutes.position));
      if (rows.length === 0) continue;
      const usable = rows.map((r) => r.provider).filter((p) => !p.deletedAt && !p.disabledAt);
      if (usable.length === 0) throw new LlmGatewayError('PROVIDER_UNAVAILABLE', `Every provider of the ${type} list is disabled or deleted.`);
      return usable.map(siteCandidate);
    }
    const inst = instanceDefault(this.deps.env, this.instanceCurrency);
    if (!inst) return [];
    if (inst.unpriced) throw new LlmGatewayError('PRICE_NOT_CONFIGURED', 'Set LLM_PRICE_INPUT_PER_1M and LLM_PRICE_OUTPUT_PER_1M for the instance model.');
    return [inst.candidate];
  }

  /** Whether a site has any model for a task type (callers that fall back to a stub when not). */
  async configured(siteId: string, taskType: LlmTaskType): Promise<boolean> {
    try {
      return (await runSiteTransaction(this.deps.db, siteId, (tx) => this.resolve(tx, siteId, taskType))).length > 0;
    } catch {
      return true; // configured, but unusable: the call itself reports why
    }
  }

  // ── the call ────────────────────────────────────────────────────────

  async chat(input: ChatCallInput): Promise<ChatCallResult> {
    const needsTools = input.tools !== false;
    const systemPrompt = input.systemPrompt ?? copilotSystemPrompt();
    const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const tools = needsTools ? (this.deps.tools ?? copilotTools)() : undefined;
    const req: CallRequest = {
      needsTools,
      systemPrompt,
      tools,
      maxOutputTokens,
      inputTokens: estimateTokens(systemPrompt + JSON.stringify(input.messages) + (tools ? JSON.stringify(tools) : '')),
    };
    // Everything that shapes the request — tool definitions included.
    const callDigest = digest({ taskType: input.taskType, systemPrompt, messages: input.messages, tools: tools ?? null, maxOutputTokens });
    const out = await this.execute({
      input,
      callDigest,
      req,
      send: (c, key, signal, timeoutMs) => this.send(c, key, input.messages, req, timeoutMs, signal),
      toResult: (o, c) => {
        const response: LLMResponse = {
          content: o.content,
          toolCalls: o.toolCalls,
          ...(o.usage.inputTokens !== null || o.usage.outputTokens !== null ? { usage: { inputTokens: o.usage.inputTokens, outputTokens: o.usage.outputTokens } } : {}),
        };
        return { response, provider: c.name, model: c.model };
      },
    });
    const r = out.result as { response: LLMResponse; provider: string; model: string };
    return { response: r.response, provider: r.provider, model: r.model, callId: out.callId, attemptIds: out.attemptIds };
  }

  /**
   * The site's embedding providers (HeoPress P08 task 4.2): the `embedding` list only — never the `default` list or the
   * instance default, whose models chat — and only OpenAI-compatible endpoints (`POST /embeddings`).
   */
  private async resolveEmbedding(tx: Tx, siteId: string): Promise<Candidate[]> {
    const rows = await tx
      .select({ provider: llmProviders })
      .from(llmRoutes)
      .innerJoin(llmProviders, and(eq(llmProviders.siteId, llmRoutes.siteId), eq(llmProviders.id, llmRoutes.providerId)))
      .where(and(eq(llmRoutes.siteId, siteId), eq(llmRoutes.taskType, 'embedding')))
      .orderBy(asc(llmRoutes.position));
    return rows
      .map((r) => r.provider)
      .filter((p) => !p.deletedAt && !p.disabledAt)
      .map(siteCandidate)
      .filter((c) => c.protocol !== 'anthropic' && c.protocol !== 'gemini');
  }

  /** Whether the site has an embedding provider. */
  async embeddingConfigured(siteId: string): Promise<boolean> {
    return (await runSiteTransaction(this.deps.db, siteId, (tx) => this.resolveEmbedding(tx, siteId))).length > 0;
  }

  /**
   * Embed one text through the ledger like any other model call: reserved against the site's budget, recorded per
   * attempt, failing over along the site's `embedding` list. Throws `LlmGatewayError('LLM_NOT_CONFIGURED')` when the
   * site has none.
   */
  async embed(input: {
    siteId: string;
    origin: { kind: string; id?: string };
    capability?: AiCapability;
    callKey?: string;
    text: string;
    deadlineMs?: number;
    signal?: AbortSignal;
  }): Promise<{
    embedding: number[];
    provider: string;
    model: string;
    callId: string;
  }> {
    const candidates = await runSiteTransaction(this.deps.db, input.siteId, (tx) => this.resolveEmbedding(tx, input.siteId));
    if (!candidates.length) throw new LlmGatewayError('LLM_NOT_CONFIGURED', 'No embedding model is configured for this site.');
    const out = await this.execute({
      input: {
        siteId: input.siteId,
        taskType: 'embedding',
        capability: input.capability ?? 'ingest_embedding',
        origin: input.origin,
        callKey: input.callKey,
        deadlineMs: input.deadlineMs,
        signal: input.signal,
      },
      callDigest: digest({ taskType: 'embedding', input: input.text }),
      req: { needsTools: false, systemPrompt: '', tools: undefined, maxOutputTokens: 0, inputTokens: estimateTokens(input.text) },
      candidates,
      send: (c, key, signal, timeoutMs) => sendEmbedding({ model: c.model, input: input.text }, { baseUrl: c.baseUrl!, apiKey: key ?? '', timeoutMs, signal, fetch: this.deps.fetch }),
      toResult: (o, c) => ({ embedding: JSON.parse(o.content ?? '[]') as number[], provider: c.name, model: c.model }),
    });
    const r = out.result as { embedding: number[]; provider: string; model: string };
    return { embedding: r.embedding, provider: r.provider, model: r.model, callId: out.callId };
  }

  /**
   * A call to an instance service that is not a chat model (the decision
   * service): a fixed chain — the same service once per allowed attempt, so
   * each retry is its own ledger entry — the service's own rules for what is
   * retried, and its backoff between attempts.
   */
  async external(spec: {
    siteId: string;
    taskType: LlmTaskType;
    capability?: AiCapability;
    origin: { kind: string; id?: string };
    callKey?: string;
    candidate: Candidate;
    attempts: number;
    request: unknown;
    deadlineMs: number;
    signal?: AbortSignal;
    send: (signal: AbortSignal, timeoutMs: number) => Promise<ChatOutcome>;
    transferable: (o: Exclude<ChatOutcome, OkOutcome>) => boolean;
    between: (o: ChatOutcome) => Promise<void>;
  }): Promise<{ value: unknown; callId: string; attemptIds: string[] }> {
    const out = await this.execute({
      input: { siteId: spec.siteId, taskType: spec.taskType, capability: spec.capability, origin: spec.origin, callKey: spec.callKey, deadlineMs: spec.deadlineMs, signal: spec.signal },
      callDigest: digest({ taskType: spec.taskType, request: spec.request, service: spec.candidate.fingerprint }),
      req: { needsTools: false, systemPrompt: '', tools: undefined, maxOutputTokens: 0, inputTokens: estimateTokens(JSON.stringify(spec.request)) },
      candidates: Array.from({ length: Math.max(1, spec.attempts) }, () => spec.candidate),
      send: (_c, _key, signal, timeoutMs) => spec.send(signal, timeoutMs),
      transferable: spec.transferable,
      between: spec.between,
      toResult: (o) => ({ value: o.content === null ? null : (JSON.parse(o.content) as unknown) }),
    });
    return { value: out.result.value, callId: out.callId, attemptIds: out.attemptIds };
  }

  /** The state machine's driver, for any protocol. */
  private async execute(spec: ExecSpec): Promise<ExecResult> {
    const { input, req } = spec;
    const callKey = input.callKey ?? `adhoc:${nanoid()}`;
    let directive = await this.begin(spec, callKey);
    for (;;) {
      if (directive.done) return this.finish(input.siteId, directive.done);
      const { call, attempt, candidates } = directive.run!;
      await this.deps.hooks?.afterReserve?.(attempt);
      const sent = await this.sendGuarded(call, attempt, candidates[attempt.position]!, spec);
      // Only what reached the service feeds its breaker.
      if (!sent.notSent) this.governor.record(serviceKey(input.siteId, sent.candidate.fingerprint), sent.outcome);
      const { kind, evidence, result, reason } = this.classify(sent, spec);
      const ended = await runSiteTransaction(this.deps.db, input.siteId, async (tx) => {
        await lockLedger(tx, input.siteId);
        // A cancellation seen here is persisted, whatever happens next (replays obey it).
        if (input.signal?.aborted) await this.persistCancel(tx, input.siteId, call.id);
        if (await endAttempt(tx, attempt, OWNER_ID, kind, evidence, { result, reason })) return true;
        // Our lease ran out: recover our own attempt now, then keep its usage (T7 + T8).
        await recoverAttempt(tx, input.siteId, attempt.id, 0);
        await lateUsage(tx, attempt, evidence);
        return false;
      });
      if (!ended) throw new LlmGatewayError('CALL_IN_PROGRESS', 'The model call lost its lease; it continues elsewhere or is recovered.');
      if (kind === 'succeeded') return this.finish(input.siteId, { callId: call.id, result });
      if (kind === 'failed_final') return this.finish(input.siteId, { callId: call.id, reason: reason ?? 'FAILED' });
      await this.deps.hooks?.afterTransferableEnd?.(attempt);
      // A backoff only when another attempt remains; the call's lease is kept alive meanwhile.
      if (spec.between && attempt.position + 1 < candidates.length) {
        const leaseMs = 2 * this.graceMs;
        // One heartbeat at a time, stopped and awaited before the next attempt: a late one never lands after it.
        let stopped = false;
        let beat: Promise<void> = Promise.resolve();
        const keepAlive = setInterval(() => {
          beat = beat.then(() => (stopped ? undefined : this.renewCallLease(input.siteId, call.id, leaseMs))).catch(() => undefined);
        }, Math.max(250, Math.floor(this.graceMs / 2)));
        beat = this.renewCallLease(input.siteId, call.id, leaseMs).catch(() => undefined);
        try {
          await beat;
          await spec.between(sent.outcome);
        } catch {
          // The caller stops here (its deadline, a cancellation): the call ends; earlier attempts keep their liabilities.
          await runSiteTransaction(this.deps.db, input.siteId, async (tx) => {
            await lockLedger(tx, input.siteId);
            if (input.signal?.aborted) await this.persistCancel(tx, input.siteId, call.id);
            await failCall(tx, input.siteId, call.id, input.signal?.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED');
          });
          return this.finish(input.siteId, { callId: call.id, reason: input.signal?.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED' });
        } finally {
          stopped = true;
          clearInterval(keepAlive);
          // Bounded: a renewal stuck behind a lock must not hold up the next step (a late one cannot shorten the lease).
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([beat, new Promise<void>((r) => (timer = setTimeout(r, this.graceMs)))]);
          clearTimeout(timer);
        }
      }
      try {
        directive = await this.continueCall(input, call.id, attempt, req);
      } catch (err) {
        // Deferred mid-call: hand the call back at once, so the deferred retry can take it over (a replay).
        if (err instanceof LlmDeferredError) await this.releaseCall(input.siteId, call.id);
        throw err;
      }
    }
  }

  /** The answer (or error) of a finished call, with its id and every attempt id, from the ledger. */
  private async finish(siteId: string, done: NonNullable<Directive['done']>): Promise<ExecResult> {
    if (done.reason !== undefined) throw new LlmGatewayError(done.reason, 'The model call did not complete.');
    const ids = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .select({ id: llmAttempts.id })
        .from(llmAttempts)
        .where(and(eq(llmAttempts.siteId, siteId), eq(llmAttempts.callId, done.callId)))
        .orderBy(asc(llmAttempts.seq)),
    );
    return { result: done.result as Record<string, unknown>, callId: done.callId, attemptIds: ids.map((a) => a.id) };
  }

  /** Keep this executor's call lease (between attempts); only while it still holds it, and never shorter. */
  private async renewCallLease(siteId: string, callId: string, leaseMs: number): Promise<void> {
    // A renewal waits for no lock longer than the grace period: it is retried by the next heartbeat.
    const waitMs = Math.max(1, Math.min(1000, Math.floor(this.graceMs)));
    await runSiteTransaction(this.deps.db, siteId, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${waitMs}ms'`));
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${waitMs}ms'`));
      await tx.execute(sql`
        UPDATE lumibase_llm_calls SET lease_until = GREATEST(lease_until, now() + make_interval(secs => ${leaseMs / 1000}))
         WHERE site_id = ${siteId} AND id = ${callId} AND status = 'open' AND owner_id = ${OWNER_ID} AND lease_until > now()`);
    });
  }

  /** Give up this executor's lease on an open call (a deferral): anyone may take it over. */
  private async releaseCall(siteId: string, callId: string): Promise<void> {
    await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx.execute(sql`
        UPDATE lumibase_llm_calls SET lease_until = now() - make_interval(secs => ${(2 * this.graceMs) / 1000 + 1})
         WHERE site_id = ${siteId} AND id = ${callId} AND status = 'open' AND owner_id = ${OWNER_ID}`),
    );
  }

  private async persistCancel(tx: Tx, siteId: string, callId: string): Promise<void> {
    await tx
      .update(llmCalls)
      .set({ cancelRequestedAt: sql`COALESCE(${llmCalls.cancelRequestedAt}, now())` as unknown as Date })
      .where(and(eq(llmCalls.siteId, siteId), eq(llmCalls.id, callId)));
  }

  /** T1, or the replay of an existing call. */
  private begin(spec: ExecSpec, callKey: string): Promise<Directive> {
    const { input, req, callDigest } = spec;
    return runSiteTransaction(this.deps.db, input.siteId, async (tx) => {
      await lockLedger(tx, input.siteId);
      const [existing] = await tx.select().from(llmCalls).where(and(eq(llmCalls.siteId, input.siteId), eq(llmCalls.callKey, callKey)));
      if (existing) return this.replay(tx, existing, callDigest, input, req);

      const candidates = spec.candidates ?? (input.taskType === 'probe' ? [] : await this.resolve(tx, input.siteId, input.taskType));
      if (candidates.length === 0) throw new LlmGatewayError('LLM_NOT_CONFIGURED', 'No model is configured for this site.');
      const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
      const [call] = await tx
        .insert(llmCalls)
        .values({
          siteId: input.siteId,
          callKey,
          taskType: input.taskType,
          capability: input.capability ?? capabilityOf(input.taskType),
          originKind: input.origin.kind,
          originId: input.origin.id ?? null,
          requestDigest: callDigest,
          candidates,
          deadlineAt: sql`now() + make_interval(secs => ${deadlineMs / 1000})` as unknown as Date,
          status: 'open',
          ownerId: OWNER_ID,
          // Renewed with each attempt's lease (admitAt, the send guard).
          leaseUntil: sql`now() + make_interval(secs => ${this.graceMs / 1000})` as unknown as Date,
        })
        .returning();
      return this.admitAt(tx, call!, candidates, 0, null, 1, input, req);
    });
  }

  /** Admit `candidates[position]` (or the next available one) for attempt `seq`, or end the call (T6a / T6b refusal). */
  private async admitAt(
    tx: Tx,
    call: CallRow,
    candidates: Candidate[],
    position: number,
    previous: AttemptRow | null,
    seq: number,
    input: ExecSpec['input'],
    req: CallRequest,
  ): Promise<Directive> {
    const end = async (reason: string): Promise<Directive> => {
      await failCall(tx, call.siteId, call.id, reason);
      return { done: { callId: call.id, reason } };
    };
    // T6a, in order: cancellation, deadline, chain exhausted.
    if (input.signal?.aborted) await this.persistCancel(tx, call.siteId, call.id);
    const [state] = (await tx.execute(sql`
      SELECT cancel_requested_at IS NOT NULL AS cancelled, deadline_at <= now() AS expired
        FROM lumibase_llm_calls WHERE site_id = ${call.siteId} AND id = ${call.id}`)) as unknown as Array<{ cancelled: boolean; expired: boolean }>;
    if (state?.cancelled) return end('CANCELLED');
    if (state?.expired) return end('DEADLINE_EXCEEDED');
    let pos = position;
    let row: ProviderRow | undefined;
    // Governance (P09 task 4.5): a service whose breaker is open or whose rate limit is reached is passed over for
    // the next candidate (the backup model); when every remaining one is held back the call is deferred, not failed.
    let held: { code: 'RATE_LIMITED' | 'BREAKER_OPEN'; retryAt: number } | null = null;
    for (; pos < candidates.length; pos++) {
      const c = candidates[pos]!;
      if (c.source === 'site') {
        [row] = await tx.select().from(llmProviders).where(and(eq(llmProviders.siteId, call.siteId), eq(llmProviders.id, c.providerId!)));
        if (!stillMatches(row, c)) continue;
      }
      const gate = this.governor.take(serviceKey(call.siteId, c.fingerprint));
      if (gate.ok) break;
      if (!held || gate.retryAt < held.retryAt) held = { code: gate.code, retryAt: gate.retryAt };
    }
    if (pos >= candidates.length) {
      if (held) throw new LlmDeferredError(held.code, new Date(held.retryAt));
      return end('CHAIN_EXHAUSTED');
    }
    const candidate = candidates[pos]!;
    // T6b: admission (current capabilities, currency, budget). A refusal ends the call; earlier attempts keep their liabilities.
    const caps = candidate.source === 'site' ? (row!.capabilities as Candidate['capabilities']) : candidate.capabilities;
    if (missingFor(caps, req.needsTools, input.taskType).length) return end('CAPABILITY_UNSUPPORTED');
    const budget = await siteBudget(tx, call.siteId, this.instanceCurrency);
    const reserved = reservationOf(candidate, req.inputTokens, req.maxOutputTokens);
    const at = this.now();
    let period: string;
    try {
      period = await admit(tx, call.siteId, { ...candidate, currency: candidate.source === 'site' ? row!.currency : candidate.currency }, reserved, budget, at);
    } catch (err) {
      if (err instanceof LedgerRefusal) {
        // The month's budget is used up: the site's pipeline pauses (once) and its administrators are told (P09 task 4.2).
        if (err.code === 'BUDGET_EXCEEDED') await pauseForBudget(tx, call.siteId, periodOf(at, budget.budgetTimezone));
        return end(err.code);
      }
      throw err;
    }
    // The optional daily budget, in the site's time zone: used up → the call waits for the next local day.
    const daily = await dailyBudgetOf(tx, call.siteId);
    if (daily.dailyBudgetMicros !== null && (await dailyCommittedMicros(tx, call.siteId, at, daily.timeZone)) + reserved > daily.dailyBudgetMicros) {
      throw new LlmDeferredError('DAILY_BUDGET_EXHAUSTED', nextDayStart(at, daily.timeZone));
    }
    const leaseMs = candidate.timeoutMs + this.graceMs;
    const attempt = await insertAttempt(tx, {
      siteId: call.siteId,
      callId: call.id,
      seq,
      position: pos,
      previousAttemptId: previous?.id ?? null,
      candidate,
      // The request as sent to this provider.
      requestDigest: digest({ call: call.requestDigest, provider: candidate.fingerprint, model: candidate.model }),
      period,
      reservedMicros: reserved,
      ownerId: OWNER_ID,
      leaseMs,
    });
    const [renewed] = await tx
      .update(llmCalls)
      .set({ ownerId: OWNER_ID, leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})` as unknown as Date })
      .where(and(eq(llmCalls.siteId, call.siteId), eq(llmCalls.id, call.id)))
      .returning();
    return { run: { call: renewed!, attempt, candidates } };
  }

  /** The replay of an existing call (see the replay table). */
  private async replay(tx: Tx, call: CallRow, callDigest: string, input: ExecSpec['input'], req: CallRequest): Promise<Directive> {
    if (call.requestDigest !== callDigest) throw new LlmGatewayError('CALL_DIGEST_MISMATCH', 'This call key was used for another request.');
    if (call.status === 'completed') return { done: { callId: call.id, result: call.result } };
    if (call.status === 'failed') return { done: { callId: call.id, reason: call.terminalReason ?? 'FAILED' } };
    const last = await lastAttempt(tx, call.siteId, call.id);
    if (last && last.outcome === 'in_flight') {
      // Inside the grace period its executor may still be running.
      if (!(await recoverAttempt(tx, call.siteId, last.id, this.graceMs))) {
        throw new LlmGatewayError('CALL_IN_PROGRESS', 'The model call is in progress.');
      }
    }
    // Take the call's lease only once its holder's expired past the grace period —
    // the same process included (its own executor may be between two attempts).
    const taken = await tx
      .update(llmCalls)
      .set({ ownerId: OWNER_ID, leaseUntil: sql`now() + make_interval(secs => ${this.graceMs / 1000})` as unknown as Date })
      .where(
        and(
          eq(llmCalls.siteId, call.siteId),
          eq(llmCalls.id, call.id),
          eq(llmCalls.status, 'open'),
          sql`(${llmCalls.leaseUntil} IS NULL OR ${llmCalls.leaseUntil} < now() - make_interval(secs => ${this.graceMs / 1000}))`,
        ),
      )
      .returning();
    if (taken.length === 0) throw new LlmGatewayError('CALL_IN_PROGRESS', 'The model call is in progress.');
    const lastNow = await lastAttempt(tx, call.siteId, call.id);
    return this.admitAt(tx, taken[0]!, call.candidates as Candidate[], (lastNow?.position ?? -1) + 1, lastNow, (lastNow?.seq ?? 0) + 1, input, req);
  }

  /** T6 after a transferable failure — only while this executor still drives the call and its attempt is the latest. */
  private continueCall(input: ExecSpec['input'], callId: string, previous: AttemptRow, req: CallRequest): Promise<Directive> {
    return runSiteTransaction(this.deps.db, input.siteId, async (tx) => {
      await lockLedger(tx, input.siteId);
      const [call] = await tx
        .select()
        .from(llmCalls)
        .where(and(eq(llmCalls.siteId, input.siteId), eq(llmCalls.id, callId), eq(llmCalls.status, 'open'), eq(llmCalls.ownerId, OWNER_ID), sql`${llmCalls.leaseUntil} > now()`));
      const [latest] = await tx
        .select({ seq: llmAttempts.seq })
        .from(llmAttempts)
        .where(and(eq(llmAttempts.siteId, input.siteId), eq(llmAttempts.callId, callId)))
        .orderBy(desc(llmAttempts.seq))
        .limit(1);
      if (!call || latest?.seq !== previous.seq) throw new LlmGatewayError('CALL_IN_PROGRESS', 'The model call continues elsewhere.');
      return this.admitAt(tx, call, call.candidates as Candidate[], previous.position + 1, previous, previous.seq + 1, input, req);
    });
  }

  // ── sending ─────────────────────────────────────────────────────────

  /**
   * The send guard, then the request. In one transaction the guard renews
   * the attempt's and the call's leases by conditional updates (an expired
   * lease is not revived) and reads the provider as it is now: still the
   * same endpoint and protocol, enabled, able to do what the call needs —
   * and its key, read together with that endpoint, so a new key never goes
   * to an old endpoint. What is left of the lease is measured from the
   * moment the renewal was issued; under half, nothing is sent. The request
   * aborts before the local lease ends.
   */
  private async sendGuarded(call: CallRow, attempt: AttemptRow, candidate: Candidate, spec: ExecSpec): Promise<SendResult> {
    const { input, req } = spec;
    const leaseMs = candidate.timeoutMs + this.graceMs;
    const issued = Date.now();
    const guard = await runSiteTransaction(this.deps.db, input.siteId, async (tx) => {
      const a = await tx.execute(sql`
        UPDATE lumibase_llm_attempts SET lease_until = now() + make_interval(secs => ${leaseMs / 1000})
         WHERE site_id = ${input.siteId} AND id = ${attempt.id} AND outcome = 'in_flight' AND owner_id = ${OWNER_ID} AND lease_until > now()
        RETURNING 1`);
      const c = await tx.execute(sql`
        UPDATE lumibase_llm_calls SET lease_until = now() + make_interval(secs => ${leaseMs / 1000})
         WHERE site_id = ${input.siteId} AND id = ${call.id} AND status = 'open' AND owner_id = ${OWNER_ID} AND lease_until > now()
        RETURNING cancel_requested_at IS NOT NULL AS cancelled, EXTRACT(EPOCH FROM (deadline_at - now())) * 1000 AS left_ms`);
      let secret: string | null = null;
      let changed = false;
      let incapable = false;
      if (candidate.source === 'site') {
        const [row] = await tx.select().from(llmProviders).where(and(eq(llmProviders.siteId, input.siteId), eq(llmProviders.id, candidate.providerId!)));
        // Moved, disabled or deleted: skipped along the frozen chain. Unable to do what the call needs: the call ends.
        changed = !stillMatches(row, candidate);
        incapable = !changed && missingFor(row!.capabilities as Candidate['capabilities'], req.needsTools, input.taskType).length > 0;
        secret = !changed && !incapable ? (row?.secretCiphertext ?? null) : null;
      }
      return {
        attempt: (a as unknown as unknown[]).length > 0,
        call: (c as unknown as Array<{ cancelled: boolean; left_ms: number }>)[0],
        changed,
        incapable,
        secret,
      };
    });
    if (!guard.attempt || !guard.call) return { outcome: { kind: 'blocked', sent: false }, notSent: 'lease', candidate };
    if (guard.changed) return { outcome: { kind: 'blocked', sent: false }, notSent: 'provider_changed', candidate };
    if (guard.incapable) return { outcome: { kind: 'blocked', sent: false }, notSent: 'capability', candidate };
    // The key first: what is left of the lease and the deadline is measured after it (decryption takes time too).
    const key =
      candidate.source === 'site'
        ? guard.secret
          ? await openSecret(this.deps.keys, guard.secret, `llm-provider:${candidate.providerId}`)
          : null
        : this.instanceKey(candidate);
    const elapsed = Date.now() - issued;
    const remainingLease = leaseMs - elapsed;
    if (remainingLease < leaseMs / 2) return { outcome: { kind: 'blocked', sent: false }, notSent: 'lease', candidate };
    if (guard.call.cancelled || input.signal?.aborted) return { outcome: { kind: 'cancelled' }, notSent: 'cancelled', candidate };
    const deadlineLeft = Number(guard.call.left_ms ?? 0) - elapsed;
    if (deadlineLeft <= 0) return { outcome: { kind: 'timeout' }, notSent: 'deadline', candidate };
    const abortAt = Math.min(remainingLease - this.safetyMs, deadlineLeft);
    // No time left to send within the lease: as if the lease were lost (nothing sent).
    if (abortAt <= 0) return { outcome: { kind: 'blocked', sent: false }, notSent: 'lease', candidate };
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), abortAt);
    const onCancel = () => stop.abort();
    input.signal?.addEventListener('abort', onCancel, { once: true });
    // A cancellation between the check above and the listener: honoured too.
    if (input.signal?.aborted) stop.abort();
    try {
      const outcome = await spec.send(candidate, key, stop.signal, Math.min(candidate.timeoutMs, abortAt));
      // An abort that was ours (lease or deadline), not the caller's: a timeout.
      if (outcome.kind === 'cancelled' && !input.signal?.aborted) return { outcome: { kind: 'timeout' }, candidate };
      return { outcome, candidate };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onCancel);
    }
  }

  private instanceKey(c: Candidate): string | null {
    const env = this.deps.env;
    return (c.protocol === 'openai' ? env.OPENAI_API_KEY : c.protocol === 'anthropic' ? env.ANTHROPIC_API_KEY : c.protocol === 'gemini' ? env.GEMINI_API_KEY : env.NVIDIA_API_KEY) ?? null;
  }

  private async send(c: Candidate, key: string | null, messages: LLMMessage[], req: CallRequest, timeoutMs: number, signal: AbortSignal): Promise<ChatOutcome> {
    if (c.protocol === 'anthropic' || c.protocol === 'gemini') {
      return this.sendNative(c, key ?? '', messages, { systemPrompt: req.systemPrompt, tools: req.needsTools, maxTokens: req.maxOutputTokens, signal }, timeoutMs);
    }
    return sendChat(
      { model: c.model, messages: [{ role: 'system', content: req.systemPrompt }, ...messages], tools: req.tools, maxTokens: req.maxOutputTokens },
      { baseUrl: c.baseUrl!, apiKey: key ?? '', timeoutMs, signal, fetch: this.deps.fetch },
    );
  }

  /** The instance's native protocols (Anthropic, Gemini): their adapters, mapped to the same outcome as the compatible client. */
  private async sendNative(c: Candidate, key: string, messages: LLMMessage[], options: LLMChatOptions, timeoutMs: number): Promise<ChatOutcome> {
    const provider: LLMProvider = c.protocol === 'anthropic' ? new AnthropicProvider(key, c.model) : new GeminiProvider(key, c.model);
    const stop = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, timeoutMs);
    const onAbort = () => stop.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const evidence = (u: { inputTokens: number | null; outputTokens: number | null } | undefined) => ({
      complete: u?.inputTokens != null && u?.outputTokens != null,
      inputTokens: u?.inputTokens ?? null,
      outputTokens: u?.outputTokens ?? null,
    });
    try {
      const r = await provider.chat(messages, { ...options, signal: stop.signal });
      return { kind: 'ok', content: r.content, toolCalls: r.toolCalls, usage: evidence(r.usage) };
    } catch (err) {
      // Their messages carry upstream text: only the status, usage and whether it was sent are kept.
      if (err instanceof ProviderHttpError) {
        return { kind: 'http', status: err.status, errorCode: `PROVIDER_HTTP_${err.status}`, usage: evidence(err.usage), retryAfterMs: null };
      }
      const block = outboundBlockOf(err);
      if (block) return { kind: 'blocked', sent: block.afterResponse };
      if (timedOut) return { kind: 'timeout' };
      if (options.signal?.aborted) return { kind: 'cancelled' };
      return { kind: 'network' };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  // ── classification ──────────────────────────────────────────────────

  /** How the attempt ends (T2 / T4 / T5) and what the ledger may conclude. */
  private classify(sent: SendResult, spec: ExecSpec): { kind: EndKind; evidence: Evidence; result?: Record<string, unknown>; reason?: string } {
    const o = sent.outcome;
    const callerSignal = spec.input.signal;
    const transferable = (x: Exclude<ChatOutcome, OkOutcome>) => (spec.transferable ? spec.transferable(x) : true);
    const none = { complete: false, inputTokens: null, outputTokens: null };
    switch (sent.notSent) {
      case 'cancelled':
        return { kind: 'failed_final', evidence: { sent: false, usage: none, errorCode: 'CANCELLED' }, reason: 'CANCELLED' };
      case 'deadline':
        return { kind: 'failed_final', evidence: { sent: false, usage: none, errorCode: 'DEADLINE_EXCEEDED' }, reason: 'DEADLINE_EXCEEDED' };
      case 'lease':
        return { kind: 'failed_transferable', evidence: { sent: false, usage: none, errorCode: 'LEASE_LOST' } };
      case 'provider_changed':
        // The frozen candidate no longer exists as frozen: skipped, at no cost.
        return { kind: 'failed_transferable', evidence: { sent: false, usage: none, errorCode: 'PROVIDER_CHANGED' } };
      case 'capability':
        // The provider can no longer do what the call needs: an admission refusal, the call ends.
        return { kind: 'failed_final', evidence: { sent: false, usage: none, errorCode: 'CAPABILITY_UNSUPPORTED' }, reason: 'CAPABILITY_UNSUPPORTED' };
    }
    switch (o.kind) {
      case 'ok':
        return { kind: 'succeeded', evidence: { sent: true, usage: o.usage }, result: spec.toResult(o, sent.candidate) };
      case 'http':
        return transferable(o)
          ? { kind: 'failed_transferable', evidence: { sent: true, usage: o.usage, errorCode: o.errorCode } }
          : { kind: 'failed_final', evidence: { sent: true, usage: o.usage, errorCode: o.errorCode }, reason: o.errorCode };
      case 'bad_response':
        return transferable(o)
          ? { kind: 'failed_transferable', evidence: { sent: true, usage: o.usage, errorCode: 'BAD_RESPONSE' } }
          : { kind: 'failed_final', evidence: { sent: true, usage: o.usage, errorCode: 'BAD_RESPONSE' }, reason: 'BAD_RESPONSE' };
      case 'blocked':
        // A policy refusal does not fail over; billing still follows whether it was sent.
        return { kind: 'failed_final', evidence: { sent: o.sent, usage: none, errorCode: 'OUTBOUND_BLOCKED' }, reason: 'OUTBOUND_BLOCKED' };
      case 'cancelled':
        // The caller cancelled: never fail over; the request may have been sent.
        return { kind: 'failed_final', evidence: { sent: true, usage: none, errorCode: 'CANCELLED' }, reason: 'CANCELLED' };
      case 'timeout':
        return callerSignal?.aborted
          ? { kind: 'failed_final', evidence: { sent: true, usage: none, errorCode: 'CANCELLED' }, reason: 'CANCELLED' }
          : { kind: 'failed_transferable', evidence: { sent: true, usage: none, errorCode: 'TIMEOUT' } };
      case 'network':
        return { kind: 'failed_transferable', evidence: { sent: true, usage: none, errorCode: 'NETWORK' } };
    }
  }

  // ── adapters for existing call sites ────────────────────────────────

  /**
   * An `LLMProvider` for a call site: each `chat` is one gateway call of
   * this task type. `name` / `model` report the provider actually used by
   * the latest call (after failover), not a static configuration.
   */
  /**
   * The capability probe (design "接口"): a tool it is told to call and a JSON-object
   * answer, judged by what came back, not by a 200. Each is a ledger call of
   * type `probe` on this provider alone — reserved, guarded and settled like
   * any other, never failing over to another provider.
   */
  async probe(siteId: string, providerId: string, origin: { kind: string; id?: string }): Promise<{ tools: ProbeVerdict; json: ProbeVerdict }> {
    const [row] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx.select().from(llmProviders).where(and(eq(llmProviders.siteId, siteId), eq(llmProviders.id, providerId), isNull(llmProviders.deletedAt))),
    );
    if (!row) throw new LlmGatewayError('NOT_FOUND', 'Provider not found.');
    if (row.disabledAt) throw new LlmGatewayError('PROVIDER_DISABLED', 'Enable the provider to probe it.');
    const candidate = siteCandidate(row);
    const requests = probeRequests(row.model);
    const verdicts = {} as { tools: ProbeVerdict; json: ProbeVerdict };
    for (const kind of ['tools', 'json'] as const) {
      const request = requests[kind];
      let last: ChatOutcome | null = null;
      try {
        const out = await this.execute({
          input: { siteId, taskType: 'probe', origin, deadlineMs: candidate.timeoutMs + this.graceMs },
          callDigest: digest({ taskType: 'probe', kind, request, provider: candidate.fingerprint }),
          req: {
            needsTools: false,
            systemPrompt: '',
            tools: request.tools,
            maxOutputTokens: request.maxTokens,
            inputTokens: estimateTokens(JSON.stringify(request.messages) + (request.tools ? JSON.stringify(request.tools) : '')),
          },
          candidates: [candidate],
          send: async (c, key, signal, timeoutMs) => {
            last = await sendChat({ ...request, model: c.model }, { baseUrl: c.baseUrl!, apiKey: key ?? '', timeoutMs, signal, fetch: this.deps.fetch });
            return last;
          },
          toResult: (o) => ({ verdict: judgeProbe(kind, o) }),
        });
        verdicts[kind] = (out.result as { verdict: ProbeVerdict }).verdict;
      } catch (err) {
        if (!(err instanceof LlmGatewayError)) throw err;
        // What the provider answered, when it answered; otherwise why nothing was sent (budget, currency, …).
        const answered = last as ChatOutcome | null;
        // The probe has no caller to cancel it: an aborted request is the guard's timeout.
        verdicts[kind] = answered ? judgeProbe(kind, answered.kind === 'cancelled' ? { kind: 'timeout' } : answered) : { ok: false, error: err.code };
      }
    }
    return verdicts;
  }

  providerFor(binding: { siteId: string; taskType: LlmTaskType; capability?: AiCapability; origin: { kind: string; id?: string }; callKey?: () => string | undefined }) {
    const gateway = this;
    let last = { name: 'unknown', model: 'unknown' };
    const provider: LLMProvider = {
      async chat(messages: LLMMessage[], options: LLMChatOptions = {}): Promise<LLMResponse> {
        const out = await gateway.chat({
          siteId: binding.siteId,
          taskType: (options.taskType as LlmTaskType | undefined) ?? binding.taskType,
          capability: binding.capability,
          origin: binding.origin,
          callKey: binding.callKey?.(),
          messages,
          systemPrompt: options.systemPrompt,
          // Only chat offers the Copilot tools by default; the other task types need none (migration matrix).
          tools: options.tools ?? binding.taskType === 'chat',
          maxOutputTokens: options.maxTokens,
          signal: options.signal,
        });
        last = { name: out.provider, model: out.model };
        return out.response;
      },
    };
    return {
      provider,
      get name() {
        return last.name;
      },
      get model() {
        return last.model;
      },
    };
  }
}
