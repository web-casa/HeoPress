import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, textToMarkdown, sampleOutput } from '@heopress/public-site';
import { cachedPage, OUTPUT_VERSION } from '../cache';
import { statusPage } from '../html';
import { defaultSeoSettings, SiteSeoSettingsSchema } from '@heopress/contracts/schemas';
import { robotsTxt } from '@heopress/seo-geo';
import { discoveryAnswer, type DiscoveryContext } from '../discovery-plan';
import { buildPage, homeCanonical, pageHeadOf, pagedUrl, type PageInput } from '../view-model';
import type { PublicItemRow } from '../read-port';
import { absoluteLinks, atomXml, fittingEntries, llmsTxt, newsLanguage, newsSitemapXml, pageMarkdown, rssXml, sitemapIndexXml, sitemapShards, sitemapTxt, sitemapXml } from '../discovery';

/**
 * The output contract (HeoPress P07 task 1.3): the cache keys carry `OUTPUT_VERSION`, so a change of what is
 * generated must raise it — or entries of the former format would still be served. The digest of the sample
 * output is recorded per version in `output-contract.json`; a version's digest is never changed afterwards
 * (append-only, kept by review: the public CI runs on a single exported commit, with no base to compare).
 */
const contract = JSON.parse(readFileSync(new URL('../../output-contract.json', import.meta.url), 'utf8')) as { versions: Record<string, string> };

const HOST = 'https://sample.example.com';

/**
 * What the service itself generates around the theme (Codex review of batch 3): list and language-home canonicals
 * under both trailing-slash policies, and the head of each kind of page — so a change there changes the digest too.
 */
