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
  /** `research_leads`: created and managed for a primary-source host by research leads (HeoPress P08 task 1.7). */
  managedBy: z.enum(['research_leads']).nullable().optional(),
  consecutiveFailures: z.number().int(),
  lastFailureCategory: z.enum(FAILURE_CATEGORIES).nullable(),
  lastFailureMessage: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  /** The latest finished run's discovery counts (HeoPress P08 task 1.3); null before the first run. */
  lastRunStats: z
    .object({ discovered: z.number().int(), new: z.number().int(), duplicate: z.number().int(), stopReason: z.string().nullable() })
    .nullable()
    .optional(),
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
  itemsDiscovered: z.number().int(),
  itemsNew: z.number().int(),
  itemsDuplicate: z.number().int(),
  stopReason: z.string().nullable(),
});

export type IngestSourceCreateInput = z.infer<typeof IngestSourceCreateSchema>;
export type IngestSourceUpdateInput = z.infer<typeof IngestSourceUpdateSchema>;
export type IngestLicenceRevisionInput = z.input<typeof IngestLicenceRevisionSchema>;
export type IngestLicenceResource = z.infer<typeof IngestLicenceResourceSchema>;
export type IngestSourceResource = z.infer<typeof IngestSourceResourceSchema>;
export type IngestSourceRunResource = z.infer<typeof IngestSourceRunResourceSchema>;

// ── After registration (HeoPress P08 tasks 1.6, 1.7, 2.9) ─────────────────────

export const LICENCE_LAPSE_POLICIES = ['hide', 'flag'] as const;
export type LicenceLapsePolicy = (typeof LICENCE_LAPSE_POLICIES)[number];

/**
 * A primary-source pattern: a host (optionally `*.` for its subdomains) and an optional path prefix, an optional `*`
 * at the end — `example.com`, `*.example.org/docs/`, `example.com/releases/*`. No scheme, query or fragment.
 */
export const PRIMARY_SOURCE_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[^\s?#*]*)?\*?$/;

/** The site's ingestion settings (administrators). */
export const IngestSiteSettingsSchema = z
  .object({
    licenceLapsePolicy: z.enum(LICENCE_LAPSE_POLICIES),
    primarySourcePatterns: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .max(300)
          .refine((v) => PRIMARY_SOURCE_PATTERN.test(v), { message: 'Use host[/path-prefix], e.g. example.com/releases/ or *.example.org/docs/.' }),
      )
      .max(200)
      .transform((v) => [...new Set(v)]),
  })
  .strict();

export const IngestSiteSettingsResourceSchema = z.object({
  licenceLapsePolicy: z.enum(LICENCE_LAPSE_POLICIES),
  primarySourcePatterns: z.array(z.string()),
  updatedAt: z.string().nullable(),
});

export const LICENCE_LAPSE_REASONS = ['licence_expired', 'review_overdue', 'licence_not_started', 'licence_unknown', 'revoked'] as const;

export const LicenceReviewResourceSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  collection: z.string(),
  title: z.string().nullable(),
  sourceId: z.string(),
  sourceName: z.string().nullable(),
  reason: z.enum(LICENCE_LAPSE_REASONS),
  action: z.enum(['hidden', 'flagged']),
  state: z.enum(['open', 'restored', 'dismissed']),
  /** Whether every source the item derives from is effective again now (a restore needs it). */
  licenceEffective: z.boolean(),
  detectedAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
});

/** Restore (public again) or dismiss (leave as it is) open reviews, one or many. */
export const LicenceReviewResolveSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(200),
    decision: z.enum(['restore', 'dismiss']),
  })
  .strict();

export const ResearchLeadResourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  matchedPattern: z.string(),
  status: z.enum(['pending', 'queued', 'refused']),
  reason: z.string().nullable(),
  originSourceId: z.string(),
  originDocumentId: z.string(),
  leadSourceId: z.string().nullable(),
  createdAt: z.string(),
});

export const MEDIA_USES = ['copy'] as const;

/** A media item's own licence (administrators): without one it is never copied. */
export const IngestMediaLicenceSchema = z
  .object({
    url: httpUrl,
    evidence: z.string().trim().min(1).max(4000),
    attribution: z.string().trim().max(1000).nullable().optional(),
    allowedUses: z.array(z.enum(MEDIA_USES)).min(1),
    validUntil: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export type IngestSiteSettingsInput = z.infer<typeof IngestSiteSettingsSchema>;
export type IngestSiteSettingsResource = z.infer<typeof IngestSiteSettingsResourceSchema>;
export type LicenceReviewResource = z.infer<typeof LicenceReviewResourceSchema>;
export type ResearchLeadResource = z.infer<typeof ResearchLeadResourceSchema>;
