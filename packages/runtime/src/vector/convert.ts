/**
 * Convert embeddings stored as JSONB arrays in `lumibase_ai_embeddings` into
 * vector spaces (HeoPress P03 task 5.3). Repeatable: each row maps to one
 * entry keyed by its id, so running it again rewrites the same entries and
 * changes nothing.
 *
 * Every row goes to the space of its own model and dimension. A site with no
 * active model gets the space holding most of its converted rows; a site that
 * already has one keeps it. Rows that are not numeric arrays are reported and
 * skipped. `lumibase_agent_memory.embedding` records no model, so it cannot be
 * placed in a space safely and is not converted (it is re-embedded instead).
 */
import type postgres from 'postgres';
import { inSiteScope, type PgVectorStore, type VectorSpace } from './store';

export interface ConversionReport {
  converted: number;
  skipped: number;
  spaces: Array<{ id: string; model: string; dimension: number; rows: number }>;
}

interface LegacyRow {
  id: string;
  site_id: string;
  collection: string;
  item_id: string | null;
  field_name: string | null;
  chunk_text: string;
  embedding: unknown;
  model: string;
}

/**
 * Every site's rows (`lumibase_sites`, which has no row-level security), or only `siteIds`'; each site is read and
 * written in its own scope (HeoPress P14, ADR-0023).
 */
export async function convertJsonbEmbeddings(
  sql: postgres.Sql,
  store: PgVectorStore,
  opts: { batchSize?: number; siteIds?: string[] } = {},
): Promise<ConversionReport> {
  const batchSize = opts.batchSize ?? 500;
  const siteIds = opts.siteIds ?? (await sql<{ id: string }[]>`SELECT id FROM lumibase_sites ORDER BY id`).map((r) => r.id);
  const spaces = new Map<string, { space: VectorSpace; rows: number }>();
  let converted = 0;
  let skipped = 0;
  for (const siteId of siteIds) {
    const counts = new Map<string, number>();
    let after = '';
    for (;;) {
      const rows = await inSiteScope(sql, siteId, (tx) => tx<LegacyRow[]>`
        SELECT id, site_id, collection, item_id, field_name, chunk_text, embedding, model
          FROM lumibase_ai_embeddings WHERE site_id = ${siteId} AND id > ${after} ORDER BY id LIMIT ${batchSize}`);
      if (rows.length === 0) break;
      after = rows.at(-1)!.id;
      for (const r of rows) {
        const vector = Array.isArray(r.embedding) && r.embedding.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (r.embedding as number[]) : null;
        if (!vector || vector.length === 0) {
          skipped += 1;
          continue;
        }
        const key = `${r.model}\u0000${vector.length}`;
        let entry = spaces.get(key);
        if (!entry) {
          entry = { space: await store.ensureSpace(r.model, vector.length), rows: 0 };
          spaces.set(key, entry);
        }
        await store.upsert(entry.space, [
          {
            siteId: r.site_id,
            sourceType: 'legacy_ai_embedding',
            sourceId: r.id,
            revision: '',
            // Legacy rows carry no purpose; staff-facing is the narrower use.
            purpose: 'internal_writing',
            content: r.chunk_text,
            embedding: vector,
            metadata: { collection: r.collection, itemId: r.item_id, fieldName: r.field_name },
          },
        ]);
        entry.rows += 1;
        converted += 1;
        counts.set(entry.space.id, (counts.get(entry.space.id) ?? 0) + 1);
      }
    }
    if (counts.size === 0) continue;
    const [spaceId] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    await inSiteScope(sql, siteId, (tx) => tx`
      INSERT INTO lumibase_vector_site_models (site_id, active_space_id) VALUES (${siteId}, ${spaceId})
      ON CONFLICT (site_id) DO UPDATE SET active_space_id = EXCLUDED.active_space_id, updated_at = now()
        WHERE lumibase_vector_site_models.active_space_id IS NULL`);
  }
  return {
    converted,
    skipped,
    spaces: [...spaces.values()].map(({ space, rows }) => ({ id: space.id, model: space.model, dimension: space.dimension, rows })),
  };
}
