import type postgres from 'postgres';
import type { SearchIndexSettings, SearchOptions, SearchProvider, SearchResult } from '../../interfaces';

/**
 * Full-text search on PostgreSQL (HeoPress P03 task 5.1) — the default; the
 * MeiliSearch adapter is optional (task 5.2).
 *
 * Tenant isolation: every statement is filtered by the index name
 * (`<siteId>__<collection>`), the same boundary MeiliSearch uses.
 *
 * Language: a document whose text contains CJK characters is indexed with the
 * zhparser configuration `heopress_zh` when it exists, otherwise `simple`;
 * mostly-Latin text uses `english`; anything else `simple`. Queries are
 * matched three ways and ranked in this order:
 *   1. full text (`websearch_to_tsquery` in the query's language);
 *   2. substring (`search_text ILIKE %q%`), which also finds Chinese words
 *      when zhparser is missing;
 *   3. trigram word similarity (`pg_trgm`), which tolerates typos.
 *
 * Filters accept a subset of MeiliSearch's syntax: `attr = value`, `!=`, `>`,
 * `>=`, `<`, `<=`, joined by `AND` / `OR` (AND binds tighter), values as
 * numbers, booleans or quoted strings. Anything else is rejected with
 * `SearchFilterError` rather than ignored. `sort` takes `attr:asc|desc`.
 *
 * Values are passed as text with explicit casts: the connection is shared
 * with Drizzle, which replaces postgres.js's JSON and timestamp serializers.
 */

export class SearchFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchFilterError';
  }
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
const ATTR = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** pg_trgm word_similarity: best match of the query against any word span of the text. */
const TRGM_THRESHOLD = 0.5;

type Lang = 'zh' | 'en' | 'simple';

export function detectLanguage(text: string): Lang {
  if (CJK.test(text)) return 'zh';
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 'simple';
  const ascii = letters.filter((ch) => /[A-Za-z]/.test(ch)).length;
  return ascii / letters.length > 0.9 ? 'en' : 'simple';
}

type Condition = { attr: string; op: string; value: string | number | boolean };

/** Parse the supported filter subset into OR-of-AND groups. */
export function parseFilter(filter: string): Condition[][] {
  const tokens = filter.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|!=|>=|<=|[=<>]|\S+?(?=\s|$|!=|>=|<=|[=<>])/g);
  if (!tokens) throw new SearchFilterError('empty filter');
  const groups: Condition[][] = [[]];
  let i = 0;
  const value = (raw: string): string | number | boolean => {
    if (/^"(.*)"$/.test(raw) || /^'(.*)'$/.test(raw)) return raw.slice(1, -1).replace(/\\(.)/g, '$1');
    if (raw === 'true' || raw === 'false') return raw === 'true';
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (/^[A-Za-z0-9_.:-]+$/.test(raw)) return raw;
    throw new SearchFilterError(`unsupported value ${raw}`);
  };
  while (i < tokens.length) {
    const attr = tokens[i++]!;
    const op = tokens[i++];
    const raw = tokens[i++];
    if (!ATTR.test(attr) || !op || !['=', '!=', '>', '>=', '<', '<='].includes(op) || raw === undefined) {
      throw new SearchFilterError(`unsupported filter near "${attr}"`);
    }
    groups.at(-1)!.push({ attr, op, value: value(raw) });
    const joiner = tokens[i];
    if (joiner === undefined) break;
    i++;
    if (/^and$/i.test(joiner)) continue;
    if (/^or$/i.test(joiner)) groups.push([]);
    else throw new SearchFilterError(`unsupported filter operator "${joiner}"`);
  }
  if (groups.some((g) => g.length === 0)) throw new SearchFilterError('dangling AND/OR');
  return groups;
}