function serviceOutput(): string {
  const site = { name: 'Sample site', defaultLanguage: 'en', settings: { availableLocales: ['en', 'ja'] }, seo: defaultSeoSettings() };
  const row = (over: Partial<PublicItemRow> = {}): PublicItemRow => ({
    itemId: 'sample-item',
    siteId: 'sample',
    collection: 'articles',
    locale: 'en',
    path: '/sample-item',
    number: null,
    data: { title: 'A sample </title>', excerpt: 'An excerpt', seo_description: 'A description', canonical_url: '' },
    card: { url: `${HOST}/sample-item/`, image: null },
    sponsored: false,
    sponsorName: null,
    publishedAt: new Date('2026-10-01T08:00:00.000Z'),
    updatedAt: new Date('2026-10-02T08:00:00.000Z'),
    sanitizer: 1,
    richFields: [],
    seoRobots: null,
    contentHash: 'sample-hash',
    contentModifiedAt: new Date('2026-10-03T08:00:00.000Z'),
    structured: {},
    renderVersion: 1,
    ...over,
  });
  const alternates = [
    { locale: 'en', url: `${HOST}/sample-item/` },
    { locale: 'ja', url: `${HOST}/ja/sample-item/` },
    { locale: 'x-default', url: `${HOST}/sample-item/` },
  ];
  const page = (over: Partial<PageInput>): PageInput => ({ type: 'item', site, locale: 'en', path: '/', status: 200, homeUrl: `${HOST}/`, ...over });
  const canonicals = [
    homeCanonical(`${HOST}/ja/`, 'https://ja.sample.example.com/', 1),
    homeCanonical(`${HOST}/ja/`, 'https://ja.sample.example.com/', 2),
    homeCanonical(`${HOST}/ja`, 'https://ja.sample.example.com', 2),
    homeCanonical('/', `${HOST}/`, 1),
    pagedUrl(`${HOST}/tag/news/`, 3),
    pagedUrl(`${HOST}/tag/news`, 1),
  ];
  const heads = [
    page({ item: row(), canonical: `${HOST}/sample-item/`, alternates }),
    page({ item: row({ seoRobots: 'noindex,follow' }), canonical: `${HOST}/sample-item/`, alternates }),
    page({ type: 'taxonomy', item: row({ collection: 'tags', data: { name: 'News' } }), canonical: pagedUrl(`${HOST}/tag/news/`, 2) }),
    page({ type: 'home', canonical: `${HOST}/` }),
    page({ type: 'search', query: 'sample', canonical: `${HOST}/search/` }),
    page({ type: 'error', status: 404 }),
    // Structured data (P07 tasks 2.4, 2.12): an identity, a news site, an article with its category and author.
    page({
      site: {
        ...site,
        settings: { ...site.settings, siteType: 'news' },
        identity: {
          kind: 'organization', name: 'Sample Org', logo: `${HOST}/logo.png`, email: 'press@example.com', telephone: '+1 555 0100',
          address: { streetAddress: '1 Main St', addressLocality: 'Springfield', addressRegion: '', postalCode: '', addressCountry: 'US' },
          sameAs: ['https://social.example.com/sample'],
        },
      },
      // A page image: one ImageObject node the page and the article refer to.
      item: row({
        card: { url: `${HOST}/sample-item/`, image: `${HOST}/sample.png` },
        // Explicit questions and answers (from the preset's own field, as the projection keeps them): the page's FAQPage.
        structured: { faq: [{ question: 'Why a sample?', answer: 'To pin the output.' }] },
      }),
      canonical: `${HOST}/sample-item/`,
      related: {
        category: row({ itemId: 'cat', collection: 'categories', data: { name: 'World' }, card: { url: `${HOST}/category/world/` } }),
        author: row({ itemId: 'ada', collection: 'authors', data: { name: 'Ada' }, card: { url: `${HOST}/author/ada/` } }),
      },
    }),
    page({ type: 'home', site: { ...site, identity: { kind: 'person', name: 'Sam', logo: '', email: '', telephone: '', address: { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: '' }, sameAs: ['https://social.example.com/sam'] } }, canonical: `${HOST}/` }),
  ].map((p) => pageHeadOf(p));
  // The theme's language switch: the languages, not the x-default.
  const themeAlternates = buildPage(page({ item: row(), canonical: `${HOST}/sample-item/`, alternates })).vm.alternates;
  // The discovery files (P07 tasks 3.1, 3.3, 3.7): their serialisation, escaping included.
  const entry = { loc: `${HOST}/sample-item/`, lastmod: '2026-10-03T08:00:00.000Z', alternates: alternates.slice(0, 2) };
  const feed = { self: `${HOST}/feed.xml`, home: `${HOST}/`, title: 'Sample & site', description: 'Sample <site>', language: 'en', author: 'Sample Org', updated: '2026-10-03T08:00:00.000Z' };
  const feedEntries = [{ id: entry.loc, url: entry.loc, title: 'A sample </title>', summary: 'An excerpt', published: '2026-10-01T08:00:00.000Z', updated: '2026-10-03T08:00:00.000Z', html: absoluteLinks('<p><a href="/x/">x</a></p>', entry.loc) }];
  const discovery = [
    sitemapIndexXml([{ loc: `${HOST}/sitemap-1.xml`, lastmod: entry.lastmod }, { loc: `${HOST}/news-sitemap.xml`, lastmod: null }]),
    sitemapXml([entry, { loc: `${HOST}/`, lastmod: null, alternates: [] }]),
    sitemapTxt([entry.loc, `${HOST}/`]),
    rssXml(feed, feedEntries),
    atomXml(feed, feedEntries),
    newsSitemapXml('Sample & news', [{ loc: entry.loc, title: 'A sample', published: '2026-10-01T08:00:00.000Z', language: newsLanguage('zh-Hant') }]),
    // Shards past the byte limit (task 3.6, Codex review of batch 8): heavy entries, a small limit — the ranges and the fitted entries.
    JSON.stringify(
      ((heavy) => ({ fitted: fittingEntries(heavy, 2000).map((e) => e.alternates.length), shards: sitemapShards(fittingEntries(heavy, 2000), 10_000, 2000) }))(
        Array.from({ length: 6 }, (_, i) => ({ loc: `${HOST}/h${i}/`, lastmod: null, alternates: Array.from({ length: i * 4 }, (_, k) => ({ locale: `l${String.fromCharCode(97 + k)}`, url: `${HOST}/l${k}/h${i}/` })) })),
      ),
    ),
    // llms.txt (task 4.1) and a page's Markdown (task 4.2), its body converted from rich text.
    llmsTxt({
      title: 'Sample site',
      summary: 'Sample site, by Sample Org.',
      pages: [{ title: 'About [us]', url: `${HOST}/about/`, description: 'Who we are' }],
      recent: [{ title: 'A sample', url: entry.loc, description: 'An excerpt' }],
      links: [{ label: 'RSS feed', url: `${HOST}/feed.xml` }],
    }),
    pageMarkdown({ title: 'A sample', description: 'An excerpt', url: entry.loc, published: '2026-10-01T08:00:00.000Z', modified: '2026-10-03T08:00:00.000Z', body: htmlToMarkdown('<h2>Hi</h2><p>A <a href="/x/">link</a> and <strong>more</strong>.</p><ul><li>one</li></ul><p>~approx<br>---</p><h3>Two<br>---</h3>', entry.loc) }),
    // A plain-text body (Codex review of batch 9, round 2: every line start that could be Markdown escaped).
    textToMarkdown('Intro\n>quoted\n===\n~~~'),
    // robots.txt (task 3.2) and a root file's answer (task 3.8).
    robotsTxt({
      settings: SiteSeoSettingsSchema.parse({ crawlers: { purposes: { training: 'disallow' }, overrides: { googlebot: 'disallow' }, contentSignal: true, custom: [{ id: 'acme', userAgent: 'AcmeBot', purpose: 'training' }] } }),
      origin: HOST,
      newsSitemap: true,
      feeds: [`${HOST}/feed.xml`],
    }),
  ];
  return JSON.stringify({ canonicals, heads, themeAlternates, discovery });
}

