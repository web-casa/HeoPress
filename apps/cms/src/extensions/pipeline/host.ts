/**
 * The pipeline plugin host (HeoPress P12 tasks 4.1, 4.2, 4.4; spec extensions/pipeline-extensions): loads a site's
 * plugins through the capability sandbox and hands the pipeline what they registered —
 *
 *   - source adapters (`ext:source-adapters`) for the ingest runner: `{ id, discover(ctx) }`, the id one the manifest
 *     declares. The adapter reaches the network only through the sandbox's `fetch` (its `http:fetch:<host>`
 *     capabilities, then the platform outbound boundary) and returns links; the core records, de-duplicates and fetches
 *     them (`discovery-runner.ts` `discoverPluginSource`);
 *   - gate checks (`ext:gate-checks`) for the quality gate: `{ id, check(subject) }`, run after the core checks (they
 *     can only make the verdict stricter, `quality-gate.ts`);
 *   - model access (`ai:generate`, task 4.4): every plugin-initiated call goes through the model gateway with the
 *     `plugin` capability — the per-call ledger and the site's budget apply, the site's own providers only (never the
 *     instance default, the operator's shared key) — and the plugin gets the answer text, never a key.
 *
 * A plugin whose load fails, or that registers on a point it did not declare (refused and recorded by the sandbox), simply
 * contributes nothing there; for the gate a declared check that is not registered counts as `needs_review`.
 */
import type { Database } from '@heopress/database';
import { extensionNamespace, pipelineDeclarationsOf, pluginGateRule, type ExtensionPoint } from '@heopress/contracts/extensions';
import type { Bindings } from '../../env';
import { ExtensionSandbox, type ExtensionAiAccess, type ExtensionSandboxDeps } from '../sandbox';
import { buildSandboxVerifyOptions } from '../../services/extension-verifier';
import { AuditLogger } from '../../modules/audit/logger';
import type { LlmGateway } from '../../services/llm/gateway';
import { runSiteTransaction } from '../../services/rls-transaction';
import type { GateCheckFn } from '../../services/pipeline/extension-points';
import { participatingRows, type ExtensionRow } from './declarations';

// ─── Plugin-facing shapes ────────────────────────────────────────────────────

/** What a source adapter's `discover` receives. */
interface SourceAdapterContext {
  /** The source's address, as the site's editors set it (one of the plugin's declared hosts). */
  url: string;
  /** New links the run takes at most; returning more is harmless (the rest are cut). */
  maxItems: number;
  signal: AbortSignal;
  source: { id: string; name: string };
}

export interface LoadedSourceAdapter {
  plugin: string;
  adapterId: string;
  discover(ctx: SourceAdapterContext): Promise<unknown> | unknown;
}


const isFn = (v: unknown): v is (...args: never[]) => unknown => typeof v === 'function';
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

// ─── Model access (task 4.4) ─────────────────────────────────────────────────

/** Upper bound of one plugin model call's output. */
const MAX_PLUGIN_OUTPUT_TOKENS = 4000;
const MAX_PLUGIN_MESSAGES = 50;
const MAX_PLUGIN_INPUT_CHARS = 200_000;

export class PluginAiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginAiRequestError';
  }
}

/**
 * A plugin's model access on one site: the gateway's `chat` with the `plugin` capability (ledger, budget), the site's own
 * providers only, no tools, the call key namespaced by plugin so one plugin never replays another's call.
 */
export function pluginAiAccess(gateway: Pick<LlmGateway, 'chat'>, siteId: string): ExtensionAiAccess {
  return async (extensionName, request) => {
    const r = obj(request);
    const messages = Array.isArray(r?.messages) ? (r!.messages as unknown[]) : null;
    if (!messages || messages.length === 0 || messages.length > MAX_PLUGIN_MESSAGES) throw new PluginAiRequestError(`messages: 1 to ${MAX_PLUGIN_MESSAGES} user / assistant messages`);
    const clean = messages.map((m) => {
      const o = obj(m);
      if (!o || (o.role !== 'user' && o.role !== 'assistant') || typeof o.content !== 'string') throw new PluginAiRequestError('each message is { role: "user" | "assistant", content: string }');
      return { role: o.role as 'user' | 'assistant', content: o.content };
    });
    const system = typeof r!.system === 'string' ? r!.system : 'You answer a request a site plugin makes.';
    if (system.length + clean.reduce((n, m) => n + m.content.length, 0) > MAX_PLUGIN_INPUT_CHARS) throw new PluginAiRequestError('the request is too long');
    const key = typeof r!.key === 'string' && /^[A-Za-z0-9:_.-]{1,120}$/.test(r!.key) ? r!.key : undefined;
    const max = typeof r!.maxOutputTokens === 'number' && Number.isInteger(r!.maxOutputTokens) ? Math.min(Math.max(1, r!.maxOutputTokens), MAX_PLUGIN_OUTPUT_TOKENS) : 512;
    const res = await gateway.chat({
      siteId,
      taskType: 'generation',
      capability: 'plugin',
      origin: { kind: 'extension', id: extensionName },
      ...(key ? { callKey: `ext:${extensionName}:${key}` } : {}),
      systemPrompt: system,
      tools: false,
      messages: clean,
      maxOutputTokens: max,
      siteProvidersOnly: true,
      signal: request.signal instanceof AbortSignal ? request.signal : undefined,
    });
    return {
      content: res.response.content ?? '',
      ...(res.response.usage ? { usage: { inputTokens: res.response.usage.inputTokens ?? null, outputTokens: res.response.usage.outputTokens ?? null } } : {}),
      callId: res.callId,
    };
  };
}

