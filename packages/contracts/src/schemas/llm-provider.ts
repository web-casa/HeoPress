import { z } from 'zod';

/**
 * Model providers per site (HeoPress P04 tasks 7.1–7.6, spec
 * platform/llm-providers): shared by the CMS (validation) and Studio (forms).
 *
 * A site configures OpenAI-compatible services (DeepSeek, Qwen, Kimi, GLM,
 * …) and, per task type, the ordered list of them to try. The API key is
 * write-only: responses show `LLM_SECRET_MASK` when one is set. Prices are
 * integer micro-units (a millionth of the currency unit) and mandatory —
 * zero must be stated.
 */

/** Task types a site can route. `default` applies to any task type without its own list. */
/** `embedding` (HeoPress P08 task 4.2): text embeddings; only its own list applies (never `default`, whose models chat). */
export const LLM_TASK_TYPES = ['default', 'chat', 'generation', 'translation', 'intent', 'constitution', 'decision', 'embedding'] as const;
export const LlmTaskTypeSchema = z.enum(LLM_TASK_TYPES);

/**
 * What each task type needs from every provider in its list: checked when
 * the list is saved, and again before each request. `default` stands in
 * for any type, so it must satisfy them all.
 */
export const LLM_TASK_REQUIREMENTS: Record<(typeof LLM_TASK_TYPES)[number], { tools: boolean; json: boolean }> = {
  default: { tools: true, json: false },
  chat: { tools: true, json: false },
  generation: { tools: false, json: false },
  translation: { tools: false, json: false },
  intent: { tools: false, json: false },
  constitution: { tools: false, json: false },
  decision: { tools: false, json: false },
  embedding: { tools: false, json: false },
};

export const LLM_SECRET_MASK = '••••••••';

/** An http(s) API root without credentials, query or fragment (a key must never hide in a URL). */
const baseUrl = z
  .string()
  .trim()
  .url()
  .refine((v) => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return false; // .url() reports it; a refinement must not throw
    }
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !u.hash;
  }, { message: 'Use an http(s) URL without credentials, query string or fragment.' })
  .transform((v) => v.replace(/\/+$/, ''));

const micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const LlmPricingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('per_1m_tokens'), inputMicros: micros, outputMicros: micros }),
  z.object({ kind: z.literal('per_request'), requestMicros: micros }),
]);

export const LlmCapabilitiesSchema = z.object({
  tools: z.boolean(),
  json: z.boolean(),
  /** Declared only; a probe cannot establish it. */
  maxContext: z.number().int().positive().nullable(),
});

/** ISO 4217 code. */
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, e.g. USD or CNY.');

const providerFields = {
  name: z.string().trim().min(1).max(100),
  baseUrl,
  model: z.string().trim().min(1).max(200),
  /** Write-only. On update: omit to keep, null to clear. */
  apiKey: z.string().min(1).max(1024).nullable().optional(),
  capabilities: LlmCapabilitiesSchema,
  pricing: LlmPricingSchema,
  currency: CurrencySchema,
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
};

export const LlmProviderCreateSchema = z.object({
  kind: z.literal('openai_compatible').default('openai_compatible'),
  ...providerFields,
});

/** Every field optional; `disabled` switches a provider off without deleting it. */
export const LlmProviderUpdateSchema = z
  .object({ ...providerFields, disabled: z.boolean() })
  .partial();

export const LlmProviderResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.literal('openai_compatible'),
  baseUrl: z.string(),
  model: z.string(),
  /** `LLM_SECRET_MASK` when a key is stored, otherwise null. Never the key. */
  apiKey: z.string().nullable(),
  capabilities: LlmCapabilitiesSchema,
  probe: z
    .object({
      at: z.string(),
      tools: z.object({ ok: z.boolean(), error: z.string().optional() }),
      json: z.object({ ok: z.boolean(), error: z.string().optional() }),
    })
    .nullable(),
  pricing: LlmPricingSchema,
  currency: z.string(),
  timeoutMs: z.number().int(),
  disabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** The ordered providers for one task type (first is the primary); empty removes the list. */
export const LlmRouteSetSchema = z.object({
  taskType: LlmTaskTypeSchema,
  providerIds: z
    .array(z.string().min(1))
    .max(5)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'A provider appears once per list.' }),
});

export const LlmSettingsSchema = z.object({
  currency: CurrencySchema,
  /** Null: no budget. */
  monthlyBudgetMicros: micros.nullable(),
  /** IANA time zone the budget month follows. */
  budgetTimezone: z.string().min(1).max(64).default('UTC'),
});

const evidence = z.string().trim().min(1, 'Say what the conclusion rests on (an invoice, the provider console, …).').max(2000);

/**
 * A person's conclusion on one attempt whose billing is unknown (design T9):
 * the actual cost, or that it was not billed. `version` is the one read.
 */
export const LlmReconcileSchema = z.discriminatedUnion('conclusion', [
  z.object({ conclusion: z.literal('settled'), actualMicros: micros, evidence, version: z.number().int().min(0) }),
  z.object({ conclusion: z.literal('cancelled'), evidence, version: z.number().int().min(0) }),
]);

/** Confirm a batch as not billed (e.g. a run of rate-limit errors): one provider, a time range. */
export const LlmReconcileBatchSchema = z
  .object({
    providerId: z.string().min(1).optional(),
    instanceRef: z.string().min(1).optional(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    errorCode: z.string().min(1).max(64).optional(),
    evidence,
  })
  .refine((b) => (b.providerId === undefined) !== (b.instanceRef === undefined), { message: 'Name one provider: providerId or instanceRef.' })
  .refine((b) => Date.parse(b.from) < Date.parse(b.to), { message: '`from` must be before `to`.' });

export const LLM_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export type LlmTaskType = z.infer<typeof LlmTaskTypeSchema>;
export type LlmPricing = z.infer<typeof LlmPricingSchema>;
export type LlmCapabilities = z.infer<typeof LlmCapabilitiesSchema>;
export type LlmProviderCreateInput = z.infer<typeof LlmProviderCreateSchema>;
export type LlmProviderUpdateInput = z.infer<typeof LlmProviderUpdateSchema>;
export type LlmProviderResource = z.infer<typeof LlmProviderResourceSchema>;
export type LlmRouteSetInput = z.infer<typeof LlmRouteSetSchema>;
export type LlmSettingsInput = z.infer<typeof LlmSettingsSchema>;
export type LlmReconcileInput = z.infer<typeof LlmReconcileSchema>;
export type LlmReconcileBatchInput = z.infer<typeof LlmReconcileBatchSchema>;
