import { describe, expect, it } from 'vitest';
import { SiteContentSettingsSchema, parsePermalinkPattern } from '@heopress/contracts/schemas';

/**
 * Permalink patterns and content settings validation (HeoPress P05 task
 * 1.2, spec content/site-network-model "站点设置", "固定链接").
 */
describe('permalink patterns', () => {
  it('accepts the patterns the spec names', () => {
    for (const p of ['/:year/:month/:day/:slug', '/:slug', '/:id', '/:category/:slug', '/blog/:collection/:id', '/:year/:month/:slug/']) {
      expect(parsePermalinkPattern(p), p).toMatchObject({ ok: true });
    }
    expect(parsePermalinkPattern('/:year/:month/:day/:slug')).toEqual({
      ok: true,
      segments: [
        { kind: 'variable', name: 'year' },
        { kind: 'variable', name: 'month' },
        { kind: 'variable', name: 'day' },
        { kind: 'variable', name: 'slug' },
      ],
    });
  });

  it('refuses a pattern without :slug or :id, unknown variables, repeats, empty or bad segments', () => {
    const errorOf = (p: string) => {
      const r = parsePermalinkPattern(p);
      return r.ok ? null : r.error;
    };
    expect(errorOf('/:year/:month/')).toMatch(/:slug or :id/);
    expect(errorOf('/news')).toMatch(/:slug or :id/);
    expect(errorOf('/:title')).toMatch(/Unknown permalink variable/);
    expect(errorOf('/:slug/:slug')).toMatch(/more than once/);
    expect(errorOf('/a//:slug')).toMatch(/empty segments/);
    expect(errorOf(':slug')).toMatch(/starts with/);
    expect(errorOf('/News/:slug')).toMatch(/not a valid path segment/);
    expect(errorOf('/a b/:slug')).toMatch(/not a valid path segment/);
  });

  it('settings: one prefix per language, only for the site\'s languages, and languages listed once', () => {
    const base = {
      availableLocales: ['en', 'zh-CN'],
      timezone: 'UTC',
      siteType: 'blog',
      trailingSlash: 'never',
      localeStrategy: 'subdirectory',
      localePrefixMode: 'all_prefixed',
      localePrefixes: { 'zh-CN': 'zh-cn' },
      permalinks: { articles: '/:id' },
      allowCrossSiteTranslations: false,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: 1,
    };
    expect(SiteContentSettingsSchema.safeParse(base).success).toBe(true);
    expect(SiteContentSettingsSchema.safeParse({ ...base, localePrefixes: { ja: 'ja' } }).success).toBe(false);
    expect(SiteContentSettingsSchema.safeParse({ ...base, localePrefixes: { en: 'x', 'zh-CN': 'x' } }).success).toBe(false);
    expect(SiteContentSettingsSchema.safeParse({ ...base, availableLocales: ['en', 'EN'] }).success).toBe(false);
    expect(SiteContentSettingsSchema.safeParse({ ...base, localePrefixes: { 'zh-CN': 'ZH' } }).success).toBe(false);
    expect(SiteContentSettingsSchema.safeParse({ ...base, permalinks: { articles: '/:year' } }).success).toBe(false);
  });
});
