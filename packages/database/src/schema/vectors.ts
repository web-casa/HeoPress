import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sites } from './core';

/**
 * Vector retrieval bookkeeping (HeoPress P03 tasks 5.3–5.5; design "向量").
 *
 * Vectors of different models or dimensions never share a table or an index.
 * Each (model, dimension) pair is a *vector space* with its own table,
 * `lumibase_vectors_<space id>`, holding a pgvector column of exactly that
 * dimension and its own HNSW index. Those tables are created at runtime, and
 * only when vector search is enabled (`HEOPRESS_VECTOR_SEARCH=true`), so the
 * base migrations never need the vector extension.
 *
 * A site queries one active space at a time. Switching models builds the new
 * space alongside (`building_space_id`), activates it, and keeps the previous
 * one (`previous_space_id`) so the switch can be rolled back.
 */
export const vectorSpaces = pgTable(
  'lumibase_vector_spaces',
  {
    id: text('id').primaryKey(),
    model: text('model').notNull(),
    dimension: integer('dimension').notNull(),
    /** `vector` up to 2000 dimensions, `halfvec` up to 4000 (HNSW limits). */
    columnType: text('column_type').notNull(),
    tableName: text('table_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    modelDimension: uniqueIndex('vector_spaces_model_dimension_idx').on(t.model, t.dimension),
    tableNameIdx: uniqueIndex('vector_spaces_table_name_idx').on(t.tableName),
    dimensionRange: check('vector_spaces_dimension_range', sql`${t.dimension} BETWEEN 1 AND 4000`),
  }),
);

export const vectorSiteModels = pgTable('lumibase_vector_site_models', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  activeSpaceId: text('active_space_id').references(() => vectorSpaces.id),
  previousSpaceId: text('previous_space_id').references(() => vectorSpaces.id),
  buildingSpaceId: text('building_space_id').references(() => vectorSpaces.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Permission generation per site: bumped by triggers whenever a role, policy,
 * permission, role–policy link or site membership of the site changes.
 * Vector entries record the generation they were indexed under; retrieval
 * hands both to the verifier, which re-checks access for every candidate.
 */
export const accessGenerations = pgTable('lumibase_access_generations', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  generation: bigint('generation', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
