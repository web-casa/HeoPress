import { sameLocale } from '@heopress/contracts/schemas';

/**
 * Translation status (HeoPress P05 task 5.6; spec i18n/translation-freshness "翻译状态"; design E):
 * computed, never stored or set by hand. Per language of the site, from the group's members in that
 * language:
 *
 *   - a published member: `stale` when any of its block maps is stale, else `published`;
 *   - else a member in review (in review, approved or scheduled): `in_review`;
 *   - else a draft member: `draft`;
 *   - else `missing`.
 *
 * Deleted members count for nothing. The source's own language is the source's status (it has no
 * maps of its own, so it is never `stale`).
 */

export type TranslationState = 'missing' | 'draft' | 'in_review' | 'published' | 'stale';

export interface StatusMember {
  itemId: string;
  locale: string;
  status: string;
  editorialState: string | null;
  deleted: boolean;
  /** Whether any of its block maps (as a target) is stale. */
  stale: boolean;
}

const REVIEW_STATES = new Set(['in_review', 'approved', 'scheduled']);

/** One member's own state (the per-member view of the same rule). */
export function memberState(m: StatusMember): TranslationState {
  if (m.status === 'published') return m.stale ? 'stale' : 'published';
  if (m.editorialState && REVIEW_STATES.has(m.editorialState)) return 'in_review';
  return 'draft';
}

const RANK: Record<TranslationState, number> = { missing: 0, draft: 1, in_review: 2, stale: 3, published: 3 };

/** The state of each language of the site, with the member that decided it. */
export function translationStatus(locales: string[], members: StatusMember[]): Array<{ locale: string; state: TranslationState; itemId: string | null }> {
  return locales.map((locale) => {
    let best: { state: TranslationState; itemId: string | null } = { state: 'missing', itemId: null };
    for (const m of members) {
      if (m.deleted || !sameLocale(m.locale, locale)) continue;
      const state = memberState(m);
      if (RANK[state] > RANK[best.state]) best = { state, itemId: m.itemId };
    }
    return { locale, ...best };
  });
}
