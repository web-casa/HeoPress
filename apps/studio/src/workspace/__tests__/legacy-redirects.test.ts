import { describe, expect, it } from 'vitest';
import { LEGACY_RULES, legacyTarget } from '../legacy-redirects';

/** One row per rule: old address → new address (p07a task 2.4). */
const CASES: Array<[string, string, string]> = [
  ['/files', '', '/content/media'],
  ['/insights', '', '/overview/dashboards'],
  ['/insights/abc', '', '/overview/dashboards/abc'],
  ['/content/articles/reviews', '', '/content?view=pending&collection=articles'],
  ['/users', '', '/settings/members'],
  ['/users/teams', '', '/settings/advanced/teams'],
  ['/teams', '', '/settings/advanced/teams'],
  ['/access/roles/r1', '', '/settings/advanced/access/roles/r1'],
  ['/data-model/articles', '', '/settings/advanced/data-model/articles'],
  ['/automation/flows/new', '', '/settings/advanced/automation/flows/new'],
  ['/mission-control/inbox', '', '/monitoring/agents/inbox'],
  ['/mission-control/runs', '', '/settings/advanced/agent-harness'],
  ['/settings/site', '', '/settings/general'],
  ['/settings/domains', '', '/sites/domains'],
  ['/settings/content', '', '/seo/content'],
  ['/settings/identity', '', '/seo/identity'],
  ['/settings/root-files', '', '/seo/root-files'],
  ['/settings/audit', '', '/audit'],
  ['/settings/links', '', '/audit/links'],
  ['/settings/ai-traffic', '?days=30', '/ai-traffic?days=30'],
  ['/settings/reachability', '', '/monitoring/reachability'],
  ['/settings/activity', '', '/monitoring/activity'],
  ['/settings/translations', '', '/content/translations'],
  ['/settings/translation-memory', '', '/content/translation-memory'],
  ['/settings/webhooks', '?x=1', '/settings/advanced/webhooks?x=1'],
];

describe('legacy redirects', () => {
  it.each(CASES)('%s%s → %s', (from, search, to) => {
    expect(legacyTarget(from, search)).toBe(to);
  });

  it('every rule is covered by a case', () => {
    for (const rule of LEGACY_RULES) {
      expect(CASES.some(([from]) => rule.from.test(from)), rule.from.source).toBe(true);
    }
  });

  it('keeps the query and adds the rule query', () => {
    expect(legacyTarget('/content/news/reviews', '?q=x')).toBe('/content?q=x&view=pending&collection=news');
  });

  it('new addresses and unknown ones are not redirected', () => {
    expect(legacyTarget('/settings/general')).toBeNull();
    expect(legacyTarget('/settings/advanced/webhooks')).toBeNull();
    expect(legacyTarget('/overview')).toBeNull();
    expect(legacyTarget('/nowhere')).toBeNull();
  });
});
