import { outboundBlockOf } from '@heopress/runtime/node';
import { serviceFetch } from '../service-fetch';

/**
 * One request to an OpenAI-compatible model service (HeoPress P04 task 7.1;
 * design "模型提供方实施方案"). It never throws for what happened to the
 * request: it answers what the ledger needs to know — the response, the
 * usage evidence, and whether the request was sent at all — and never
 * carries the upstream's own text (it may echo the request, or worse).
 *
 * Used by the model gateway, which owns timeouts, the ledger and failover.
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** `json_object`: the response must be a JSON object. */
  responseFormat?: 'json_object';
  maxTokens: number;
}

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** What the response said about tokens. `complete`: both counts present. */
interface UsageEvidence {
  complete: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type ChatOutcome =
  | { kind: 'ok'; content: string | null; toolCalls: ToolCall[]; usage: UsageEvidence }
  /** A 2xx whose body could not be understood: sent, possibly billed. */
  | { kind: 'bad_response'; status: number; usage: UsageEvidence }
  | { kind: 'http'; status: number; errorCode: string; usage: UsageEvidence; retryAfterMs: number | null }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  /** No answer: the request may or may not have reached the service. */
  | { kind: 'network' }
  /** Refused by the outbound boundary; `sent` when it happened after a response (a redirect). */
  | { kind: 'blocked'; sent: boolean };

export interface SendOptions {
  baseUrl: string;
  apiKey: string;
  /** Ends the request as a timeout. */
  timeoutMs: number;
  /** The caller's cancellation (or the gateway's lease and deadline): ends it as cancelled. */
  signal?: AbortSignal;
  /** Test seam; defaults to the platform's service fetch (outbound boundary). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const NO_USAGE: UsageEvidence = { complete: false, inputTokens: null, outputTokens: null };

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Usage as the OpenAI format reports it (`prompt_tokens`, `completion_tokens`). */
function usageOf(body: unknown): UsageEvidence {
  const u = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  if (!u || typeof u !== 'object') return NO_USAGE;
  const inputTokens = count(u.prompt_tokens);
  const outputTokens = count(u.completion_tokens);
  return { complete: inputTokens !== null && outputTokens !== null, inputTokens, outputTokens };
}

/**
 * The provider error codes worth telling apart, mapped to our own: nothing
 * of the upstream's text is ever copied (a service may echo the request —
 * and its key — in any field, `code` included; Codex review P04-7.1 #1).
 */
// A Map, not an object literal: `constructor` or `__proto__` must not match.
const KNOWN_PROVIDER_ERRORS = new Map<string, string>([
  ['rate_limit_exceeded', 'RATE_LIMITED'],
  ['insufficient_quota', 'QUOTA_EXHAUSTED'],
  ['invalid_api_key', 'INVALID_KEY'],
  ['context_length_exceeded', 'CONTEXT_TOO_LONG'],
  ['model_not_found', 'MODEL_NOT_FOUND'],
]);

/** A safe code for an error response: the status, and one of our own refinements. */
function errorCodeOf(status: number, body: unknown): string {
  const err = (body as { error?: { code?: unknown; type?: unknown } } | null)?.error;
  const known = [err?.code, err?.type].map((v) => (typeof v === 'string' ? KNOWN_PROVIDER_ERRORS.get(v) : undefined)).find(Boolean);
  return known ? `PROVIDER_HTTP_${status}:${known}` : `PROVIDER_HTTP_${status}`;
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

function parseToolCalls(message: unknown): ToolCall[] | null {
  const calls = (message as { tool_calls?: unknown } | null)?.tool_calls;
  if (calls === undefined || calls === null) return [];
  if (!Array.isArray(calls)) return null;
  const out: ToolCall[] = [];
  for (const c of calls) {
    const fn = (c as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
    if (!fn || typeof fn.name !== 'string') return null;
    // The OpenAI format: arguments are a JSON object in a string. Anything
    // else is a response we do not understand — never a call with `{}`.
    if (typeof fn.arguments !== 'string') return null;
    let args: unknown;
    try {
      args = JSON.parse(fn.arguments);
    } catch {
      return null;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    out.push({ name: fn.name, arguments: args as Record<string, unknown> });
  }
  return out;
}

/** The request body, as sent (and as digested by the ledger). */
function chatBody(req: ChatRequest): Record<string, unknown> {
  return {
    model: req.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: 'auto',
        }
      : {}),
    ...(req.responseFormat ? { response_format: { type: req.responseFormat } } : {}),
  };
}

export async function sendChat(req: ChatRequest, opts: SendOptions): Promise<ChatOutcome> {
  if (opts.signal?.aborted) return { kind: 'cancelled' };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const doFetch = opts.fetch ?? serviceFetch;
  try {
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(chatBody(req)),
        signal: controller.signal,
      });
    } catch (err) {
      return failure(err, timedOut, opts.signal);
    }
    let body: unknown = null;
    let readable = true;
    try {
      body = await res.json();
    } catch (err) {
      // The body could not be read: an abort mid-body, or not JSON.
      if (controller.signal.aborted) return failure(err, timedOut, opts.signal);
      readable = false;
    }
    const usage = usageOf(body);
    if (!res.ok) {
      return { kind: 'http', status: res.status, errorCode: errorCodeOf(res.status, body), usage, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
    }
    if (!readable) return { kind: 'bad_response', status: res.status, usage: NO_USAGE };
    const message = (body as { choices?: Array<{ message?: unknown }> } | null)?.choices?.[0]?.message;
    const toolCalls = message ? parseToolCalls(message) : null;
    if (!message || toolCalls === null) return { kind: 'bad_response', status: res.status, usage };
    const content = (message as { content?: unknown }).content;
    return { kind: 'ok', content: typeof content === 'string' ? content : null, toolCalls, usage };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * One embeddings request (`POST /embeddings`, HeoPress P08 task 4.2). Same contract as `sendChat`: never throws for
 * what happened to the request; a success carries the vector as JSON in `content` (the ledger stores the call's result)
 * and the input tokens as its usage (an embedding has no output tokens).
 */
export async function sendEmbedding(req: { model: string; input: string }, opts: SendOptions): Promise<ChatOutcome> {
  if (opts.signal?.aborted) return { kind: 'cancelled' };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const doFetch = opts.fetch ?? serviceFetch;
  try {
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model: req.model, input: req.input }),
        signal: controller.signal,
      });
    } catch (err) {
      return failure(err, timedOut, opts.signal);
    }
    let body: unknown = null;
    let readable = true;
    try {
      body = await res.json();
    } catch (err) {
      if (controller.signal.aborted) return failure(err, timedOut, opts.signal);
      readable = false;
    }
    const prompt = count((body as { usage?: { prompt_tokens?: unknown } } | null)?.usage?.prompt_tokens);
    const usage: UsageEvidence = { complete: prompt !== null, inputTokens: prompt, outputTokens: prompt === null ? null : 0 };
    if (!res.ok) {
      return { kind: 'http', status: res.status, errorCode: errorCodeOf(res.status, body), usage, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
    }
    if (!readable) return { kind: 'bad_response', status: res.status, usage: NO_USAGE };
    const vector = (body as { data?: Array<{ embedding?: unknown }> } | null)?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return { kind: 'bad_response', status: res.status, usage };
    }
    return { kind: 'ok', content: JSON.stringify(vector), toolCalls: [], usage };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function failure(err: unknown, timedOut: boolean, signal?: AbortSignal): ChatOutcome {
  const block = outboundBlockOf(err);
  if (block) return { kind: 'blocked', sent: block.afterResponse };
  if (timedOut) return { kind: 'timeout' };
  if (signal?.aborted) return { kind: 'cancelled' };
  return { kind: 'network' };
}

// ── capability probe ─────────────────────────────────────────────────────

const PROBE_TOOL: ToolDefinition = {
  name: 'heopress_probe',
  description: 'Report that the probe ran. Always call this tool.',
  parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
};

/**
 * Output room for a probe answer. Current models think before they answer
 * (DeepSeek, Kimi K3, GLM-5.3, Qwen 3.x by default) and the reasoning counts
 * as output: a tight cap would end the answer before the tool call or the
 * JSON, and the probe would report a capability missing that is there.
 */
const PROBE_MAX_TOKENS = 2048;

/**
 * The two probe requests: a tool the model is told to call, and a
 * JSON-object response. The tool is not forced by name: some thinking
 * models refuse a named `tool_choice` (Kimi K3 answers 400 with thinking on), and
 * `required` is not universal (Z.AI lists only `auto`) — `auto` is what every
 * service accepts, and the verdict still needs a real tool call.
 */
export function probeRequests(model: string): { tools: ChatRequest; json: ChatRequest } {
  return {
    tools: {
      model,
      messages: [
        { role: 'system', content: 'You are being tested for tool use. Answer only by calling the heopress_probe tool.' },
        { role: 'user', content: 'Call the heopress_probe tool with ok set to true.' },
      ],
      tools: [PROBE_TOOL],
      maxTokens: PROBE_MAX_TOKENS,
    },
    json: {
      model,
      messages: [
        { role: 'system', content: 'Reply with a JSON object only.' },
        { role: 'user', content: 'Return {"ok": true} as a JSON object.' },
      ],
      responseFormat: 'json_object',
      maxTokens: PROBE_MAX_TOKENS,
    },
  };
}

/** Judge a probe from what actually came back — not from a 200 alone. */
export function judgeProbe(kind: 'tools' | 'json', outcome: ChatOutcome): { ok: boolean; error?: string } {
  if (outcome.kind !== 'ok') return { ok: false, error: outcome.kind === 'http' ? outcome.errorCode : outcome.kind.toUpperCase() };
  if (kind === 'tools') {
    const call = outcome.toolCalls.find((c) => c.name === PROBE_TOOL.name);
    if (!call) return { ok: false, error: 'NO_TOOL_CALL' };
    // The arguments must follow the definition (`ok`: boolean).
    return typeof call.arguments.ok === 'boolean' ? { ok: true } : { ok: false, error: 'BAD_TOOL_ARGUMENTS' };
  }
  try {
    const value: unknown = JSON.parse(outcome.content ?? '');
    return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true } : { ok: false, error: 'NOT_A_JSON_OBJECT' };
  } catch {
    return { ok: false, error: 'NOT_JSON' };
  }
}
