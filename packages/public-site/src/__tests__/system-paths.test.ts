import { describe, expect, it } from 'vitest';
import { isSystemPathSegment } from '../system-paths.ts';

/** The public site's own top-level paths (HeoPress P07 task 1.5). */
describe('isSystemPathSegment', () => {
  it('discovery files, .well-known, root files and the IndexNow key file are the system\'s', () => {
    for (const s of [
      'robots.txt', 'sitemap.xml', 'sitemap-1.xml', 'sitemap_index.xml', 'sitemap.txt', 'news-sitemap.xml', 'llms.txt', 'llms-full.txt',
      'feed', 'feed.xml', 'feed-articles.xml', 'rss', 'rss.xml', 'atom', 'atom.xml', 'Atom.XML',
      '.well-known', 'well-known', 'ads.txt', 'google1234567890abcdef.html', 'BingSiteAuth.xml', 'site.webmanifest', 'favicon.ico',
      '0a1b2c3d4e5f60718293a4b5c6d7e8f9.txt',
    ]) {
      expect(isSystemPathSegment(s), s).toBe(true);
    }
  });

  it('ordinary content segments are not', () => {
    for (const s of ['news', 'about', 'feedback', 'feeding-tips', 'rsvp', 'atomic-habits', 'sitemaps-explained', '2026', 'v1.2-release', 'llms', 'well-known-facts', 'robots']) {
      expect(isSystemPathSegment(s), s).toBe(false);
    }
  });
});
