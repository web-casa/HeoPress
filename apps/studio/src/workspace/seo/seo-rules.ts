import type { SiteSeoSettings } from '@heopress/contracts/schemas';

/**
 * The SEO / GEO module's pure rules (HeoPress P07a tasks 8.2–8.4; spec studio/seo-settings): what changed, what is wrong,
 * the crawler presets, and what a policy means for AI search and training — all computed in the page, so previewing never
 * saves anything.
 */

export type Purpose = 'training' | 'search' | 'user-fetch';
export type CrawlerPreset = 'allowAll' | 'searchOnly' | 'blockAll';

export const PRESETS: Record<CrawlerPreset, Record<Purpose, 'allow' | 'disallow'>> = {
  allowAll: { training: 'allow', search: 'allow', 'user-fetch': 'allow' },
  searchOnly: { training: 'disallow', search: 'allow', 'user-fetch': 'allow' },
  blockAll: { training: 'disallow', search: 'disallow', 'user-fetch': 'disallow' },
};

/** The preset a policy matches (an unset purpose is allowed, as robots.txt reads it), or null when it is custom. */
export function presetOf(purposes: Partial<Record<Purpose, 'allow' | 'disallow'>>): CrawlerPreset | null {
  const effective = (p: Purpose) => purposes[p] ?? 'allow';
  for (const [name, policy] of Object.entries(PRESETS) as Array<[CrawlerPreset, Record<Purpose, string>]>) {
    if ((Object.keys(policy) as Purpose[]).every((p) => effective(p) === policy[p])) return name;
  }
  return null;
}

/** What the policy means: whether AI assistants may read and cite the site's articles, and whether models may train on them. */
export function crawlerMeaning(purposes: Partial<Record<Purpose, 'allow' | 'disallow'>>): { cite: 'yes' | 'partly' | 'no'; train: boolean } {
  const search = (purposes.search ?? 'allow') === 'allow';
  const fetch = (purposes['user-fetch'] ?? 'allow') === 'allow';
  return { cite: search && fetch ? 'yes' : search || fetch ? 'partly' : 'no', train: (purposes.training ?? 'allow') === 'allow' };
}

/** `{title}`, `{site}`, `{description}` filled as the public pages fill them (packages/seo-geo `applyTemplate`). */
export function applyTemplate(template: string, values: { title?: string; site?: string; description?: string }): string {
  return template.replace(/\{(title|site|description)\}/g, (_m, key: 'title' | 'site' | 'description') => values[key] ?? '').replace(/\s+/g, ' ').trim();
}

/** The settings as they act: an unset crawler purpose is allowed (robots.txt reads it so), so setting it to "allow" is no change. */
export function effectiveForDiff(s: SiteSeoSettings): SiteSeoSettings {
  const purposes = Object.fromEntries((['training', 'search', 'user-fetch'] as Purpose[]).map((p) => [p, s.crawlers.purposes[p] ?? 'allow']));
  return { ...s, crawlers: { ...s.crawlers, purposes } };
}

/** Paths of the leaves that differ (`crawlers.purposes.training`, …): the unsaved count. */
export function changedPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => changedPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) ? [] : [prefix || '/'];
}

export type SeoErrors = Partial<Record<'titleTemplate' | 'descriptionTemplate' | 'newsPublicationName' | 'custom', string>>;

/** Field errors, as message keys of the `seo` namespace. */
export function validateSeo(s: SiteSeoSettings): SeoErrors {
  const errors: SeoErrors = {};
  if (s.titleTemplate.length > 200) errors.titleTemplate = 'errors.tooLong';
  else if (s.titleTemplate.trim() && !s.titleTemplate.includes('{title}')) errors.titleTemplate = 'errors.needsTitle';
  if (s.descriptionTemplate.length > 200) errors.descriptionTemplate = 'errors.tooLong';
  if (s.discovery.newsSitemap && !s.discovery.newsPublicationName.trim()) errors.newsPublicationName = 'errors.publicationName';
  const tokens = s.crawlers.custom.map((c) => c.userAgent);
  if (s.crawlers.custom.some((c) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c.userAgent))) errors.custom = 'errors.token';
  else if (new Set(tokens).size !== tokens.length) errors.custom = 'errors.duplicate';
  return errors;
}

/** A canonical hostname must be one of the site's active domains (spec "无效的规范域名"). */
export function canonicalError(hostname: string, bound: string[]): 'errors.notBound' | null {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '');
  return h && !bound.includes(h) ? 'errors.notBound' : null;
}
