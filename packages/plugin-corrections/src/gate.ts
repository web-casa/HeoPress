/**
 * The article-side quality-gate check (pure verdict; the lookups happen in `index.ts`).
 *
 * A published correction notice writes a marker block into the corrected article. That block must never point at
 * nothing: a marker whose notice was deleted, or is still a draft, is a public page claiming a correction record that
 * readers cannot see. The check reads the marker ids out of the draft's body, the host looks up the notices of this
 * site (through the plugin's declared `items:read:heopress_corrections__notices`), and the verdict here is:
 *
 *   - `passed` — every marker names a published notice;
 *   - `blocked` — a marker names no notice, or one that is not published (the gate result is blocked, so the draft
 *     cannot pass the gate and cannot be auto-published);
 *   - `needs_review` — the notices could not be read (the check cannot vouch for the body).
 *
 * A malformed marker id is `blocked` as well: only the plugin writes these blocks, so a marker outside the report-id
 * grammar is a sign the body was edited by hand.
 */
import type { GateCheckVerdict } from '@heopress/extension-sdk';

/** A notice as the check needs it: its id and its item status. */
interface NoticeState {
  id: string;
  status: string;
}

/** One marker and the notice its report produced (null: no notice at all). */
export interface NoticeLookup {
  report: string;
  notice: NoticeState | null;
}

/** Every marker points at a published notice. */
export function judgeNoticeLinks(lookups: readonly NoticeLookup[]): GateCheckVerdict {
  const missing = lookups.filter((l) => l.notice === null).map((l) => l.report);
  const unpublished = lookups
    .filter((l): l is NoticeLookup & { notice: NoticeState } => l.notice !== null && l.notice.status !== 'published')
    .map((l) => ({ report: l.report, notice: l.notice.id, status: l.notice.status }));
  if (missing.length === 0 && unpublished.length === 0) {
    return { verdict: 'passed', evidence: { corrections: lookups.map((l) => l.report) } };
  }
  return {
    verdict: 'blocked',
    evidence: { ...(missing.length ? { missing } : {}), ...(unpublished.length ? { unpublished } : {}) },
    suggestions: [
      'Publish the correction notice this block points at, or remove the block from the article: a published correction must have a public record.',
    ],
  };
}

/** Markers outside the report-id grammar: the body was edited by hand. */
export function judgeMalformedMarkers(ids: readonly string[]): GateCheckVerdict {
  return {
    verdict: 'blocked',
    evidence: { malformed: [...ids] },
    suggestions: ['The correction block carries an id the corrections plugin did not write; restore the block or write the correction again.'],
  };
}

/** The notices the check could not read: it cannot vouch for the body. */
export function judgeUnreadable(): GateCheckVerdict {
  return {
    verdict: 'needs_review',
    evidence: { unreadable: 'the correction notices of this site could not be read' },
    suggestions: ['Re-run the gate when the notices are readable again.'],
  };
}
