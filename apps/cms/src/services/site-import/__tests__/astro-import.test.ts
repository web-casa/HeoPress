import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportItem, ImportRecord } from '@heopress/contracts/schemas';
import { convertAstroSite, splitFrontmatter, writeBundle, type AstroConversion } from '../astro/convert';
import { convertBody, parseJsxAttributes } from '../astro/mdx';
import { loadBundle } from '../bundle-reader';

/**
 * The Astro content-collection importer (HeoPress P12 tasks 7.1, 7.2) on the fixture site
 * (`fixtures/astro-site`): languages from a suffix (blog), a directory (docs) and a field (news); unknown components
 * kept and reported; local images into the media manifest; old redirects from `_redirects`, the Astro config and
 * the mapping.
 */

const ROOT = path.join(__dirname, 'fixtures/astro-site');
let conversion: AstroConversion;
const itemsOf = (records: ImportRecord[]) => records.filter((r): r is ImportItem => r.type === 'item');
const item = (id: string) => itemsOf(conversion.records).find((i) => i.externalId === id)!;

beforeAll(async () => {
  conversion = await convertAstroSite(ROOT, JSON.parse(await readFile(path.join(ROOT, 'heopress-import.json'), 'utf8')));
});

describe('mapping (task 7.1)', () => {
  it('spec "按文件名后缀识别语言": post.en / post.zh / post.id are three languages of one translation group', () => {
    const posts = ['blog/post.en', 'blog/post.zh', 'blog/post.id'].map(item);
    expect(posts.map((p) => p.locale)).toEqual(['en', 'zh-CN', 'id']);
    expect(new Set(posts.map((p) => p.translationKey))).toEqual(new Set(['blog/post']));
    expect(posts.map((p) => p.data.slug)).toEqual(['post', 'post', 'post']);
    expect(posts.map((p) => p.legacyPath)).toEqual(['/blog/post/', '/zh/blog/post/', '/id/blog/post/']);
  });

  it('languages from the directory, and from a field with a translation key field', () => {
    expect([item('docs/en/guide'), item('docs/zh/guide')].map((i) => [i.locale, i.translationKey, i.legacyPath])).toEqual([
      ['en', 'docs/guide', '/docs/guide/'],
      ['zh-CN', 'docs/guide', '/zh/docs/guide/'],
    ]);
    expect([item('news/launch'), item('news/launch-zh')].map((i) => [i.locale, i.translationKey])).toEqual([
      ['en', 'launch'],
      ['zh-CN', 'launch'],
    ]);
  });

  it('fields map, special targets set item properties, drafts stay drafts', () => {
    const en = item('blog/post.en');
    expect(en).toMatchObject({ status: 'published', sponsored: true, publishedAt: '2024-02-03T00:00:00.000Z', tags: ['hosting', 'vps'], data: { title: 'Choosing a VPS', excerpt: 'How to pick a VPS for a small site.' } });
    expect(en.data.seo_image).toMatch(/^heopress-media:img-/);
    expect(item('blog/missing-image').status).toBe('draft');
  });

  it('mapped fields missing from entries are reported (with how many lack them)', () => {
    expect(conversion.report.missingFields).toContainEqual({ collection: 'blog', field: 'author', entries: 4, of: 4 });
    expect(conversion.report.missingFields).toContainEqual({ collection: 'news', field: 'summary', entries: 2, of: 2 });
  });

  it('old redirects: _redirects, the Astro config, the mapping; dynamic rules are reported, not guessed', () => {
    const redirects = conversion.records.filter((r) => r.type === 'redirect').map((r) => (r.type === 'redirect' ? [r.from, r.to, r.status] : []));
    expect(redirects).toEqual([
      ['/old-post', '/blog/post/', 301],
      ['/feed/*', '/rss.xml', 301],
      ['/about-us', '/about/', 301],
      ['/legacy', '/blog/', 302],
      ['/rss', '/rss.xml', 301],
    ]);
    expect(conversion.report.redirects.skipped).toEqual([expect.objectContaining({ rule: '/posts/[slug] /blog/[slug]' })]);
  });

  it('the site record carries languages, trailing slash, prefixes and permalinks', () => {
    const site = conversion.records.find((r) => r.type === 'site');
    expect(site).toMatchObject({ settings: { defaultLocale: 'en', locales: ['en', 'zh-CN', 'id'], trailingSlash: 'always', localePrefixes: { 'zh-CN': 'zh', id: 'id' }, permalinks: { articles: '/blog/:slug', pages: '/docs/:slug' } } });
    expect(conversion.report.notes).toContainEqual(expect.objectContaining({ file: 'news' }));
  });
});

