import { describe, expect, it } from 'vitest';
import { correctionDay, lastPathSegment, noticeDocument, noticeSlug, noticeTitle } from '../notice';

const source = { reportId: 'r_abc', pagePath: '/notes/one/', excerpt: 'Quote.', correction: 'Correction.' };
const article = { id: 'item_1', title: 'The bridge', locale: 'en' };
const now = new Date('2026-11-14T03:04:05Z');

describe('the notice a report becomes', () => {
  it('gets one path segment derived from the report: a second notice could not take a second path', () => {
    expect(noticeSlug('r_abc')).toBe('correction-r_abc');
    expect(noticeSlug('r_abc')).toBe(noticeSlug('r_abc'));
  });

  it('is titled after the article, or after the page path when the article is gone', () => {
    expect(noticeTitle(source, article)).toBe('Correction: The bridge');
    expect(noticeTitle(source, null)).toBe('Correction: /notes/one/');
    expect(noticeTitle({ ...source, pagePath: '/x/' }, { ...article, title: '  ' })).toBe('Correction: /x/');
    expect(noticeTitle({ ...source, pagePath: '/x/' }, { ...article, title: 't'.repeat(500) })).toHaveLength(200);
  });

  it('carries the public fields and the two internal ids, and nothing about the reporter', () => {
    const doc = noticeDocument(source, article, now);
    expect(doc).toEqual({
      title: 'Correction: The bridge',
      slug: 'correction-r_abc',
      locale: 'en',
      page_path: '/notes/one/',
      excerpt: 'Quote.',
      correction: 'Correction.',
      corrected_on: '2026-11-14T03:04:05.000Z',
      report_id: 'r_abc',
      article_id: 'item_1',
    });
    for (const key of Object.keys(doc)) expect(key).not.toMatch(/reporter|email|comment|name/);
  });

  it('is written without an article when the target could not be resolved', () => {
    expect(noticeDocument(source, null, now)).toMatchObject({ locale: '', article_id: '' });
  });

  it('prints the day the block carries', () => {
    expect(correctionDay(now)).toBe('2026-11-14');
  });

  it('reads the last segment of a page path, decoded', () => {
    expect(lastPathSegment('/notes/one/')).toBe('one');
    expect(lastPathSegment('/notes/one')).toBe('one');
    expect(lastPathSegment('/notes/%E4%B8%AD%E6%96%87/')).toBe('中文');
    expect(lastPathSegment('/')).toBe('');
    expect(lastPathSegment('')).toBe('');
  });
});
