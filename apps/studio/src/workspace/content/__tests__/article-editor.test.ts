// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { descriptionHint, isArticleCollection, outlineOf } from '../article-rules';

/** The article editor's pure rules (HeoPress P07a tasks 6.1, 6.4). */

describe('article editor', () => {
  it('builds the outline from H2 and H3 in order, skipping empty headings', () => {
    const html = '<h1>Top</h1><h2>Intro</h2><p>x</p><h3>Detail</h3><h2> </h2><h4>No</h4><h2>End</h2>';
    expect(outlineOf(html)).toEqual([
      { level: 2, text: 'Intro', index: 0 },
      { level: 3, text: 'Detail', index: 1 },
      { level: 2, text: 'End', index: 3 },
    ]);
    expect(outlineOf('')).toEqual([]);
  });

  it('hints the description length without blocking anything', () => {
    expect(descriptionHint('short one')).toBe('short');
    expect(descriptionHint('a'.repeat(120))).toBe('ok');
    expect(descriptionHint('a'.repeat(161))).toBe('long');
    // Counted by characters, so Chinese is not double-counted.
    expect(descriptionHint('中'.repeat(100))).toBe('ok');
  });

  it('uses the article editor for the preset articles and marked collections only', () => {
    expect(isArticleCollection('articles', { preset: { key: 'articles' } })).toBe(true);
    expect(isArticleCollection('articles', {})).toBe(false);
    expect(isArticleCollection('guides', { studio: { kind: 'article' } })).toBe(true);
    expect(isArticleCollection('pages', { preset: { key: 'pages' } })).toBe(false);
    expect(isArticleCollection('pages', null)).toBe(false);
  });
});
