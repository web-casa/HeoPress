import { z } from 'zod';

/**
 * External crawl services per site (HeoPress P08 tasks 3.2–3.6, spec ingest/crawling "外部采集服务插件",
 * "采集服务预算与熔断"): shared by the CMS (validation) and Studio (forms).
 *
 * The credential is write-only: an update may set it (`credential`) or clear it (`credential: null`); a resource only
 * says whether one is set and its last four characters. `consent: true` records that an administrator confirmed the
 * site's target URLs may be sent to the service; a service is never used without it.
 */
export const CRAWL_PROVIDER_IDS = ['tinyfish', 'firecrawl', 'crawl4ai', 'cloudflare'] as const;
export type CrawlProviderId = (typeof CRAWL_PROVIDER_IDS)[number];

/** A fallback chain step: the native fetcher or a service. */
export const FETCH_CHAIN_STEPS = ['native', ...CRAWL_PROVIDER_IDS] as const;
export type FetchChainStep = (typeof FETCH_CHAIN_STEPS)[number];

export const IngestProviderUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    position: z.number().int().min(0).max(100).optional(),
    consent: z.boolean().optional(),
    credential: z.string().trim().min(1).max(4000).nullable().optional(),
    endpoint: z
      .string()
      .trim()
      .url()
      .refine((v) => /^https?:\/\//i.test(v), { message: 'Use an http(s) URL.' })
      .nullable()
      .optional(),
    accountId: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{32}$/i, { message: 'A Cloudflare account id is 32 hexadecimal characters.' })
      .nullable()
      .optional(),
    /** Monthly ceiling of the estimated cost in USD (null: no ceiling). */
    monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  })
  .strict();

export const IngestProviderResourceSchema = z.object({
  provider: z.enum(CRAWL_PROVIDER_IDS),
  enabled: z.boolean(),
  position: z.number(),
  consentAt: z.string().nullable(),
  credentialSet: z.boolean(),
  credentialHint: z.string().nullable(),
  credentialKind: z.enum(['api_key', 'api_token', 'optional_token']),
  hosts: z.array(z.string()),
  endpoint: z.string().nullable(),
  accountId: z.string().nullable(),
  monthlyBudgetUsd: z.number().nullable(),
  pausedUntil: z.string().nullable(),
  usage: z.object({ month: z.string(), requests: z.number(), failures: z.number(), costUsd: z.number(), exhausted: z.boolean() }),
  /** Why the service would be skipped now (null: usable). */
  unavailableReason: z.enum(['disabled', 'no_consent', 'no_credential', 'missing_option', 'budget_exhausted', 'breaker_open']).nullable(),
});

export const IngestFetchChainSchema = z
  .object({
    /** null: back to the site's default chain. */
    chain: z
      .array(z.enum(FETCH_CHAIN_STEPS))
      .min(1)
      .max(FETCH_CHAIN_STEPS.length)
      .refine((v) => new Set(v).size === v.length, { message: 'A step may appear once.' })
      .nullable(),
  })
  .strict();

export type IngestProviderUpdateInput = z.infer<typeof IngestProviderUpdateSchema>;
export type IngestProviderResource = z.infer<typeof IngestProviderResourceSchema>;
export type IngestFetchChainInput = z.infer<typeof IngestFetchChainSchema>;
