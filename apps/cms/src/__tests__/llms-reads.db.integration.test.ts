import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { publicItems, sites, type Database } from '@heopress/database';
import { renderPort } from '@heopress/site-classic/read-port';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * `llms.txt`'s candidate read against the database (HeoPress P07 task 4.1; Codex review of batch 9, round 8): the streams
 * merged newest first, ties by id in code-point order then by stream; each stream past its `skip`, at most `perStream`;
 * one language or all; the body left out.
 */

const SITE = 'site_p07_llms_reads';

describe.skipIf(!hasDbIntegrationUrl)('llms candidate reads — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('llms-reads');
  });
  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, [SITE]));
  });
  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [SITE]));
    await db.insert(sites).values({ id: SITE, name: 'llms reads', defaultLanguage: 'en' });
    const at = (minute: number | null) => (minute === null ? null : new Date(Date.UTC(2026, 0, 1, 0, minute)));
    const rows: Array<[string, string, string, number | null]> = [
      // id, collection, locale, minute
      ['a', 'guides', 'en', 5],
      ['b', 'pages', 'en', 5],
      ['\u{1F600}', 'pages', 'en', 5],
      ['￿', 'guides', 'en', 5],
      ['g1', 'guides', 'en', 3],
      ['p1', 'pages', 'en', 4],
      ['p0', 'pages', 'en', null],
      ['z1', 'pages', 'zh', 9],
    ];
    await runSiteTransaction(db, SITE, (tx) =>
      tx.insert(publicItems).values(
        rows.map(([itemId, collection, locale, minute]) => ({
          itemId: `${SITE}:${itemId}`,
          siteId: SITE,
          collection,
          locale,
          path: `/${itemId}`,
          data: { title: itemId, body: '<p>BODY</p>' },
          card: { url: `https://llms-reads.example.com/${encodeURIComponent(itemId)}/` },
          publishedAt: at(minute),
          updatedAt: new Date(),
          sanitizer: 1,
        })),
      ),
    );
  });

  const read = (opts: Parameters<import('@heopress/site-classic/read-port').SiteReads['llmsNewest']>[0]) =>
    renderPort(db).request(SITE, (_p, reads) => reads.llmsNewest(opts));
  const ids = (rows: Array<{ itemId: string; stream: number }>) => rows.map((r) => [r.itemId.slice(SITE.length + 1), r.stream]);

  it('merged newest first (undated first); ties by id in code points (beyond the BMP above U+FFFF), then by stream', async () => {
    const rows = await read({ streams: [{ collection: 'guides', locale: null, skip: 0 , listable: { defaultIndexable: true } }, { collection: 'pages', locale: null, skip: 0 , listable: { defaultIndexable: true } }], perStream: 10, limit: 10 });
    expect(ids(rows)).toEqual([
      ['p0', 1],
      ['z1', 1],
      ['\u{1F600}', 1],
      ['￿', 0],
      ['b', 1],
      ['a', 0],
      ['p1', 1],
      ['g1', 0],
    ]);
    expect(rows.every((r) => !('body' in r.data) && r.data.title !== undefined)).toBe(true);
    expect(rows[0]!.publishedAt).toBeNull();
    expect(rows[1]!.publishedAt).toBeInstanceOf(Date);
  });

  it('each stream past its skip, at most perStream; the limit over the merge; one language', async () => {
    const page = await read({ streams: [{ collection: 'guides', locale: 'en', skip: 1 , listable: { defaultIndexable: true } }, { collection: 'pages', locale: 'en', skip: 2 , listable: { defaultIndexable: true } }], perStream: 2, limit: 3 });
    // Guides past '￿': a, g1; English pages past p0 and the emoji: b, p1 — merged, three.
    expect(ids(page)).toEqual([
      ['b', 1],
      ['a', 0],
      ['p1', 1],
    ]);
    expect(page.some((r) => r.locale === 'zh')).toBe(false);
    expect(await read({ streams: [], perStream: 5, limit: 5 })).toEqual([]);
  });
});
