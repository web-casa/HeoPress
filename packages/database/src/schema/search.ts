import { sql } from 'drizzle-orm';
import { customType, index, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Full-text search on PostgreSQL (HeoPress P03 task 5.1). The tenant boundary
 * is the index name, `<siteId>__<collection>` (`searchIndexName`), exactly as
 * with MeiliSearch: every read and write is filtered by it.
 *
 * `tsv` is built with the text search configuration matching the document's
 * language (zhparser's `heopress_zh` for Chinese when installed, `english`,
 * otherwise `simple`); `search_text` carries the same text for pg_trgm
 * substring and fuzzy matching (the Chinese fallback without zhparser).
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const searchDocuments = pgTable(
  'lumibase_search_documents',
  {
    indexName: text('index_name').notNull(),
    docId: text('doc_id').notNull(),
    document: jsonb('document').notNull(),
    language: text('language').notNull(),
    searchText: text('search_text').notNull(),
    tsv: tsvector('tsv').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.indexName, t.docId] }),
    tsvIdx: index('search_documents_tsv_idx').using('gin', t.tsv),
    trgmIdx: index('search_documents_trgm_idx').using('gin', t.searchText.op('gin_trgm_ops')),
  }),
);

/** Index settings (searchable attributes, …) per index name. */
export const searchIndexes = pgTable('lumibase_search_indexes', {
  indexName: text('index_name').primaryKey(),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