/** A root file's answer as the service makes it (task 3.8): its type and headers come from `discoveryAnswer`. */
async function rootFileOutput(): Promise<string> {
  const reads = { rootFile: async () => ({ contentType: 'text/html; charset=utf-8', content: 'verify' }) } as unknown as DiscoveryContext['reads'];
  const answer = (await discoveryAnswer({ kind: 'root-file', filename: 'google1.html' }, { reads, site: { seo: defaultSeoSettings() } } as unknown as DiscoveryContext))!;
  return JSON.stringify(cachedPage(200, answer.body, null, { contentType: answer.contentType, headers: answer.headers ?? {} }));
}

async function digest(): Promise<string> {
  const parts = [
    await rootFileOutput(),
    await sampleOutput(),
    ...[404, 410, 500, 503].map((s) => statusPage(s, 'Sample site', 'en')),
    serviceOutput(),
    // The envelope: what an answer's entity tag covers.
    JSON.stringify(cachedPage(200, 'x', null, { contentType: 'application/xml; charset=utf-8', headers: { 'X-Robots-Tag': 'noindex' } })),
    // A Markdown copy's envelope (task 4.2): its type, noindex and the canonical Link.
    JSON.stringify(cachedPage(200, '# x\n', null, { contentType: 'text/markdown; charset=utf-8', headers: { 'X-Robots-Tag': 'noindex', Link: `<${HOST}/x/>; rel="canonical"` } })),
  ];
  return createHash('sha256').update(parts.join('\n\u0000\n')).digest('hex');
}

describe('output contract', () => {
  it('the current output is the one recorded for the current output version (raise OUTPUT_VERSION when it changes)', async () => {
    const current = await digest();
    const recorded = contract.versions[String(OUTPUT_VERSION)];
    expect(recorded, `output-contract.json has no digest for version ${OUTPUT_VERSION}: add ${current}`).toBeDefined();
    expect(current, `the public output changed: raise OUTPUT_VERSION and record ${current} for the new version`).toBe(recorded);
  });

  it('the current version is the latest recorded one', () => {
    expect(Math.max(...Object.keys(contract.versions).map(Number))).toBe(OUTPUT_VERSION);
  });
});
