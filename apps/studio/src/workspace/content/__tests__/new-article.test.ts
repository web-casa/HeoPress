import { describe, expect, it } from 'vitest';
import { slugFrom } from '../new-article-page';

describe('slugFrom', () => {
  it('makes an address of a Latin title', () => {
    expect(slugFrom('Ten Days in Kyoto: A Walking Guide')).toBe('ten-days-in-kyoto-a-walking-guide');
    expect(slugFrom('Crème brûlée, 3 ways!')).toBe('creme-brulee-3-ways');
  });

  it('gives a dated address to a title without Latin letters or digits', () => {
    const now = new Date(2026, 9, 25, 8);
    expect(slugFrom('京都十日', now)).toMatch(/^post-2026-10-25-[0-9a-z]{4}$/);
  });

  it('keeps addresses short and without a trailing hyphen', () => {
    const slug = slugFrom(`${'word '.repeat(40)}end`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });
});
