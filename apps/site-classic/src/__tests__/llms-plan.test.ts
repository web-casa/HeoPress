import { describe, expect, it } from 'vitest';
import { defaultSeoSettings } from '@heopress/contracts/schemas';
import { spaceOf } from '@heopress/public-site';
import { discoveryAnswer, type DiscoveryContext } from '../discovery-plan';
import type { PublicItemRow } from '../read-port';

/** `llms.txt` and `llms-full.txt` over fake reads (HeoPress P07 task 4.1; Codex review of batch 9, round 2). */

const HOST = 'example.com';
const ZH_HOST = 'example.cn';

function row(i: number, collection: string, robots: string | null = null, locale = 'en', host = HOST): PublicItemRow {
  const path = `/${collection}-${i}`;
  return {
    itemId: `${collection}-${locale}-${String(i).padStart(4, '0')}`,
    siteId: 's1',
    collection,
    locale,
    path,
    number: null,
    data: { title: `${collection} ${i}` },
    card: { url: `https://${host}${path}/` },
    sponsored: false,
    sponsorName: null,
    publishedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
    sanitizer: 1,
    richFields: [],
    seoRobots: robots,
    contentHash: null,
    contentModifiedAt: null,
    structured: {},
    renderVersion: 1,
  };
}

/** A site in English on example.com and, with `zh`, Chinese on its own domain (the domain strategy); `locales`: all on one host. */
function context(pages: PublicItemRow[], articles: PublicItemRow[], opts: { name?: string; zh?: boolean; host?: string; locales?: string[] } = {}) {
  const calls: Array<{ streams: string[]; limit: number }> = [];
  const all = [...pages, ...articles];
  /** Code-point order (as `COLLATE "C"`), descending. */
  const idDesc = (a: string, b: string) => {
    const x = [...a].map((c) => c.codePointAt(0)!);
    const y = [...b].map((c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
    return y.length - x.length;
  };
  const newest = (a: PublicItemRow, b: PublicItemRow) => (b.publishedAt?.getTime() ?? Infinity) - (a.publishedAt?.getTime() ?? Infinity) || idDesc(a.itemId, b.itemId);
  const reads = {
    publicCollections: async () => [...new Set(all.map((r) => r.collection))].sort(),
    // As the database answers: each stream newest first past its skip, merged newest first, ties by id then stream.
    llmsNewest: async (o: { streams: Array<{ collection: string; locale: string | null; skip: number }>; perStream: number; limit: number }) => {
      calls.push({ streams: o.streams.map((x) => `${x.collection}:${x.locale ?? '*'}`), limit: o.limit });
      return o.streams
        .flatMap((x, stream) =>
          all
            .filter((r) => r.collection === x.collection && (x.locale === null || r.locale === x.locale))
            .sort(newest)
            .slice(x.skip, x.skip + o.perStream)
            .map((r) => ({ ...r, stream })),
        )
        .sort((a, b) => newest(a, b) || a.stream - b.stream)
        .slice(0, o.limit);
    },
    // In the order of `ids`, as the real read.
    itemsByIds: async (ids: string[]) => ids.flatMap((id) => all.filter((r) => r.itemId === id)),
  } as unknown as DiscoveryContext['reads'];
  const availableLocales = opts.locales ?? (opts.zh ? ['en', 'zh'] : ['en']);
  const site = { name: opts.name ?? 'Sample site', defaultLanguage: 'en', settings: { availableLocales }, seo: defaultSeoSettings() };
  const space = spaceOf('s1', 'en', { availableLocales, localeStrategy: opts.zh ? 'domain' : 'subdirectory' } as never, [
    { hostname: HOST, locale: null, isPrimary: true },
    ...(opts.zh ? [{ hostname: ZH_HOST, locale: 'zh', isPrimary: false }] : []),
  ]);
  return { calls, ctx: { reads, site, host: opts.host ?? HOST, space, now: Date.UTC(2026, 1, 1) } as unknown as DiscoveryContext };
}

describe('llms selection', () => {
  it('the newest listed pages (shown by title) and articles (newest first), one read each when they are listed', async () => {
    const pages = Array.from({ length: 1500 }, (_, i) => row(i, 'pages'));
    const articles = Array.from({ length: 1500 }, (_, i) => row(i, 'articles'));
    const { calls, ctx } = context(pages, articles);
    const txt = (await discoveryAnswer({ kind: 'llms', full: false }, ctx))!.body;
    expect(calls).toEqual([
      { streams: ['pages:*'], limit: 50 },
      { streams: ['articles:*'], limit: 30 },
    ]);
    expect(txt.match(/^- \[pages [0-9]+/gm)!.slice(0, 2)).toEqual(['- [pages 1450', '- [pages 1451']);
    expect(txt.match(/^- \[pages /gm)).toHaveLength(50);
    expect(txt.match(/^- \[articles [0-9]+/gm)!.slice(0, 2)).toEqual(['- [articles 1499', '- [articles 1498']);
    expect(txt.match(/^- \[articles /gm)).toHaveLength(30);
  });

  it('what is not listed is passed over: at most 2,000 rows, in a handful of reads, however many collections (Codex review of batch 9, rounds 3–7)', async () => {
    const elsewhere = (r: PublicItemRow) => ({ ...r, data: { ...r.data, canonical_url: 'https://example.org/original/' } });
    const pages = Array.from({ length: 100 }, (_, c) => Array.from({ length: 50 }, (_, i) => elsewhere(row(i, `guides${String(c).padStart(3, '0')}`)))).flat();
    const { calls, ctx } = context(pages, [row(1, 'articles', 'noindex,follow')]);
    const txt = (await discoveryAnswer({ kind: 'llms', full: false }, ctx))!.body;
    expect(txt).not.toMatch(/## Pages|## Recent/);
    const pageReads = calls.filter((c) => !c.streams.includes('articles:*'));
    expect(pageReads.reduce((n, c) => n + c.limit, 0)).toBe(2000);
    expect(pageReads.length).toBeLessThanOrEqual(15);
    // Each of the 100 collections is a stream of each read (the limit of streams).
    expect(pageReads[0]!.streams).toHaveLength(100);
  });

  it('at most 100 streams, the first by name: a 101st collection is not read (Codex review of batch 9, round 9)', async () => {
    const pages = Array.from({ length: 101 }, (_, c) => row(c, `c${String(c).padStart(3, '0')}`));
    const { calls, ctx } = context(pages, []);
    const txt = (await discoveryAnswer({ kind: 'llms', full: false }, ctx))!.body;
    expect(calls.every((c) => c.streams.length === 100)).toBe(true);
    expect(calls[0]!.streams.at(-1)).toBe('c099:*');
    expect(txt).toContain('- [c099 99]');
    expect(txt).not.toContain('c100');
  });

  it('a newer listed page in the last collection is found, however many unlisted rows the others have (Codex review of batch 9, round 7)', async () => {
    const elsewhere = (r: PublicItemRow) => ({ ...r, data: { ...r.data, canonical_url: 'https://example.org/original/' } });
    const pages = [...Array.from({ length: 40 }, (_, c) => Array.from({ length: 50 }, (_, i) => elsewhere(row(i, `a${String(c).padStart(2, '0')}`)))).flat(), row(5000, 'zzz')];
    const txt = (await discoveryAnswer({ kind: 'llms', full: false }, context(pages, []).ctx))!.body;
    expect(txt).toContain('- [zzz 5000]');
  });

  it('two hosts (one per language): each lists its own language, however many newer items the other has (Codex review of batch 9, round 5)', async () => {
    const pages = [...Array.from({ length: 1200 }, (_, i) => row(1000 + i, 'pages')), ...Array.from({ length: 3 }, (_, i) => row(i, 'pages', null, 'zh', ZH_HOST))];
    const articles = [...Array.from({ length: 1200 }, (_, i) => row(1000 + i, 'articles')), row(1, 'articles', null, 'zh', ZH_HOST)];
    const zh = context(pages, articles, { zh: true, host: ZH_HOST });
    const txt = (await discoveryAnswer({ kind: 'llms', full: false }, zh.ctx))!.body;
    expect(txt.match(/^- \[pages /gm)).toHaveLength(3);
    expect(txt.match(/^- \[articles /gm)).toHaveLength(1);
    expect(zh.calls.every((c) => c.streams.every((x) => x.endsWith(':zh')))).toBe(true);
    const en = context(pages, articles, { zh: true });
    expect((await discoveryAnswer({ kind: 'llms', full: false }, en.ctx))!.body).not.toContain(ZH_HOST);
    expect(en.calls.every((c) => c.streams.every((x) => x.endsWith(':en')))).toBe(true);
  });

  it('streams merge newest first, ties by the larger id in code-point order (Codex review of batch 9, rounds 6 and 7)', async () => {
    const same = new Date(Date.UTC(2026, 0, 1));
    const at = (r: PublicItemRow) => ({ ...r, publishedAt: same });
    // When only some fit, the ones chosen are those with the larger ids, whichever collection they are in.
    const tied = [...Array.from({ length: 150 }, (_, i) => at(row(i, 'guides'))), ...Array.from({ length: 150 }, (_, i) => at(row(i, 'pages')))];
    const chosen = (await discoveryAnswer({ kind: 'llms', full: true }, context(tied, []).ctx))!.body;
    expect(chosen.match(/^# pages /gm)).toHaveLength(150);
    expect(chosen.match(/^# guides /gm)).toHaveLength(50);
    expect(chosen).toContain('# guides 149');
    expect(chosen).not.toContain('# guides 99\n');
    // Two places left: the two largest ids, an id beyond the BMP above a letter (code points, not UTF-16 units).
    const art = [at(row(1, 'articles')), at(row(2, 'articles')), at(row(3, 'articles'))].map((r, i) => ({ ...r, itemId: ['b', '\u{1F600}', 'a'][i]! }));
    const few = context(Array.from({ length: 198 }, (_, i) => row(i, 'pages')), art);
    const full = (await discoveryAnswer({ kind: 'llms', full: true }, few.ctx))!.body;
    expect(full.match(/^# articles [0-9]/gm)).toEqual(['# articles 2', '# articles 1']);
  });

  it('llms-full.txt reads no articles once its pages fill it, and only as many as its places left', async () => {
    const pages = Array.from({ length: 300 }, (_, i) => row(i, 'pages'));
    const articles = Array.from({ length: 500 }, (_, i) => row(i, 'articles'));
    const { calls, ctx } = context(pages, articles);
    await discoveryAnswer({ kind: 'llms', full: true }, ctx);
    expect(calls.filter((c) => c.streams.includes('articles:*'))).toEqual([]);
    const few = context(pages.slice(0, 195), articles);
    const full = (await discoveryAnswer({ kind: 'llms', full: true }, few.ctx))!.body;
    expect(few.calls.filter((c) => c.streams.includes('articles:*'))).toEqual([{ streams: ['articles:*'], limit: 5 }]);
    expect(full.match(/^# articles /gm)).toHaveLength(5);
  });

  it('llms-full.txt escapes the site name and summary as llms.txt does', async () => {
    const { ctx } = context([row(1, 'pages')], [], { name: '<img src=x onerror=alert(1)> # [x]' });
    const full = (await discoveryAnswer({ kind: 'llms', full: true }, ctx))!.body;
    expect(full.startsWith('# \\<img src=x onerror=alert(1)\\> \\# \\[x\\]\n\n> \\<img src=x onerror=alert(1)\\> \\# \\[x\\].\n')).toBe(true);
    expect(full.split('---')[0]).not.toMatch(/(^|[^\\])</);
  });
});
