import type { LlmTaskType } from '@heopress/contracts/schemas';
import type { Database } from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import { EchoProvider, type ConfiguredLLM, type LLMProvider } from '../llm-provider';
import { LlmGateway } from './gateway';

/**
 * How call sites reach models (HeoPress P04 task 7.4): through the model
 * gateway, bound to a site, a task type and an origin. These keep the shapes
 * the call sites already use (`ConfiguredLLM`, `LLMProvider`), so the
 * migration does not change what they do with the answer.
 */

export interface GatewayContext {
  db: Database;
  keys: KeyProvider;
  env: Record<string, string | undefined>;
}

export function gatewayFor(ctx: Omit<GatewayContext, 'keys'> & { keys?: KeyProvider }): LlmGateway {
  return new LlmGateway({ db: ctx.db, keys: ctx.keys ?? NO_KEYS, env: ctx.env });
}

/** For workers started without a key provider: site keys cannot be opened (a clear error), instance keys still work. */
const NO_KEYS = {
  getActiveKey: async () => {
    throw new Error('KeyProvider: no encryption key configured for this worker');
  },
  getKey: async () => {
    throw new Error('KeyProvider: no encryption key configured for this worker');
  },
  listKeys: async () => [],
} as unknown as KeyProvider;

export interface Binding {
  siteId: string;
  taskType: LlmTaskType;
  origin: { kind: string; id?: string };
  /** A persistent identity per call (replays of a queued run); fresh when absent. */
  callKey?: () => string | undefined;
}

/**
 * A `ConfiguredLLM` for generation-style callers, or null when the site has
 * no model for the task type — they then fail with LLM_NOT_CONFIGURED as
 * before. Its `name` / `model` report the provider actually used last.
 */
export async function configuredLlm(
  gateway: LlmGateway,
  binding: Binding,
  /** Other task types its calls may use (a harness: `translation` besides `generation`). */
  alsoFor: LlmTaskType[] = [],
): Promise<ConfiguredLLM | null> {
  for (const taskType of [binding.taskType, ...alsoFor]) {
    if (await gateway.configured(binding.siteId, taskType)) return gateway.providerFor(binding);
  }
  return null;
}

/** The Copilot chat model: the gateway's, or the echo stub when the site has none (as before). */
export async function chatProvider(gateway: LlmGateway, binding: Binding): Promise<LLMProvider> {
  if (!(await gateway.configured(binding.siteId, binding.taskType))) return new EchoProvider();
  return gateway.providerFor(binding).provider;
}

/** `run:<runId>:call:<n>` for the n-th model call of a queued run (a retried job replays its answers). */
export function runCallKeys(runId: string | undefined): (() => string | undefined) | undefined {
  if (!runId) return undefined;
  let n = 0;
  return () => `run:${runId}:call:${++n}`;
}
