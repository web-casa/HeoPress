import { describe, expect, it } from 'vitest';
import { assertSafeRepoPath, itemDocument, planItemPaths, safeDomain, safeSegment, siteFiles, UnsafePathError, type ExportItem } from '../format';
import { redact } from '../git';

const base = (over: Partial<ExportItem> = {}): ExportItem => ({
  itemId: 'it1',
  locale: 'en',
  slug: 'hello',
  title: 'Hello',
  translationGroup: null,
  publishedAt: new Date('2026-10-05T12:00:00Z'),
  contentModifiedAt: new Date('2026-10-06T12:00:00Z'),
  author: 'Ada Writer',
  source: { url: null, attribution: null, licenseStatus: null },
  seo: { title: null, description: null, canonical: null, robots: null },
  body: 'Text.',
  ...over,
});

describe('Git snapshot format (P11 tasks 2.2, 2.6, 2.7)', () => {
  it('paths follow websites/<domain>/YYYY/MM/<slug>/index.md', () => {
    expect(planItemPaths('Example.com', 'en', [base()]).get('it1')).toBe('websites/example.com/2026/10/hello/index.md');
  });

  it('refuses traversal and unsafe names', () => {
    expect(safeSegment('../../etc/passwd')).toBe('etc-passwd');
    expect(safeSegment('..')).toBe('untitled');
    expect(safeSegment('.git')).toBe('git');
    expect(safeSegment('a/b\\c')).toBe('a-b-c');
    expect(() => safeDomain('../evil')).toThrow(UnsafePathError);
    expect(() => safeDomain('example.com/../x')).toThrow(UnsafePathError);
    expect(() => assertSafeRepoPath('websites/example.com/../x')).toThrow(UnsafePathError);
    expect(() => assertSafeRepoPath('websites/example.com/.git/config')).toThrow(UnsafePathError);
    expect(() => assertSafeRepoPath('/etc/x')).toThrow(UnsafePathError);
  });

  it('a slug shared by two languages in one month: the default language keeps it, the other takes a stable suffix', () => {
    const items = [base({ itemId: 'b', locale: 'zh-CN' }), base({ itemId: 'a', locale: 'en' })];
    const paths = planItemPaths('example.com', 'en', items);
    expect(paths.get('a')).toBe('websites/example.com/2026/10/hello/index.md');
    expect(paths.get('b')).toBe('websites/example.com/2026/10/hello--zh-cn/index.md');
    // Same result whatever the order.
    expect(planItemPaths('example.com', 'en', [...items].reverse())).toEqual(paths);
    // Same language twice: the item id too.
    const twice = planItemPaths('example.com', 'en', [base({ itemId: 'x', locale: 'fr' }), base({ itemId: 'y', locale: 'fr' })]);
    expect(new Set(twice.values()).size).toBe(2);
  });

  it('front matter is a whitelist: personal data planted anywhere in the input never reaches the file (ADR-0013)', () => {
    const planted = { ...base(), email: 'ada@example.com', userId: 'usr_42', ip: '203.0.113.9', members: ['m1'], comments: ['c1'] } as unknown as ExportItem;
    const doc = itemDocument(planted);
    for (const v of ['ada@example.com', 'usr_42', '203.0.113.9', 'm1', 'c1', 'email', 'userId', 'members', 'comments']) expect(doc).not.toContain(v);
    expect(doc).toContain('author: "Ada Writer"');
    expect(doc.split('\n---')[0]!.match(/^[a-zA-Z]+:/gm)).toEqual(['id:', 'title:', 'slug:', 'locale:', 'translationGroup:', 'publishedAt:', 'contentModifiedAt:', 'author:', 'source:', 'seo:']);
  });

  it('values are quoted: a title cannot break out of the front matter', () => {
    const doc = itemDocument(base({ title: 'x\n---\nevil: true' }));
    expect(doc).toContain('title: "x\\n---\\nevil: true"');
    expect(doc).not.toMatch(/^evil:/m);
  });

  it('site files: configuration, theme templates and items under the domain', () => {
    const files = siteFiles({
      domain: 'example.com',
      defaultLanguage: 'en',
      site: { name: 'S' },
      theme: { name: 't', number: 3, contentHash: 'h', templates: { 'layouts/../../x.liquid': 'x', 'page.liquid': 'p' }, assets: [] },
      items: [base()],
    });
    expect(files.map((f) => f.path).sort()).toEqual([
      'websites/example.com/2026/10/hello/index.md',
      'websites/example.com/_site/site.json',
      'websites/example.com/_site/theme/templates/layouts/untitled/untitled/x.liquid',
      'websites/example.com/_site/theme/templates/page.liquid',
      'websites/example.com/_site/theme/theme.json',
    ]);
  });

  it('redacts the token and its Basic form from git errors', () => {
    const auth = { username: 'x-access-token', token: 'tok-fake-1234' };
    const basic = Buffer.from('x-access-token:tok-fake-1234').toString('base64');
    const out = redact(`fatal: tok-fake-1234 ${basic} https://u:p@git.example.com/r.git`, auth);
    expect(out).not.toContain('tok-fake-1234');
    expect(out).not.toContain(basic);
    expect(out).not.toContain('u:p@');
  });
});
