import { describe, expect, it } from 'vitest';
import { defaultSeoSettings, SiteSeoSettingsSchema } from '@heopress/contracts/schemas';

/** The site feed's collection (HeoPress v1.1 P12): a collection machine name, `articles` by default. */
describe('site SEO settings: discovery.feedCollection', () => {
  it('defaults to articles', () => {
    expect(defaultSeoSettings().discovery.feedCollection).toBe('articles');
    expect(SiteSeoSettingsSchema.parse({}).discovery.feedCollection).toBe('articles');
  });

  it('accepts a preset collection and a plugin machine name', () => {
    expect(SiteSeoSettingsSchema.parse({ discovery: { feedCollection: 'pages' } }).discovery.feedCollection).toBe('pages');
    expect(SiteSeoSettingsSchema.parse({ discovery: { feedCollection: 'heopress_briefing_daily__briefings' } }).discovery.feedCollection).toBe(
      'heopress_briefing_daily__briefings',
    );
  });

  it('refuses anything that is not a collection machine name', () => {
    for (const feedCollection of ['', 'Articles', '../articles', 'a b', 'articles/', '1articles', 'articles-2026']) {
      expect(SiteSeoSettingsSchema.safeParse({ discovery: { feedCollection } }).success, feedCollection).toBe(false);
    }
  });
});

/** Markdown content negotiation (HeoPress v1.2 P07): a switch, off by default. */
describe('site SEO settings: discovery.markdownNegotiation', () => {
  it('defaults to off', () => {
    expect(defaultSeoSettings().discovery.markdownNegotiation).toBe(false);
    expect(SiteSeoSettingsSchema.parse({}).discovery.markdownNegotiation).toBe(false);
  });

  it('accepts either state, and only a boolean', () => {
    expect(SiteSeoSettingsSchema.parse({ discovery: { markdownNegotiation: true } }).discovery.markdownNegotiation).toBe(true);
    for (const markdownNegotiation of [false, 'true', 1, null]) {
      const parsed = SiteSeoSettingsSchema.safeParse({ discovery: { markdownNegotiation } });
      expect(parsed.success, JSON.stringify(markdownNegotiation)).toBe(markdownNegotiation === false);
    }
  });
});
