import { describe, expect, it } from 'vitest';
import { defaultSeoSettings } from '@heopress/contracts/schemas';
import { applyTemplate, canonicalError, changedPaths, crawlerMeaning, effectiveForDiff, PRESETS, presetOf, validateSeo } from '../seo-rules';

/** The SEO / GEO module's rules (HeoPress P07a tasks 8.2–8.4). */

describe('seo rules', () => {
  it('names the preset a policy matches, unset purposes allowed', () => {
    expect(presetOf({})).toBe('allowAll');
    expect(presetOf({ training: 'disallow' })).toBe('searchOnly');
    expect(presetOf(PRESETS.blockAll)).toBe('blockAll');
    expect(presetOf({ search: 'disallow' })).toBeNull();
  });

  it('says what a policy means for citation and training (spec "改为全部阻止")', () => {
    expect(crawlerMeaning(PRESETS.blockAll)).toEqual({ cite: 'no', train: false });
    expect(crawlerMeaning(PRESETS.searchOnly)).toEqual({ cite: 'yes', train: false });
    expect(crawlerMeaning({ 'user-fetch': 'disallow' }).cite).toBe('partly');
  });

  it('fills templates as the public pages do', () => {
    expect(applyTemplate('{title} · {site}', { title: 'Kyoto', site: 'Travel' })).toBe('Kyoto · Travel');
    expect(applyTemplate('{title}  {unknown}', { title: 'A' })).toBe('A {unknown}');
  });

  it('counts changed leaves (two changes, then discard: none)', () => {
    const saved = defaultSeoSettings();
    const draft = structuredClone(saved);
    draft.titleTemplate = '{title} | X';
    draft.crawlers.purposes = { training: 'disallow' };
    expect(changedPaths(saved, draft).sort()).toEqual(['crawlers.purposes.training', 'titleTemplate']);
    expect(changedPaths(saved, structuredClone(saved))).toEqual([]);
    // A preset that only blocks training is one change, however the other purposes are written.
    const preset = structuredClone(saved);
    preset.crawlers.purposes = { ...PRESETS.searchOnly };
    expect(changedPaths(effectiveForDiff(saved), effectiveForDiff(preset))).toEqual(['crawlers.purposes.training']);
  });

  it('validates fields', () => {
    const s = defaultSeoSettings();
    expect(validateSeo(s)).toEqual({});
    expect(validateSeo({ ...s, titleTemplate: 'no placeholder' }).titleTemplate).toBe('errors.needsTitle');
    expect(validateSeo({ ...s, discovery: { ...s.discovery, newsSitemap: true } }).newsPublicationName).toBe('errors.publicationName');
  });

  it('a canonical domain must be bound to the site (spec "无效的规范域名")', () => {
    expect(canonicalError('other.example.com', ['www.example.com'])).toBe('errors.notBound');
    expect(canonicalError('WWW.example.com.', ['www.example.com'])).toBeNull();
  });
});
