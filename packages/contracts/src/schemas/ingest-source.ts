import { z } from 'zod';

/**
 * Content sources (HeoPress P08, spec ingest/sources): shared by the CMS
 * (validation) and Studio (forms).
 *
 * A source's terms — licence status, usage mode, commercial use, review due
 * date, trust level — are changed only through a licence revision
 * (`IngestLicenceRevisionSchema`), which only a site administrator may
 * record. Creating a source never sets them: a new source is `unknown` /
 * `discovery_only` / not commercial / `low` trust.
 */

export const INGEST_SOURCE_TYPES = ['rss', 'atom', 'sitemap', 'list_page', 'url'] as const;
export const LICENCE_STATUSES = ['unknown', 'licensed', 'own', 'open-license'] as const;
export const USAGE_MODES = ['discovery_only', 'facts_only', 'licensed_derivative'] as const;
export const TRUST_LEVELS = ['low', 'medium', 'high'] as const;
export const SOURCE_STATUSES = ['active', 'paused'] as const;
/**
 * Why a run or fetch failed. `access_denied` (401 / 403 / 451, robots.txt, an explicit no-AI / TDM reservation) and
 * `blocked` (the outbound security boundary refused the address) are terminal: no retry, no other crawl service.
 * `network`, `timeout` and `extraction` are technical and may be retried or handed to the next service.
 */
export const FAILURE_CATEGORIES = ['network', 'timeout', 'access_denied', 'blocked', 'extraction', 'quota', 'other'] as const;
/** What a processing step wants to do with a source document (checked by `assertUsageAllowed`). */
export const USAGE_OPERATIONS = ['use_as_lead', 'extract_facts', 'translate', 'rewrite'] as const;

export type IngestSourceType = (typeof INGEST_SOURCE_TYPES)[number];
export type LicenceStatus = (typeof LICENCE_STATUSES)[number];
export type UsageMode = (typeof USAGE_MODES)[number];
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
export type UsageOperation = (typeof USAGE_OPERATIONS)[number];

/** Most runs a day a source may have (one per listed time). */
export const MAX_SCHEDULE_TIMES = 24;
/** Upper bound of `maxItemsPerRun`. */
export const MAX_ITEMS_PER_RUN = 200;

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), { message: 'Use an http(s) URL.' });

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Use HH:MM (24-hour).' });

/** True when `tz` is an IANA time zone this runtime knows. */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const selector = z.string().trim().min(1).max(500);
export const ListSelectorsSchema = z.object({
  item: selector,
  link: selector,
  title: selector.optional(),
  nextPage: selector.optional(),
});

const sourceFields = {
  name: z.string().trim().min(1).max(120),
  type: z.enum(INGEST_SOURCE_TYPES),
  url: httpUrl,
  listSelectors: ListSelectorsSchema.nullable().optional(),
  scheduleTimes: z
    .array(timeOfDay)
    .min(1)
    .max(MAX_SCHEDULE_TIMES)
    .transform((v) => [...new Set(v)].sort()),
  timezone: z.string().trim().refine(isKnownTimeZone, { message: 'Not a known time zone.' }),
  maxItemsPerRun: z.number().int().min(1).max(MAX_ITEMS_PER_RUN).optional(),
};

const listPageNeedsSelectors = (v: { type?: IngestSourceType; listSelectors?: unknown }, ctx: z.RefinementCtx) => {
  if (v.type === 'list_page' && !v.listSelectors) {
    ctx.addIssue({ code: 'custom', path: ['listSelectors'], message: 'A list page needs CSS selectors for its items and links.' });
  }
};

/** A new source. The terms are not accepted here (they start at their defaults). */
export const IngestSourceCreateSchema = z.object(sourceFields).strict().superRefine(listPageNeedsSelectors);

/** Every field optional; the terms are not accepted here (see the licence revision). */
export const IngestSourceUpdateSchema = z.object(sourceFields).partial().strict();

/** A licence revision: the new terms and their evidence. Administrators only. */
export const IngestLicenceRevisionSchema = z
  .object({
    licenceStatus: z.enum(LICENCE_STATUSES),
    usageMode: z.enum(USAGE_MODES),
    commercialUse: z.boolean().default(false),
    trustLevel: z.enum(TRUST_LEVELS).default('low'),
    evidence: z.string().trim().max(4000).nullable().optional(),
    scope: z.string().trim().max(2000).nullable().optional(),
    validFrom: z.string().datetime({ offset: true }).nullable().optional(),
    validUntil: z.string().datetime({ offset: true }).nullable().optional(),
    reviewDueAt: z.string().datetime({ offset: true }).nullable().optional(),
    attribution: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.validFrom && v.validUntil && Date.parse(v.validUntil) <= Date.parse(v.validFrom)) {
      ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'The licence must end after it starts.' });
    }
    if (v.usageMode === 'licensed_derivative' && (v.licenceStatus === 'unknown' || !v.evidence)) {
      ctx.addIssue({ code: 'custom', path: ['usageMode'], message: 'Derivative use needs a known licence and its evidence.' });
    }
  });

export const IngestLicenceResourceSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  licenceStatus: z.enum(LICENCE_STATUSES),
  usageMode: z.enum(USAGE_MODES),
  commercialUse: z.boolean(),
  trustLevel: z.enum(TRUST_LEVELS),
  evidence: z.string().nullable(),
  scope: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  reviewDueAt: z.string().nullable(),
  attribution: z.string().nullable(),
  setBy: z.string().nullable(),
  createdAt: z.string(),
});

export const IngestSourceResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(INGEST_SOURCE_TYPES),
  url: z.string(),
  listSelectors: ListSelectorsSchema.nullable(),
  scheduleTimes: z.array(z.string()),
  timezone: z.string(),
  maxItemsPerRun: z.number().int(),
  licenceStatus: z.enum(LICENCE_STATUSES),
  usageMode: z.enum(USAGE_MODES),
  commercialUse: z.boolean(),
  reviewDueAt: z.string().nullable(),
  trustLevel: z.enum(TRUST_LEVELS),
  attribution: z.string().nullable(),
  /** The current licence revision's validity (null: none or open-ended). */
  licenceValidUntil: z.string().nullable(),
  /** Whether the terms are in effect now (not expired, review not overdue). */
  licenceEffective: z.boolean(),
  /** The usage mode in effect now: `discovery_only` while the licence is not effective. */
  effectiveUsageMode: z.enum(USAGE_MODES),
  status: z.enum(SOURCE_STATUSES),
  pausedReason: z.enum(['manual', 'failures']).nullable(),
  consecutiveFailures: z.number().int(),
  lastFailureCategory: z.enum(FAILURE_CATEGORIES).nullable(),
  lastFailureMessage: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const IngestSourceRunResourceSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  scheduledFor: z.string(),
  trigger: z.enum(['scheduled', 'manual']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outcome: z.enum(['running', 'succeeded', 'failed', 'skipped']),
  failureCategory: z.enum(FAILURE_CATEGORIES).nullable(),
  message: z.string().nullable(),
  itemsFound: z.number().int(),
});

export type IngestSourceCreateInput = z.infer<typeof IngestSourceCreateSchema>;
export type IngestSourceUpdateInput = z.infer<typeof IngestSourceUpdateSchema>;
export type IngestLicenceRevisionInput = z.input<typeof IngestLicenceRevisionSchema>;
export type IngestLicenceResource = z.infer<typeof IngestLicenceResourceSchema>;
export type IngestSourceResource = z.infer<typeof IngestSourceResourceSchema>;
export type IngestSourceRunResource = z.infer<typeof IngestSourceRunResourceSchema>;