function conditionSql(sql: postgres.Sql, c: Condition): postgres.PendingQuery<postgres.Row[]> | postgres.Fragment {
  const field = sql`document ->> ${c.attr}`;
  if (typeof c.value === 'number') {
    const num = sql`(CASE WHEN jsonb_typeof(document -> ${c.attr}) = 'number' THEN (document ->> ${c.attr})::numeric END)`;
    switch (c.op) {
      case '=': return sql`${num} = ${c.value}`;
      case '!=': return sql`${num} IS DISTINCT FROM ${c.value}`;
      case '>': return sql`${num} > ${c.value}`;
      case '>=': return sql`${num} >= ${c.value}`;
      case '<': return sql`${num} < ${c.value}`;
      default: return sql`${num} <= ${c.value}`;
    }
  }
  const v = String(c.value);
  switch (c.op) {
    case '=': return sql`${field} = ${v}`;
    case '!=': return sql`${field} IS DISTINCT FROM ${v}`;
    case '>': return sql`${field} > ${v}`;
    case '>=': return sql`${field} >= ${v}`;
    case '<': return sql`${field} < ${v}`;
    default: return sql`${field} <= ${v}`;
  }
}

export class PostgresSearchProvider implements SearchProvider {
  private zhConfig: Promise<string> | null = null;

  constructor(private readonly sql: postgres.Sql) {}

