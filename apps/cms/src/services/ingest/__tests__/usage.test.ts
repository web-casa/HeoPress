import { describe, expect, it } from 'vitest';
import { USAGE_OPERATIONS } from '@heopress/contracts/schemas';
import { assertUsageAllowed, effectiveUsage, isLicenceEffective, type SourceTerms } from '../usage';

/** The usage contract P09 calls before each processing step (HeoPress P08 tasks 1.4, 1.5). */

const now = new Date('2026-10-26T00:00:00Z');
const terms = (t: Partial<SourceTerms>): SourceTerms => ({ licenceStatus: 'unknown', usageMode: 'discovery_only', reviewDueAt: null, ...t });
const derivative = terms({ licenceStatus: 'licensed', usageMode: 'licensed_derivative', licenceValidUntil: '2027-01-01T00:00:00Z', reviewDueAt: '2026-12-01T00:00:00Z' });

describe('assertUsageAllowed', () => {
  it('a discovery-only source: translating a document from it is refused with a reason; only the lead is usable', () => {
    const d = assertUsageAllowed(terms({}), 'translate', now);
    expect(d).toEqual({ allowed: false, operation: 'translate', reason: 'usage_mode_forbids', usageMode: 'discovery_only', reviewRequired: false });
    expect(assertUsageAllowed(terms({}), 'rewrite', now).allowed).toBe(false);
    expect(assertUsageAllowed(terms({}), 'extract_facts', now).allowed).toBe(false);
    expect(assertUsageAllowed(terms({}), 'use_as_lead', now)).toEqual({ allowed: true, operation: 'use_as_lead', usageMode: 'discovery_only' });
  });

  it('facts only: facts and the lead, never the wording', () => {
    const t = terms({ licenceStatus: 'open-license', usageMode: 'facts_only' });
    expect(USAGE_OPERATIONS.filter((op) => assertUsageAllowed(t, op, now).allowed)).toEqual(['use_as_lead', 'extract_facts']);
  });

  it('licensed derivative: everything while the licence is in effect', () => {
    expect(USAGE_OPERATIONS.every((op) => assertUsageAllowed(derivative, op, now).allowed)).toBe(true);
  });

  it('an expired licence: derivative use refused and sent to review; the lead stays', () => {
    const later = new Date('2027-02-01T00:00:00Z');
    const t = { ...derivative, reviewDueAt: null };
    expect(assertUsageAllowed(t, 'translate', later)).toEqual({ allowed: false, operation: 'translate', reason: 'licence_expired', usageMode: 'discovery_only', reviewRequired: true });
    expect(assertUsageAllowed(t, 'use_as_lead', later).allowed).toBe(true);
    expect(isLicenceEffective(t, later)).toBe(false);
    expect(effectiveUsage(t, later)).toBe('discovery_only');
  });

  it('an overdue review: refused with review_overdue', () => {
    const d = assertUsageAllowed(derivative, 'rewrite', new Date('2026-12-01T00:00:00Z'));
    expect(d).toMatchObject({ allowed: false, reason: 'review_overdue', reviewRequired: true });
  });

  it('a licence not started yet, or derivative use with no known licence: refused', () => {
    expect(assertUsageAllowed({ ...derivative, licenceValidFrom: '2026-11-01T00:00:00Z' }, 'translate', now)).toMatchObject({ allowed: false, reason: 'licence_not_started' });
    expect(assertUsageAllowed({ ...derivative, licenceStatus: 'unknown' }, 'translate', now)).toMatchObject({ allowed: false, reason: 'licence_unknown' });
  });

  it('unknown terms fail closed, as a value', () => {
    expect(assertUsageAllowed(terms({ usageMode: 'anything' }), 'use_as_lead', now)).toMatchObject({ allowed: false, reason: 'unknown_terms', usageMode: 'discovery_only' });
    expect(effectiveUsage(terms({ usageMode: 'anything' }), now)).toBe('discovery_only');
  });

  it('dates may be Date objects (source rows) or ISO strings (resources)', () => {
    const rowLike = { ...derivative, licenceValidUntil: new Date('2026-10-25T00:00:00Z'), reviewDueAt: null };
    expect(assertUsageAllowed(rowLike, 'translate', now)).toMatchObject({ allowed: false, reason: 'licence_expired' });
  });
});
