import { describe, expect, it } from 'vitest';
import { parsePermalinkPattern, type PermalinkSegment } from '@heopress/contracts/schemas';
import { buildPath, isValidSegment } from '@heopress/public-site';
import { isReservedSegment } from '../services/site-network/reserved-paths';

/**
 * Paths from permalink patterns (HeoPress P05 task 1.6; spec
 * content/site-network-model "固定链接"), the segment contract and reserved
 * top-level paths (design B). Pure functions; the database side is in
 * content-routes.db.integration.test.ts.
 */

const pattern = (p: string): PermalinkSegment[] => {
  const parsed = parsePermalinkPattern(p);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.segments;
};
const input = { slug: 'astro', number: 7, date: new Date('2019-03-22T10:00:00Z'), timezone: 'UTC', category: null, collection: 'articles' };

describe('permalink paths', () => {
  it('a date pattern for articles, a slug pattern for pages (the spec example), in the site\'s time zone', () => {
    expect(buildPath(pattern('/:year/:month/:day/:slug'), input)).toEqual({ ok: true, path: '/2019/03/22/astro' });
    expect(buildPath(pattern('/:slug'), input)).toEqual({ ok: true, path: '/astro' });
    expect(buildPath(pattern('/:id'), input)).toEqual({ ok: true, path: '/7' });
    expect(buildPath(pattern('/:category/:slug'), input)).toEqual({ ok: true, path: '/uncategorized/astro' });
    expect(buildPath(pattern('/:category/:slug'), { ...input, category: 'guides' })).toEqual({ ok: true, path: '/guides/astro' });
    expect(buildPath(pattern('/:collection/:id'), input)).toEqual({ ok: true, path: '/articles/7' });
    // 22 March 23:30 UTC is already the 23rd in Shanghai.
    expect(buildPath(pattern('/:year/:month/:day/:slug'), { ...input, date: new Date('2019-03-22T23:30:00Z'), timezone: 'Asia/Shanghai' })).toEqual({
      ok: true,
      path: '/2019/03/23/astro',
    });
    expect(buildPath(pattern('/:slug'), { ...input, slug: ' 关于 ' })).toEqual({ ok: true, path: '/关于' });
  });

  it('a missing value is no path yet; a value that cannot be a segment is invalid', () => {
    expect(buildPath(pattern('/:slug'), { ...input, slug: null })).toMatchObject({ ok: false, reason: 'missing', variable: 'slug' });
    expect(buildPath(pattern('/:slug'), { ...input, slug: '   ' })).toMatchObject({ ok: false, reason: 'missing' });
    expect(buildPath(pattern('/:id'), { ...input, number: null })).toMatchObject({ ok: false, reason: 'missing', variable: 'id' });
    for (const bad of ['a/b', 'a\\b', 'a?b', 'a#b', '100%', 'a b', 'tab\there', 'n\nl', '.', '..', '\u0007']) {
      expect(isValidSegment(bad), JSON.stringify(bad)).toBe(false);
      expect(buildPath(pattern('/:slug'), { ...input, slug: bad }), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(buildPath(pattern('/:slug'), { ...input, slug: 'a/b' })).toMatchObject({ reason: 'invalid', value: 'a/b' });
    expect(buildPath(pattern('/:category/:slug'), { ...input, category: 'x/y' })).toMatchObject({ reason: 'invalid', variable: 'category' });
    for (const good of ['hello-world', 'v1.2', '关于我们', 'a_b', 'café']) expect(isValidSegment(good), good).toBe(true);
  });

  it('reserved first segments: the fixed set, `_` paths, the admin path', () => {
    for (const s of ['api', 'API', 'admin', 'sitemap.xml', '.well-known', '_private', '_next']) expect(isReservedSegment(s, null), s).toBe(true);
    expect(isReservedSegment('smoke-admin', 'smoke-admin')).toBe(true);
    expect(isReservedSegment('Smoke-Admin', 'smoke-admin')).toBe(true);
    expect(isReservedSegment('smoke-admin', null)).toBe(false);
    expect(isReservedSegment('about', 'smoke-admin')).toBe(false);
  });
});
