import { describe, expect, it } from 'vitest';
import { translationStatus, type StatusMember } from '../translation-status';

/** Translation status (HeoPress P05 task 5.6): computed from members and freshness. */

const m = (over: Partial<StatusMember>): StatusMember => ({ itemId: 'i', locale: 'en', status: 'draft', editorialState: null, deleted: false, stale: false, ...over });

describe('translation status', () => {
  it('missing, draft, in review, published and stale', () => {
    const out = translationStatus(
      ['en', 'zh-CN', 'pt', 'vi', 'ja'],
      [
        m({ itemId: 'en', locale: 'en', status: 'published' }),
        m({ itemId: 'zh', locale: 'zh-CN', status: 'published', stale: true }),
        m({ itemId: 'pt', locale: 'pt', editorialState: 'in_review' }),
        m({ itemId: 'vi', locale: 'vi' }),
      ],
    );
    expect(out.map((o) => [o.locale, o.state, o.itemId])).toEqual([
      ['en', 'published', 'en'],
      ['zh-CN', 'stale', 'zh'],
      ['pt', 'in_review', 'pt'],
      ['vi', 'draft', 'vi'],
      ['ja', 'missing', null],
    ]);
  });

  it('the published member decides over drafts of the same language; deleted members count for nothing; languages compare canonically', () => {
    const out = translationStatus(
      ['zh-CN', 'pt'],
      [
        m({ itemId: 'draft', locale: 'zh-cn' }),
        m({ itemId: 'live', locale: 'zh-CN', status: 'published' }),
        m({ itemId: 'gone', locale: 'pt', status: 'published', deleted: true }),
      ],
    );
    expect(out).toEqual([
      { locale: 'zh-CN', state: 'published', itemId: 'live' },
      { locale: 'pt', state: 'missing', itemId: null },
    ]);
  });

  it('spec "源条目更新后": a published translation with a stale block is stale', () => {
    expect(translationStatus(['zh-CN'], [m({ locale: 'zh-CN', status: 'published', stale: true })])[0]!.state).toBe('stale');
  });
});
