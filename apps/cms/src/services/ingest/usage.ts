import type { LicenceStatus, UsageMode, UsageOperation } from '@heopress/contracts/schemas';

/**
 * What may be done with a source's content (HeoPress P08 tasks 1.4, 1.5;
 * spec ingest/sources "信源使用方式", "来源授权可核验"). The contract P09's
 * processing steps call before each operation.
 *
 *   - `discovery_only`: the title and link are a lead (`use_as_lead`), nothing more;
 *   - `facts_only`: facts may be extracted and written up originally (`extract_facts`, `use_as_lead`);
 *   - `licensed_derivative`: translation and rewriting too — but only while the
 *     licence is effective: started, not past its validity, its review not
 *     overdue. Otherwise the source falls back to `discovery_only` and the
 *     refusal says `review_required`.
 *
 * Never throws: a refusal is a value with a reason code, recorded by the caller.
 */

/** The terms of a source as this check needs them (a source row, or a source document's copy of them). */
export interface SourceTerms {
  licenceStatus: LicenceStatus | string;
  usageMode: UsageMode | string;
  reviewDueAt: Date | string | null;
  licenceValidFrom?: Date | string | null;
  licenceValidUntil?: Date | string | null;
}

type UsageRefusalReason =
  /** The usage mode never allows the operation. */
  | 'usage_mode_forbids'
  /** The licence ran out (`licenceValidUntil` passed). */
  | 'licence_expired'
  /** The licence has not started yet. */
  | 'licence_not_started'
  /** The review due date passed. */
  | 'review_overdue'
  /** Derivative use declared without a known licence (fail closed). */
  | 'licence_unknown'
  /** The terms are not ones this version knows (fail closed). */
  | 'unknown_terms';

export type UsageDecision =
  | { allowed: true; operation: UsageOperation; usageMode: UsageMode }
  | {
      allowed: false;
      operation: UsageOperation;
      reason: UsageRefusalReason;
      /** The mode in effect now. */
      usageMode: UsageMode;
      /** True when a person must review the terms (or the content) before it can go on. */
      reviewRequired: boolean;
    };

const ALLOWED: Record<UsageMode, readonly UsageOperation[]> = {
  discovery_only: ['use_as_lead'],
  facts_only: ['use_as_lead', 'extract_facts'],
  licensed_derivative: ['use_as_lead', 'extract_facts', 'translate', 'rewrite'],
};

const isUsageMode = (v: string): v is UsageMode => v in ALLOWED;
const time = (v: Date | string | null | undefined): number | null => (v == null ? null : typeof v === 'string' ? Date.parse(v) : v.getTime());

/** Why the licence is not in effect at `now`, or null when it is. */
function licenceProblem(terms: SourceTerms, now: Date): Exclude<UsageRefusalReason, 'usage_mode_forbids' | 'unknown_terms'> | null {
  const at = now.getTime();
  const from = time(terms.licenceValidFrom);
  const until = time(terms.licenceValidUntil);
  const review = time(terms.reviewDueAt);
  if (terms.usageMode === 'licensed_derivative' && terms.licenceStatus === 'unknown') return 'licence_unknown';
  if (from !== null && at < from) return 'licence_not_started';
  if (until !== null && at >= until) return 'licence_expired';
  if (review !== null && at >= review) return 'review_overdue';
  return null;
}

/** Whether the source's licence terms are in effect at `now`. */
export function isLicenceEffective(terms: SourceTerms, now: Date): boolean {
  return licenceProblem(terms, now) === null;
}

/**
 * The usage mode in effect at `now`: the declared one while the licence is in
 * effect; `discovery_only` otherwise (an expired licence, or an overdue
 * review, leaves only the lead). A mode this version does not know is
 * `discovery_only` too.
 */
export function effectiveUsage(terms: SourceTerms, now: Date): UsageMode {
  if (!isUsageMode(terms.usageMode)) return 'discovery_only';
  if (terms.usageMode === 'discovery_only') return 'discovery_only';
  return isLicenceEffective(terms, now) ? terms.usageMode : 'discovery_only';
}

/** May `operation` be done with content from a source with these terms, at `now`? */
export function assertUsageAllowed(terms: SourceTerms, operation: UsageOperation, now: Date = new Date()): UsageDecision {
  if (!isUsageMode(terms.usageMode)) {
    return { allowed: false, operation, reason: 'unknown_terms', usageMode: 'discovery_only', reviewRequired: true };
  }
  const declared = terms.usageMode;
  const mode = effectiveUsage(terms, now);
  if (ALLOWED[mode].includes(operation)) return { allowed: true, operation, usageMode: mode };
  // The declared mode would allow it: only the licence's state stands in the way, and a person must review it.
  if (ALLOWED[declared].includes(operation)) {
    return { allowed: false, operation, reason: licenceProblem(terms, now) ?? 'usage_mode_forbids', usageMode: mode, reviewRequired: true };
  }
  return { allowed: false, operation, reason: 'usage_mode_forbids', usageMode: mode, reviewRequired: false };
}
