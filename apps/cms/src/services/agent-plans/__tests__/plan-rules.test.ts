import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canarySites, isHighRiskOperation, itemProblems, planHash, requiredApprovals, tierFor, type HashInput } from '../plan-rules';

/** HeoPress P10 task 3.1: the tier boundaries at 10 / 25 / 50 sites and high-risk operations. */
describe('plan tiers', () => {
  it.each([
    [1, 'low', false, false],
    [10, 'low', false, false],
    [11, 'preview', true, false],
    [25, 'preview', true, false],
    [26, 'canary', true, true],
    [50, 'canary', true, true],
    [51, 'highest', true, true],
    [200, 'highest', true, true],
  ] as const)('%i sites of content_update → %s', (n, tier, preview, canary) => {
    const d = tierFor('content_update', n);
    expect(d).toMatchObject({ tier, requiresPreview: preview, requiresCanary: canary, highRisk: false });
    expect(d.canaryCount).toBe(canary ? 2 : 0);
  });

  it('a high-risk operation is highest and has a canary even on one site', () => {
    for (const op of ['content_delete', 'theme_activate', 'domain_update', 'dns_record_set', 'permissions_update', 'roles_assign']) {
      expect(isHighRiskOperation(op)).toBe(true);
      expect(tierFor(op, 1)).toMatchObject({ tier: 'highest', highRisk: true, requiresCanary: true, canaryCount: 1 });
      expect(tierFor(op, 30)).toMatchObject({ tier: 'highest', canaryCount: 2 });
    }
    for (const op of ['content_update', 'content_publish', 'content_create', 'site_update_seo_settings']) expect(isHighRiskOperation(op)).toBe(false);
  });

  it('team mode needs a second approver only for the highest tier', () => {
    expect(requiredApprovals('team', 'highest')).toBe(2);
    expect(requiredApprovals('team', 'canary')).toBe(1);
    expect(requiredApprovals('solo', 'highest')).toBe(1);
  });

  it('the tier never decreases as sites are added (property)', () => {
    const rank = { low: 0, preview: 1, canary: 2, highest: 3 } as const;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 499 }), fc.constantFrom('content_update', 'content_delete'), (n, op) => rank[tierFor(op, n + 1).tier] >= rank[tierFor(op, n).tier]),
    );
  });

  it('changes to existing resources need their expected version', () => {
    expect(itemProblems('content_update', { collection: 'articles', id: 'x', data: {} })).toContain('expectedVersion is required');
    expect(itemProblems('content_update', { collection: 'articles', id: 'x', data: {}, expectedVersion: 0 })).toContain('expectedVersion must be a positive integer');
    expect(itemProblems('content_create', { collection: 'articles', data: { title: 't' } })).toEqual([]);
    expect(itemProblems('sites_create', {})).toEqual(['"sites_create" cannot run in a plan.']);
  });

  it('canaries are the first sorted sites', () => {
    expect(canarySites(['c', 'a', 'b'], 2)).toEqual(['a', 'b']);
  });
});

describe('plan hash', () => {
  const base: HashInput = {
    id: 'p1',
    operation: 'content_update',
    arguments: { collection: 'articles', data: { title: 'T' } },
    items: [
      { siteId: 'a', arguments: { id: '1', expectedVersion: 2 }, canary: false },
      { siteId: 'b', arguments: { id: '2', expectedVersion: 5 }, canary: false },
    ],
    draftedBy: 'u1',
    grantId: 'g1',
    revision: 1,
    riskTier: 'low',
    approvalMode: 'solo',
    expiresAt: new Date('2026-11-01T00:00:00Z'),
  };

  it('ignores key and item order', () => {
    const reordered = { ...base, items: [...base.items].reverse(), arguments: { data: { title: 'T' }, collection: 'articles' } };
    expect(planHash(reordered)).toBe(planHash(base));
  });

  it('changes with every substantive change', () => {
    const h = planHash(base);
    const variants: HashInput[] = [
      { ...base, items: [...base.items, { siteId: 'c', arguments: { id: '3', expectedVersion: 1 }, canary: false }] },
      { ...base, items: [base.items[0]!, { ...base.items[1]!, arguments: { id: '2', expectedVersion: 6 } }] },
      { ...base, arguments: { ...base.arguments, data: { title: 'U' } } },
      { ...base, draftedBy: 'u2' },
      { ...base, revision: 2 },
      { ...base, approvalMode: 'team' },
      { ...base, expiresAt: new Date('2026-11-02T00:00:00Z') },
      { ...base, operation: 'content_publish' },
    ];
    for (const v of variants) expect(planHash(v)).not.toBe(h);
  });
});
