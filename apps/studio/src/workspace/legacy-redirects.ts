/**
 * Old Studio addresses → their place in the Carbon workspace (ADR-0019 §2,
 * p07a task 2.4). Paths are app-internal (no private admin prefix); the query
 * string is kept. The first matching rule wins; an address no rule matches is
 * left to the router (404).
 */
export interface LegacyRule {
  /** `^…$` over the app-internal path; capture groups feed `to`. */
  from: RegExp;
  /** Target path; `$1`, `$2` … are the captures. */
  to: string;
  /** Extra query parameters, `$n` allowed. */
  query?: Record<string, string>;
}

export const LEGACY_RULES: readonly LegacyRule[] = [
  { from: /^\/files\/?$/, to: '/content/media' },
  { from: /^\/insights\/?$/, to: '/overview/dashboards' },
  { from: /^\/insights\/([^/]+)\/?$/, to: '/overview/dashboards/$1' },
  { from: /^\/content\/([^/]+)\/reviews\/?$/, to: '/content', query: { view: 'pending', collection: '$1' } },
  { from: /^\/users\/?$/, to: '/settings/members' },
  { from: /^\/users\/teams\/?$/, to: '/settings/advanced/teams' },
  { from: /^\/teams\/?$/, to: '/settings/advanced/teams' },
  { from: /^\/access(\/.*)?$/, to: '/settings/advanced/access$1' },
  { from: /^\/data-model(\/.*)?$/, to: '/settings/advanced/data-model$1' },
  { from: /^\/automation(\/.*)?$/, to: '/settings/advanced/automation$1' },
  // Agent-run notifications link to the old runs list (apps/cms agent-run-service): the run history is the agent harness page.
  { from: /^\/mission-control\/runs\/?$/, to: '/settings/advanced/agent-harness' },
  { from: /^\/mission-control(\/.*)?$/, to: '/monitoring/agents$1' },
  { from: /^\/settings\/site\/?$/, to: '/settings/general' },
  { from: /^\/settings\/domains\/?$/, to: '/sites/domains' },
  { from: /^\/settings\/content\/?$/, to: '/seo/content' },
  { from: /^\/settings\/identity\/?$/, to: '/seo/identity' },
  { from: /^\/settings\/root-files\/?$/, to: '/seo/root-files' },
  { from: /^\/settings\/audit\/?$/, to: '/audit' },
  { from: /^\/settings\/links\/?$/, to: '/audit/links' },
  { from: /^\/settings\/ai-traffic\/?$/, to: '/ai-traffic' },
  { from: /^\/settings\/reachability\/?$/, to: '/monitoring/reachability' },
  { from: /^\/settings\/activity\/?$/, to: '/monitoring/activity' },
  { from: /^\/settings\/translations\/?$/, to: '/content/translations' },
  { from: /^\/settings\/translation-memory\/?$/, to: '/content/translation-memory' },
  // Every other old settings page lives on under Settings › Advanced.
  { from: /^\/settings\/(?!general|appearance|members|api-keys|license|advanced)(.+)$/, to: '/settings/advanced/$1' },
];

const sub = (template: string, match: RegExpExecArray) =>
  template.replace(/\$(\d)/g, (_, n: string) => match[Number(n)] ?? '');

/** The new address for an old one (path + query), or `null` when it is not an old address. */
export function legacyTarget(appPath: string, search = '', rules: readonly LegacyRule[] = LEGACY_RULES): string | null {
  for (const rule of rules) {
    const match = rule.from.exec(appPath);
    if (!match) continue;
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    for (const [key, value] of Object.entries(rule.query ?? {})) params.set(key, sub(value, match));
    const query = params.toString();
    return `${sub(rule.to, match).replace(/\/$/, '') || '/'}${query ? `?${query}` : ''}`;
  }
  return null;
}