describe('MDX and media (task 7.2)', () => {
  it('spec "未知组件": <ComparisonTable> is kept as a custom-component block and reported with its line', () => {
    const body = item('blog/post.en').data.body as string;
    expect(body).toContain('<div data-block-type="custom-component" data-component="ComparisonTable" data-props="{&quot;rows&quot;:{&quot;$expr&quot;:&quot;3&quot;},&quot;caption&quot;:&quot;Plans&quot;}"><p>  Plans compared <em>by price</em>.</p></div>');
    expect(conversion.report.unknownComponents).toEqual([{ component: 'ComparisonTable', file: 'src/content/blog/post.en.mdx', line: 18 }]);
    expect(item('blog/post.en').notes).toContain('Unknown component <ComparisonTable> at line 18: kept as a custom-component block.');
  });

  it('mapped components become their block; Image with an imported source becomes a figure; imports are dropped', () => {
    const body = item('blog/post.en').data.body as string;
    expect(body).toContain('<blockquote><p>Remember the backups.</p></blockquote>');
    expect(body).toMatch(/<figure><img src="heopress-media:img-[0-9a-f]{16}" alt="A server rack"><\/figure>/);
    expect(body).not.toContain('import ');
  });

  it('local images (relative, public dir, imported) go into the media manifest once each, and references are rewritten', () => {
    const media = conversion.records.filter((r) => r.type === 'media');
    expect(media).toHaveLength(3);
    const body = item('blog/post.en').data.body as string;
    for (const m of media) if (m.type === 'media') expect(body).toContain(`heopress-media:${m.id}`);
    expect(item('blog/missing-image').notes).toContain('Image ./gone.png could not be found; left as is.');
  });

  it('the written bundle passes the bundle checks (paths, sizes, hashes, types)', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'heopress-astro-'));
    try {
      await writeBundle(out, conversion);
      const b = await loadBundle(out);
      expect(b.namespace).toBe('astro:blog-example');
      expect(b.items).toHaveLength(8);
      expect(b.media).toHaveLength(3);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('a file reference outside the site root is never read', async () => {
    const r = convertBody('![x](../../../../etc/passwd.png)', { mdx: false, resolveImage: () => null });
    expect(r.html).toContain('../../../../etc/passwd.png');
    expect(r.notes[0]).toMatch(/could not be found/);
  });

  it('JSX attributes and frontmatter parsing', () => {
    expect(parseJsxAttributes(' a="x" b={1 + {c: 2}.c} wide c=\'y\' ')).toEqual({ a: 'x', b: { $expr: '1 + {c: 2}.c' }, wide: true, c: 'y' });
    expect(splitFrontmatter('---\ntitle: A\n---\nBody')).toEqual({ data: { title: 'A' }, body: 'Body', bodyLine: 3 });
  });

  it('nested components, inline components and code fences', () => {
    const r = convertBody('<Outer>\n<Inner />\n</Outer>\n\nText with <Badge kind="new" /> inline.\n\n```jsx\n<NotAComponent />\n```', { mdx: true, resolveImage: () => null });
    expect(r.unknownComponents.map((u) => u.component).sort()).toEqual(['Badge', 'Inner', 'Outer']);
    expect(r.html).toContain('<span data-block-type="custom-component" data-component="Badge"');
    expect(r.html).toContain('&lt;NotAComponent /&gt;');
  });
});