// ─── The host ────────────────────────────────────────────────────────────────

export interface PipelineHostDeps {
  db: Database;
  env: Bindings | Record<string, unknown>;
  /** The model gateway for `ai:generate`; absent → plugins' `ai.generate` is unavailable. */
  gateway?: Pick<LlmGateway, 'chat'> | null;
  /** Tests: the sandbox a site's plugins load in. */
  sandboxFor?: (siteId: string, deps: ExtensionSandboxDeps) => ExtensionSandbox;
}

interface LoadedRegistrations {
  row: ExtensionRow;
  definitions: readonly unknown[];
}

export class PipelinePluginHost {
  constructor(private readonly deps: PipelineHostDeps) {}

  private sandbox(siteId: string): ExtensionSandbox {
    const deps: ExtensionSandboxDeps = {
      ...(this.deps.gateway ? { ai: pluginAiAccess(this.deps.gateway, siteId) } : {}),
      // A refused capability use is recorded (spec extensions/permissions).
      onDenied: async (event) => {
        await new AuditLogger({ db: this.deps.db, siteId }).write({
          event: 'extension_capability_denied',
          actorEmail: null,
          ip: null,
          userAgent: null,
          requestId: null,
          metadata: { extensionName: event.extensionName, capability: event.capability, operation: event.operation, siteId },
        });
      },
    };
    return this.deps.sandboxFor ? this.deps.sandboxFor(siteId, deps) : new ExtensionSandbox(this.deps.env as never, deps);
  }

  /** What the site's participating plugins registered on `point`. */
  async registrations(siteId: string, point: ExtensionPoint): Promise<LoadedRegistrations[]> {
    const rows = await runSiteTransaction(this.deps.db, siteId, (tx) => participatingRows(tx, siteId, point));
    if (rows.length === 0) return [];
    const sandbox = this.sandbox(siteId);
    const out: LoadedRegistrations[] = [];
    for (const row of rows) {
      const mod = await sandbox.load({
        name: row.name,
        bundleUrl: row.bundleUrl,
        capabilities: Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [],
        // The same signature gate as every other load path: a bad signature or a revoked publisher never runs.
        ...buildSandboxVerifyOptions(row, this.deps.db, this.deps.env as Bindings),
      });
      const definitions = mod?.registrations?.get(point) ?? [];
      if (definitions.length) out.push({ row, definitions });
    }
    return out;
  }

  /** The adapter a `plugin` source names (`<plugin name>#<adapter id>`), when the plugin declares and registers it. */
  async sourceAdapter(siteId: string, ref: string): Promise<LoadedSourceAdapter | null> {
    const i = ref.lastIndexOf('#');
    if (i <= 0) return null;
    const plugin = ref.slice(0, i);
    const adapterId = ref.slice(i + 1);
    for (const { row, definitions } of await this.registrations(siteId, 'source-adapters')) {
      if (row.name !== plugin) continue;
      if (!(pipelineDeclarationsOf(row.manifest).sourceAdapters ?? []).some((a) => a.id === adapterId)) return null;
      for (const d of definitions) {
        const o = obj(d);
        if (o && o.id === adapterId && isFn(o.discover)) {
          const discover = o.discover as LoadedSourceAdapter['discover'];
          return { plugin, adapterId, discover: (ctx) => discover.call(o, ctx) };
        }
      }
    }
    return null;
  }

  /** The site's registered gate checks by rule (`ext:<namespace>:<id>`), declared ids only. */
  async gateChecks(siteId: string): Promise<Map<string, GateCheckFn>> {
    const out = new Map<string, GateCheckFn>();
    for (const { row, definitions } of await this.registrations(siteId, 'gate-checks')) {
      const ns = extensionNamespace(row.name);
      if (!ns) continue;
      const declared = new Set((pipelineDeclarationsOf(row.manifest).gateChecks ?? []).map((c) => c.id));
      for (const d of definitions) {
        const o = obj(d);
        if (!o || typeof o.id !== 'string' || !declared.has(o.id) || !isFn(o.check)) continue;
        const check = o.check as GateCheckFn;
        out.set(pluginGateRule(ns, o.id), (subject) => check.call(o, subject));
      }
    }
    return out;
  }
}