  /** `heopress_zh` when zhparser is set up, otherwise `simple` (+ pg_trgm). */
  private chineseConfig(): Promise<string> {
    if (!this.zhConfig) {
      this.zhConfig = this.sql<{ ok: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'heopress_zh') AS ok`.then(
        (r) => (r[0]?.ok ? 'heopress_zh' : 'simple'),
        () => {
          this.zhConfig = null;
          return 'simple';
        },
      );
    }
    return this.zhConfig;
  }

  private async configFor(lang: Lang): Promise<string> {
    if (lang === 'zh') return this.chineseConfig();
    return lang === 'en' ? 'english' : 'simple';
  }

  private async searchable(indexName: string): Promise<string[] | null> {
    const rows = await this.sql<{ settings: SearchIndexSettings }[]>`
      SELECT settings FROM lumibase_search_indexes WHERE index_name = ${indexName}`;
    const attrs = rows[0]?.settings?.searchableAttributes;
    return attrs && attrs.length > 0 && !attrs.includes('*') ? attrs : null;
  }

  async configureIndex(indexName: string, settings: SearchIndexSettings): Promise<void> {
    await this.sql`
      INSERT INTO lumibase_search_indexes (index_name, settings)
      VALUES (${indexName}, ${JSON.stringify(settings)}::text::jsonb)
      ON CONFLICT (index_name) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`;
  }

  async index(indexName: string, documents: Record<string, unknown>[]): Promise<void> {
    if (documents.length === 0) return;
    const attrs = await this.searchable(indexName);
    for (const doc of documents) {
      const id = doc.id;
      if (typeof id !== 'string' && typeof id !== 'number') throw new Error('search documents need an id');
      const pick = attrs ?? Object.keys(doc).filter((k) => k !== 'id');
      // The first searchable attribute (the title) weighs more.
      const parts = pick.map((k) => doc[k]).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
      const head = parts.length > 0 ? String(parts[0]) : '';
      const rest = parts.slice(1).map(String).join(' ');
      const text = `${head} ${rest}`.trim();
      const lang = detectLanguage(text);
      const cfg = await this.configFor(lang);
      await this.sql`
        INSERT INTO lumibase_search_documents (index_name, doc_id, document, language, search_text, tsv)
        VALUES (
          ${indexName}, ${String(id)}, ${JSON.stringify(doc)}::text::jsonb, ${lang}, ${text},
          setweight(to_tsvector(${cfg}::regconfig, ${head}), 'A') || setweight(to_tsvector(${cfg}::regconfig, ${rest}), 'B')
        )
        ON CONFLICT (index_name, doc_id) DO UPDATE SET
          document = EXCLUDED.document, language = EXCLUDED.language,
          search_text = EXCLUDED.search_text, tsv = EXCLUDED.tsv, updated_at = now()`;
    }
  }

  async search<T = Record<string, unknown>>(indexName: string, query: string, options: SearchOptions = {}): Promise<SearchResult<T>> {
    const started = Date.now();
    const q = query.trim();
    const cfg = await this.configFor(detectLanguage(q));
    const groups = options.filter ? parseFilter(options.filter) : [];
    const filterSql = groups.length
      ? this.sql`AND (${groups
          .map((g) => this.sql`(${g.map((c) => conditionSql(this.sql, c)).reduce((a, b) => this.sql`${a} AND ${b}`)})`)
          .reduce((a, b) => this.sql`${a} OR ${b}`)})`
      : this.sql``;
    const sorts = (options.sort ?? []).map((s) => {
      const [attr, dir = 'asc'] = s.split(':');
      if (!attr || !ATTR.test(attr) || !/^(asc|desc)$/i.test(dir)) throw new SearchFilterError(`unsupported sort "${s}"`);
      // Numbers sort as numbers (2 before 10), everything else as text.
      const num = this.sql`(CASE WHEN jsonb_typeof(document -> ${attr}) = 'number' THEN (document ->> ${attr})::numeric END)`;
      const txt = this.sql`(CASE WHEN jsonb_typeof(document -> ${attr}) <> 'number' THEN document ->> ${attr} END)`;
      return dir.toLowerCase() === 'desc'
        ? this.sql`${num} DESC NULLS LAST, ${txt} DESC NULLS LAST`
        : this.sql`${num} ASC NULLS LAST, ${txt} ASC NULLS LAST`;
    });
    const orderBy = sorts.length
      ? this.sql`${sorts.reduce((a, b) => this.sql`${a}, ${b}`)}, rank DESC, doc_id`
      : this.sql`rank DESC, doc_id`;
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const limit = Math.min(Math.max(options.limit ?? 20, 0), 1000);
    const offset = Math.max(options.offset ?? 0, 0);

    // The total comes from its own row, so a page past the end still reports it.
    const rows = await this.sql<{ document: Record<string, unknown> | null; total: number }[]>`
      WITH q AS (SELECT websearch_to_tsquery(${cfg}::regconfig, ${q}) AS tsq),
      matched AS (
        SELECT d.doc_id, d.document,
               ts_rank(d.tsv, q.tsq) * 2
                 + CASE WHEN d.search_text ILIKE ${like} THEN 1 ELSE 0 END
                 + word_similarity(${q}, d.search_text) AS rank
          FROM lumibase_search_documents d, q
         WHERE d.index_name = ${indexName}
           AND (${q} = '' OR d.tsv @@ q.tsq OR d.search_text ILIKE ${like}
                OR word_similarity(${q}, d.search_text) > ${TRGM_THRESHOLD})
           ${filterSql}
      )
      SELECT c.total, p.document
        FROM (SELECT count(*)::int AS total FROM matched) c
        LEFT JOIN LATERAL (
          SELECT document, row_number() OVER (ORDER BY ${orderBy}) AS pos
            FROM matched ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}
        ) p ON true
       ORDER BY p.pos`;

    const pickAttrs = options.attributesToRetrieve;
    const pageRows = rows.filter((r): r is { document: Record<string, unknown>; total: number } => r.document !== null);
    const hits = pageRows.map((r) =>
      pickAttrs && !pickAttrs.includes('*')
        ? (Object.fromEntries(Object.entries(r.document).filter(([k]) => pickAttrs.includes(k))) as T)
        : (r.document as T),
    );
    return { hits, totalHits: rows[0]?.total ?? 0, processingTimeMs: Date.now() - started };
  }

  async delete(indexName: string, documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) return;
    await this.sql`
      DELETE FROM lumibase_search_documents WHERE index_name = ${indexName} AND doc_id = ANY(${documentIds}::text[])`;
  }

  async getIndex(indexName: string): Promise<{ numberOfDocuments: number }> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM lumibase_search_documents WHERE index_name = ${indexName}`;
    return { numberOfDocuments: rows[0]?.n ?? 0 };
  }
}
