import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresSearchProvider, SearchFilterError, detectLanguage, parseFilter } from '../adapters/postgres/search';
import { searchIndexName } from '../interfaces';
import { PG_URL, connectRuntimeDb } from './helpers/pg';

/**
 * PostgreSQL full-text search (P03 task 5.1; spec "站点隔离的全文检索"):
 * Chinese and English matching, typo tolerance, site isolation, filters,
 * sorting and paging. Runs against whatever DATABASE_URL offers: with the
 * HeoPress database image Chinese goes through zhparser, on a stock
 * postgres:18 through the pg_trgm fallback — CI runs both.
 */

const A = searchIndexName('site_search_a', 'posts');
const B = searchIndexName('site_search_b', 'posts');

describe('language detection and filter parsing', () => {
  it('detects Chinese, English and other text', () => {
    expect(detectLanguage('站群内容管理')).toBe('zh');
    expect(detectLanguage('Content management for site networks')).toBe('en');
    expect(detectLanguage('Quản lý nội dung')).toBe('simple');
  });

  it('parses the supported subset and rejects the rest', () => {
    expect(parseFilter('status = "published" AND views > 10 OR featured = true')).toEqual([
      [{ attr: 'status', op: '=', value: 'published' }, { attr: 'views', op: '>', value: 10 }],
      [{ attr: 'featured', op: '=', value: true }],
    ]);
    for (const bad of ['status IN [a, b]', 'status = ', '(a = 1)', 'a = 1 XOR b = 2', "a = 1; DROP TABLE x"]) {
      expect(() => parseFilter(bad), bad).toThrow(SearchFilterError);
    }
  });
});

describe.skipIf(!PG_URL)('PostgresSearchProvider (PostgreSQL)', () => {
  let sql: postgres.Sql;
  let search: PostgresSearchProvider;

  beforeAll(async () => {
    sql = await connectRuntimeDb(4);
    search = new PostgresSearchProvider(sql);
  });

  beforeEach(async () => {
    await sql`DELETE FROM lumibase_search_documents WHERE index_name IN (${A}, ${B})`;
    await sql`DELETE FROM lumibase_search_indexes WHERE index_name IN (${A}, ${B})`;
    await search.configureIndex(A, { searchableAttributes: ['_title', 'body'] });
    await search.index(A, [
      { id: 'zh1', _title: '站群运营指南', body: '本文介绍内容管理系统的全文检索与站点隔离。', status: 'published', views: 30 },
      { id: 'zh2', _title: '采集与翻译', body: '自动采集外部内容并翻译为中文。', status: 'draft', views: 5 },
      { id: 'en1', _title: 'Running a site network', body: 'How editors search content across many sites.', status: 'published', views: 12 },
      { id: 'en2', _title: 'Deployment notes', body: 'Caddy, Docker and PostgreSQL on a small VPS.', status: 'published', views: 50 },
    ]);
    await search.index(B, [{ id: 'b1', _title: '仅存在于站点B的秘密词语', body: 'exclusiveword appears only in site B', status: 'published' }]);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM lumibase_search_documents WHERE index_name IN (${A}, ${B})`;
    await sql`DELETE FROM lumibase_search_indexes WHERE index_name IN (${A}, ${B})`;
    await sql.end({ timeout: 1 });
  });

  const ids = async (q: string, opts = {}) => (await search.search<{ id: string }>(A, q, opts)).hits.map((h) => h.id);

  it('finds a Chinese article by a word in its body', async () => {
    expect(await ids('全文检索')).toContain('zh1');
    expect(await ids('翻译')).toEqual(['zh2']);
  });

  it('matches English by stem and tolerates a typo', async () => {
    expect(await ids('run')).toContain('en1'); // "Running"
    expect(await ids('deploymnet')).toContain('en2');
  });

  it('never returns another site\'s documents', async () => {
    expect(await ids('秘密词语')).toEqual([]);
    expect(await ids('exclusiveword')).toEqual([]);
    expect((await search.search<{ id: string }>(B, 'exclusiveword')).hits.map((h) => h.id)).toEqual(['b1']);
  });

  it('filters, sorts and pages', async () => {
    const published = await ids('site', { filter: 'status = "published"' });
    expect(published).not.toContain('zh2');
    const sorted = await search.search<{ id: string; views: number }>(A, 'a', { filter: 'status = "published" AND views >= 12', sort: ['views:desc'] });
    expect(sorted.hits.map((h) => h.views)).toEqual([...sorted.hits.map((h) => h.views)].sort((x, y) => y - x));
    const page = await search.search<{ id: string }>(A, '内容', { limit: 1, offset: 0 });
    expect(page.hits).toHaveLength(1);
    expect(page.totalHits).toBeGreaterThanOrEqual(1);
    await expect(search.search(A, 'x', { filter: 'status IN [a]' })).rejects.toBeInstanceOf(SearchFilterError);
  });

  it('sorts numbers as numbers and reports the total on a page past the end (Codex review 4, #9-#10)', async () => {
    await search.index(A, [
      { id: 'n2', _title: 'numeric sort two', views: 2 },
      { id: 'n10', _title: 'numeric sort ten', views: 10 },
      { id: 'n9', _title: 'numeric sort nine', views: 9 },
    ]);
    const desc = await search.search<{ id: string }>(A, 'numeric sort', { sort: ['views:desc'] });
    expect(desc.hits.map((h) => h.id)).toEqual(['n10', 'n9', 'n2']);
    const asc = await search.search<{ id: string }>(A, 'numeric sort', { sort: ['views:asc'] });
    expect(asc.hits.map((h) => h.id)).toEqual(['n2', 'n9', 'n10']);
    const past = await search.search(A, 'numeric sort', { offset: 50 });
    expect(past.hits).toEqual([]);
    expect(past.totalHits).toBe(3);
  });

  it('projects attributes, deletes documents and counts the index', async () => {
    const hit = (await search.search<Record<string, unknown>>(A, '指南', { attributesToRetrieve: ['id', '_title'] })).hits[0]!;
    expect(Object.keys(hit).sort()).toEqual(['_title', 'id']);
    expect((await search.getIndex(A)).numberOfDocuments).toBe(4);
    await search.delete(A, ['zh1']);
    expect(await ids('全文检索')).not.toContain('zh1');
    expect((await search.getIndex(A)).numberOfDocuments).toBe(3);
  });

  it('stores documents as JSON objects on a plain client as well as on a Drizzle-shared one', async () => {
    const plain = postgres(PG_URL!, { max: 1, onnotice: () => {}, prepare: false });
    try {
      await new PostgresSearchProvider(plain).index(A, [{ id: 'plain1', _title: 'Plain client', body: 'x' }]);
      const [row] = await sql<{ t: string }[]>`SELECT jsonb_typeof(document) AS t FROM lumibase_search_documents WHERE index_name = ${A} AND doc_id = 'plain1'`;
      expect(row!.t).toBe('object');
      const [cfg] = await sql<{ t: string }[]>`SELECT jsonb_typeof(settings) AS t FROM lumibase_search_indexes WHERE index_name = ${A}`;
      expect(cfg!.t).toBe('object');
    } finally {
      await plain.end({ timeout: 1 });
    }
  });

  it('re-indexing a document replaces it', async () => {
    await search.index(A, [{ id: 'en2', _title: 'Backup notes', body: 'Restore drills', status: 'published' }]);
    expect(await ids('deployment')).not.toContain('en2');
    expect(await ids('restore')).toContain('en2');
  });
});
