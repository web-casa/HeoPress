import { z } from 'zod';
import { LocaleTagSchema, canonicalLocale, sameLocale } from './locale-tag';

export { LocaleTagSchema, canonicalLocale, sameLocale };

/**
 * Site content settings (HeoPress P05, spec content/site-network-model and
 * i18n/locale-routing): languages, time zone, site type, URL policy and the
 * per-collection permalink patterns. Shared by the CMS (validation) and
 * Studio (forms).
 */

/** Variables a permalink pattern may use. */
export const PERMALINK_VARIABLES = ['slug', 'id', 'year', 'month', 'day', 'category', 'collection'] as const;
export type PermalinkVariable = (typeof PERMALINK_VARIABLES)[number];

export type PermalinkSegment = { kind: 'literal'; value: string } | { kind: 'variable'; name: PermalinkVariable };

/** A path segment written literally in a pattern or used as a locale prefix. */
const LITERAL_SEGMENT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Parse a permalink pattern such as `/:year/:month/:day/:slug` into its
 * segments. A pattern starts with `/`, has no empty segments, uses only
 * known variables (each at most once) and literal segments of lowercase
 * letters, digits and hyphens, and contains `:slug` or `:id` — otherwise two
 * items could share a path by construction. A trailing slash is the site's
 * policy, not the pattern's, and is ignored.
 */
export function parsePermalinkPattern(pattern: string): { ok: true; segments: PermalinkSegment[] } | { ok: false; error: string } {
  if (!pattern.startsWith('/')) return { ok: false, error: 'A permalink pattern starts with "/".' };
  const parts = pattern.replace(/\/+$/, '').split('/').slice(1);
  if (parts.length === 0 || parts.some((p) => p === '')) return { ok: false, error: 'A permalink pattern has no empty segments.' };
  const segments: PermalinkSegment[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.startsWith(':')) {
      const name = part.slice(1);
      if (!(PERMALINK_VARIABLES as readonly string[]).includes(name)) {
        return { ok: false, error: `Unknown permalink variable ":${name}" (use ${PERMALINK_VARIABLES.map((v) => `:${v}`).join(', ')}).` };
      }
      if (seen.has(name)) return { ok: false, error: `":${name}" appears more than once.` };
      seen.add(name);
      segments.push({ kind: 'variable', name: name as PermalinkVariable });
    } else {
      if (!LITERAL_SEGMENT.test(part)) return { ok: false, error: `"${part}" is not a valid path segment (lowercase letters, digits and hyphens).` };
      segments.push({ kind: 'literal', value: part });
    }
  }
  if (!seen.has('slug') && !seen.has('id')) return { ok: false, error: 'A permalink pattern contains :slug or :id.' };
  return { ok: true, segments };
}

export const PermalinkPatternSchema = z.string().trim().min(2).max(200).superRefine((value, ctx) => {
  const parsed = parsePermalinkPattern(value);
  if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.error });
});

/** A locale's path prefix under the subdirectory strategy (`zh`, `zh-cn`, `pt-br`). */
export const LocalePrefixSchema = z
  .string()
  .trim()
  .min(2)
  .max(16)
  .regex(LITERAL_SEGMENT, 'A language prefix is lowercase letters, digits and hyphens, e.g. zh-cn.');

export const SITE_TYPES = ['blog', 'news', 'docs', 'catalog', 'other'] as const;

export const SiteContentSettingsSchema = z
  .object({
    availableLocales: z.array(LocaleTagSchema).min(1).max(50),
    /** Validated as an IANA time zone by the CMS. */
    timezone: z.string().trim().min(1).max(64),
    siteType: z.enum(SITE_TYPES),
    trailingSlash: z.enum(['always', 'never']),
    localeStrategy: z.enum(['subdirectory', 'subdomain', 'domain']),
    localePrefixMode: z.enum(['default_at_root', 'all_prefixed']),
    // Keys as sent: canonicalised below, where two spellings of one language are refused instead of one silently winning.
    localePrefixes: z.record(z.string().trim().min(2).max(35), LocalePrefixSchema),
    permalinks: z.record(z.string().trim().min(1).max(64), PermalinkPatternSchema),
    allowCrossSiteTranslations: z.boolean(),
    sponsorDisclosure: z.boolean(),
    sponsorRel: z.boolean(),
    /** The version read (conditional update). */
    version: z.number().int().min(1),
    /** Why the sponsor policy changed (required when it changes). */
    reason: z.string().trim().min(1).max(2000).optional(),
    /** The risks acknowledged when switching a sponsor policy off. */
    riskAcknowledged: z.array(z.enum(['disclosure', 'rel'])).optional(),
  })
  .superRefine((value, ctx) => {
    const lower = value.availableLocales.map((l) => l.toLowerCase());
    if (new Set(lower).size !== lower.length) ctx.addIssue({ code: 'custom', path: ['availableLocales'], message: 'A language appears once.' });
    const seenKeys = new Map<string, string>();
    for (const locale of Object.keys(value.localePrefixes)) {
      const canonical = canonicalLocale(locale);
      if (!canonical) {
        ctx.addIssue({ code: 'custom', path: ['localePrefixes', locale], message: `"${locale}" is not a BCP 47 language tag.` });
        continue;
      }
      const other = seenKeys.get(canonical.toLowerCase());
      if (other !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['localePrefixes', locale], message: `"${other}" and "${locale}" are the same language; give it one prefix.` });
      }
      seenKeys.set(canonical.toLowerCase(), locale);
      if (!value.availableLocales.some((l) => sameLocale(l, locale))) {
        ctx.addIssue({ code: 'custom', path: ['localePrefixes', locale], message: `"${locale}" is not one of the site's languages.` });
      }
    }
    const prefixes = Object.values(value.localePrefixes);
    if (new Set(prefixes).size !== prefixes.length) ctx.addIssue({ code: 'custom', path: ['localePrefixes'], message: 'Each language has its own prefix.' });
  })
  .transform((value) => ({
    ...value,
    localePrefixes: Object.fromEntries(Object.entries(value.localePrefixes).map(([locale, prefix]) => [canonicalLocale(locale)!, prefix])),
  }));

export type SiteContentSettingsInput = z.infer<typeof SiteContentSettingsSchema>;
