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
