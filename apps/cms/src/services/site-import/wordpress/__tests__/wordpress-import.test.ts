import { describe, expect, it } from 'vitest';
import { parseWxr, WxrError } from '../wxr';
import { convertWxr } from '../convert';

const WXR = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>Example News</title>
  <link>https://example.test</link>
  <description>News</description>
  <language>en-US</language>
  <wp:base_site_url>https://example.test</wp:base_site_url>
  <wp:base_blog_url>https://example.test</wp:base_blog_url>
  <wp:author>
    <wp:author_login><![CDATA[alice]]></wp:author_login>
    <wp:author_display_name><![CDATA[Alice]]></wp:author_display_name>
  </wp:author>
  <wp:category>
    <wp:category_nicename><![CDATA[news]]></wp:category_nicename>
    <wp:cat_name><![CDATA[News]]></wp:cat_name>
  </wp:category>
  <wp:tag>
    <wp:tag_slug><![CDATA[launch]]></wp:tag_slug>
    <wp:tag_name><![CDATA[Launch]]></wp:tag_name>
  </wp:tag>
  <item>
    <title><![CDATA[Hello world]]></title>
    <link>https://example.test/2026/11/hello-world/</link>
    <dc:creator><![CDATA[alice]]></dc:creator>
    <content:encoded><![CDATA[<!-- wp:paragraph --><p>Body</p><!-- /wp:paragraph -->]]></content:encoded>
    <excerpt:encoded><![CDATA[Short]]></excerpt:encoded>
    <wp:post_id>101</wp:post_id>
    <wp:post_date_gmt>2026-11-01 10:00:00</wp:post_date_gmt>
    <wp:post_modified_gmt>2026-11-02 11:30:00</wp:post_modified_gmt>
    <wp:post_name><![CDATA[hello-world]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <category domain="category" nicename="news"><![CDATA[News]]></category>
    <category domain="post_tag" nicename="launch"><![CDATA[Launch]]></category>
    <wp:postmeta><wp:meta_key><![CDATA[_yoast_wpseo_title]]></wp:meta_key><wp:meta_value><![CDATA[Yoast title]]></wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key><![CDATA[_yoast_wpseo_metadesc]]></wp:meta_key><wp:meta_value><![CDATA[Yoast description]]></wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key><![CDATA[unmapped_key]]></wp:meta_key><wp:meta_value><![CDATA[x]]></wp:meta_value></wp:postmeta>
  </item>
  <item>
    <title><![CDATA[Ranked]]></title>
    <link>https://example.test/2026/11/ranked/</link>
    <content:encoded><![CDATA[<!-- wp:custom-thing --><div>x</div><!-- /wp:custom-thing -->]]></content:encoded>
    <wp:post_id>102</wp:post_id>
    <wp:post_name><![CDATA[ranked]]></wp:post_name>
    <wp:status><![CDATA[draft]]></wp:status>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:postmeta><wp:meta_key><![CDATA[rank_math_title]]></wp:meta_key><wp:meta_value><![CDATA[Rank title]]></wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key><![CDATA[rank_math_robots]]></wp:meta_key><wp:meta_value><![CDATA[noindex]]></wp:meta_value></wp:postmeta>
  </item>
  <item>
    <title><![CDATA[About]]></title>
    <link>https://example.test/about/</link>
    <content:encoded><![CDATA[<p>About</p>]]></content:encoded>
    <wp:post_id>103</wp:post_id>
    <wp:post_name><![CDATA[about]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_type><![CDATA[page]]></wp:post_type>
  </item>
  <item>
    <title><![CDATA[logo]]></title>
    <wp:post_id>104</wp:post_id>
    <wp:post_type><![CDATA[attachment]]></wp:post_type>
    <wp:attachment_url><![CDATA[https://example.test/wp-content/uploads/logo.png]]></wp:attachment_url>
    <wp:postmeta><wp:meta_key><![CDATA[_wp_attached_file]]></wp:meta_key><wp:meta_value><![CDATA[2026/11/logo.png]]></wp:meta_value></wp:postmeta>
  </item>
</channel>
</rss>`;

describe('parseWxr', () => {
  it('reads the site, authors, terms and items', () => {
    const doc = parseWxr(WXR);
    expect(doc.title).toBe('Example News');
    expect(doc.language).toBe('en-US');
    expect(doc.baseSiteUrl).toBe('https://example.test');
    expect(doc.authors).toEqual([{ login: 'alice', displayName: 'Alice', email: undefined }]);
    expect(doc.categories).toEqual([{ nicename: 'news', name: 'News', parent: undefined }]);
    expect(doc.tags).toEqual([{ nicename: 'launch', name: 'Launch' }]);
    expect(doc.items).toHaveLength(4);
    const hello = doc.items[0]!;
    expect(hello.postId).toBe('101');
    expect(hello.content).toContain('<p>Body</p>');
    expect(hello.excerpt).toBe('Short');
    expect(hello.meta.find((m) => m.key === '_yoast_wpseo_title')?.value).toBe('Yoast title');
    expect(hello.terms.map((t) => t.domain)).toEqual(['category', 'post_tag']);
  });

  it('refuses DOCTYPE and ENTITY declarations', () => {
    expect(() => parseWxr('<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss/>')).toThrow(WxrError);
    expect(() => parseWxr('<rss><!ENTITY x "y"></rss>')).toThrow(/ENTITY/);
  });

  it('refuses a file over the byte limit and a deeper nesting than allowed', () => {
    expect(() => parseWxr('<rss><channel><title>x</title></channel></rss>', { maxBytes: 10 })).toThrow(/limit is 10/);
    expect(() => parseWxr('<rss><a><b><c/></b></a></rss>', { maxDepth: 2 })).toThrow(/deeper than 2/);
  });
});

describe('convertWxr', () => {
  const convert = (readMedia?: (file: string) => Uint8Array | undefined) =>
    convertWxr(parseWxr(WXR), {
      sourceSite: 'old-site',
      defaultLocale: 'en-US',
      permalinkStructure: '/%year%/%monthnum%/%postname%/',
      readMedia,
      generatedAt: '2026-11-09T00:00:00.000Z',
    });

  it('maps items, terms, SEO fields and media into bundle records', () => {
    const { records, report } = convert(() => new Uint8Array([1, 2, 3]));
    const header = records[0] as { type: string; source: string; sourceSite: string };
    expect(header).toMatchObject({ type: 'header', source: 'wordpress', sourceSite: 'old-site' });
    const items = records.filter((r) => r.type === 'item') as Array<{ externalId: string; collection: string; status: string; data: Record<string, unknown>; legacyPath?: string; categories?: string[]; tags?: string[] }>;
    expect(items).toHaveLength(3);
    const hello = items.find((i) => i.externalId === 'wordpress:old-site:101')!;
    expect(hello.collection).toBe('articles');
    expect(hello.status).toBe('published');
    expect(hello.data).toMatchObject({ title: 'Hello world', slug: 'hello-world', body: expect.stringContaining('<p>Body</p>'), seoTitle: 'Yoast title', seoDescription: 'Yoast description' });
    expect(hello.legacyPath).toBe('/2026/11/hello-world/');
    expect(hello.categories).toEqual(['News']);
    expect(hello.tags).toEqual(['Launch']);
    const ranked = items.find((i) => i.externalId === 'wordpress:old-site:102')!;
    expect(ranked.status).toBe('draft');
    expect(ranked.data).toMatchObject({ seoTitle: 'Rank title', noindex: true });
    expect(items.find((i) => i.externalId === 'wordpress:old-site:103')!.collection).toBe('pages');
    const media = records.filter((r) => r.type === 'media') as Array<{ id: string; path: string; size: number }>;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ id: 'wordpress:old-site:104', path: '2026/11/logo.png', size: 3 });
    expect(report.items).toEqual({ total: 3, byType: { post: 2, page: 1 }, published: 2, draft: 1 });
    expect(report.media).toEqual({ total: 1, missing: [] });
    expect(report.unmappedMeta).toEqual([{ key: 'unmapped_key', count: 1 }]);
    expect(report.seo).toMatchObject({ items: 2, fromYoast: 1, fromRankMath: 1, missing: ['103'] });
    expect(report.unknownBlocks).toEqual([{ block: 'core/custom-thing', item: '102' }]);
    expect(report.legacyPathUnknown).toEqual([]);
  });

  it('reports media it cannot read and never mislabels it', () => {
    const { records, report } = convert(undefined);
    expect(records.some((r) => r.type === 'media')).toBe(false);
    expect(report.media).toEqual({ total: 0, missing: ['2026/11/logo.png'] });
  });

  it('writes a redirect for a plain ?p= permalink', () => {
    const plain = WXR.replace('<link>https://example.test/2026/11/hello-world/</link>', '<link>https://example.test/?p=101</link>');
    const { records, report } = convertWxr(parseWxr(plain), {
      sourceSite: 'old-site',
      defaultLocale: 'en-US',
      permalinkStructure: '?p=',
      targetPermalinks: { articles: '/blog/:slug' },
    });
    const redirect = records.find((r) => r.type === 'redirect') as { from: string; to: string } | undefined;
    expect(redirect).toEqual({ type: 'redirect', from: '/?p=101', to: '/blog/hello-world' });
    expect(report.redirects).toBe(1);
  });
});
