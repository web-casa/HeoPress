/**
 * Whether a site's crawler policy blocks a crawler (HeoPress P07a task 7.3) — the rule `crawlerAllowed` applies in
 * `@heopress/seo-geo` (P07 task 3.2), read here from the settings Studio already has: the crawler's own override, else
 * its purpose's decision; search engines are never blocked by purpose.
 */
export interface CrawlerPolicy {
  purposes: Partial<Record<string, 'allow' | 'disallow'>>;
  overrides: Record<string, 'allow' | 'disallow'>;
}

export function isBlocked(policy: CrawlerPolicy, agent: string, purpose: string | null): boolean {
  const own = policy.overrides[agent];
  if (own) return own === 'disallow';
  if (!purpose || purpose === 'search-engine') return false;
  return policy.purposes[purpose] === 'disallow';
}
