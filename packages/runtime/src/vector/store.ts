/**
 * Vector retrieval on PostgreSQL + pgvector (HeoPress P03 tasks 5.3–5.5;
 * spec "站点隔离的向量检索", "检索命中后复核").
 *
 * Spaces. Every (model, dimension) pair is a vector space with its own table
 * (`lumibase_vectors_<id>`), a pgvector column of exactly that dimension and
 * its own HNSW index (cosine). Vectors of different models or dimensions are
 * never stored, indexed or compared together. Spaces are created on demand,
 * only when vector search is enabled; without the extension every call fails
 * with `VectorSearchUnavailableError` and nothing else is affected.
 *
 * Sites. A site queries one active space. Switching models:
 *   beginModelSwitch(site, model, dim)  → the new space is `building`;
 *   upsert(...) into it                 → re-embedded content;
 *   activateModel(site)                 → new space active, old kept as `previous`;
 *   rollbackModel(site)                 → the previous space is active again.
 * The previous space's entries stay until `dropPreviousModel(site)`.
 *
 * Entries record site, source, content revision, model, dimension, purpose
 * and the site's permission generation when indexed. Retrieval:
 *   1. only sites whose active space matches the query's model and dimension
 *      are searched — the others are reported as skipped, never mixed in;
 *   2. candidates come from one space at a time, filtered by site and purpose;
 *   3. **every** candidate — fresh or from the cache — goes through the
 *      caller's `verify`, which re-checks revision, permission, purpose and
 *      content eligibility against current records and returns the ones that
 *      may be used;
 *   4. when verification drops candidates, more are fetched with the same
 *      site, purpose and model filters — the criteria are never relaxed.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

export class VectorSearchUnavailableError extends Error {
  constructor(message = 'vector search needs the pgvector extension (HEOPRESS_VECTOR_SEARCH=true and the HeoPress database image)') {
    super(message);
    this.name = 'VectorSearchUnavailableError';
  }
}

export class VectorDimensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorDimensionError';
  }
}

/** `public_answer`: visitor-facing answers; `internal_writing`: staff writing aids. Checked separately. */
export type VectorPurpose = 'public_answer' | 'internal_writing';

export interface VectorSpace {
  id: string;
  model: string;
  dimension: number;
  columnType: 'vector' | 'halfvec';
  tableName: string;
}

export interface VectorEntryInput {
  siteId: string;
  sourceType: string;
  sourceId: string;
  /** Chunk number within the source (default 0). */
  chunk?: number;
  /** Content revision the vector was computed from. */
  revision: string;
  purpose: VectorPurpose;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorCandidate {
  siteId: string;
  sourceType: string;
  sourceId: string;
  chunk: number;
  revision: string;
  purpose: VectorPurpose;
  model: string;
  dimension: number;
  content: string;
  metadata: Record<string, unknown>;
  /** Cosine distance (0 = same direction). */
  distance: number;
  /** Site permission generation when the entry was indexed. */
  permissionGeneration: number;
  /** Site permission generation now. */
  currentPermissionGeneration: number;
}

/** Cache for raw candidate pages; whatever it returns is verified again. */
export interface VectorCandidateCache {
  get(key: string): Promise<VectorCandidate[] | null>;
  set(key: string, value: VectorCandidate[]): Promise<void>;
}

export interface VectorQuery {
  /** Sites the caller may read **now** (the caller computes them from current permissions). */
  siteIds: string[];
  purpose: VectorPurpose;
  model: string;
  vector: number[];
  limit?: number;
  /**
   * Re-check candidates against current records; return the usable ones —
   * a subset of the objects passed in (anything else is ignored).
   */
  verify: (candidates: VectorCandidate[]) => Promise<VectorCandidate[]>;
  cache?: VectorCandidateCache;
  /** Fetch rounds when verification drops candidates (default 4). */
  maxRounds?: number;
}

export interface VectorQueryResult {
  hits: VectorCandidate[];
  /** Sites not searched, and why (no active model, another model or dimension). */
  skipped: Array<{ siteId: string; reason: string }>;
}

const MAX_VECTOR_DIMENSION = 2000; // pgvector HNSW limit for `vector`
const MAX_HALFVEC_DIMENSION = 4000; // and for `halfvec`

export function spaceIdFor(model: string, dimension: number): string {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'model';
  const hash = createHash('sha256').update(`${model}\u0000${dimension}`).digest('hex').slice(0, 8);
  return `${slug}_${dimension}_${hash}`;
}

function literal(vector: number[]): string {
  for (const v of vector) if (!Number.isFinite(v)) throw new VectorDimensionError('vector components must be finite numbers');
  return `[${vector.join(',')}]`;
}

export class PgVectorStore {
  constructor(private readonly sql: postgres.Sql) {}

  async available(): Promise<boolean> {
    const rows = await this.sql<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`;
    return rows[0]?.ok === true;
  }

  private async requireExtension(): Promise<void> {
    if (!(await this.available())) throw new VectorSearchUnavailableError();
  }

  /** The space for (model, dimension), creating its table and HNSW index if needed. */
  async ensureSpace(model: string, dimension: number): Promise<VectorSpace> {
    if (!model.trim()) throw new VectorDimensionError('a model name is required');
    if (!Number.isInteger(dimension) || dimension < 1 || dimension > MAX_HALFVEC_DIMENSION) {
      throw new VectorDimensionError(`dimension must be an integer between 1 and ${MAX_HALFVEC_DIMENSION}`);
    }
    await this.requireExtension();
    const id = spaceIdFor(model, dimension);
    const columnType = dimension <= MAX_VECTOR_DIMENSION ? 'vector' : 'halfvec';
    const tableName = `lumibase_vectors_${id}`;
    const ops = columnType === 'vector' ? 'vector_cosine_ops' : 'halfvec_cosine_ops';
    await this.sql.begin(async (tx) => {
      // Serialize creation of the same space across processes.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`heopress:vector-space:${id}`}, 0))`;
      await tx.unsafe(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          site_id text NOT NULL REFERENCES lumibase_sites(id) ON DELETE CASCADE,
          source_type text NOT NULL,
          source_id text NOT NULL,
          chunk integer NOT NULL DEFAULT 0,
          purpose text NOT NULL CHECK (purpose IN ('public_answer', 'internal_writing')),
          revision text NOT NULL,
          model text NOT NULL CHECK (model = ${quote(model)}),
          dimension integer NOT NULL CHECK (dimension = ${dimension}),
          permission_generation bigint NOT NULL,
          content text NOT NULL,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
          embedding ${columnType}(${dimension}) NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (site_id, source_type, source_id, chunk, purpose)
        )`);
      await tx.unsafe(`CREATE INDEX IF NOT EXISTS ${tableName}_hnsw ON ${tableName} USING hnsw (embedding ${ops})`);
      await tx`
        INSERT INTO lumibase_vector_spaces (id, model, dimension, column_type, table_name)
        VALUES (${id}, ${model}, ${dimension}, ${columnType}, ${tableName})
        ON CONFLICT (id) DO NOTHING`;
    });
    return { id, model, dimension, columnType, tableName };
  }

  private async space(id: string): Promise<VectorSpace | null> {
    const rows = await this.sql<{ id: string; model: string; dimension: number; column_type: 'vector' | 'halfvec'; table_name: string }[]>`
      SELECT id, model, dimension, column_type, table_name FROM lumibase_vector_spaces WHERE id = ${id}`;
    const r = rows[0];
    return r ? { id: r.id, model: r.model, dimension: r.dimension, columnType: r.column_type, tableName: r.table_name } : null;
  }

  /** The site's active, previous and building spaces. */
  async siteModel(siteId: string): Promise<{ active: VectorSpace | null; previous: VectorSpace | null; building: VectorSpace | null }> {
    const rows = await this.sql<{ active_space_id: string | null; previous_space_id: string | null; building_space_id: string | null }[]>`
      SELECT active_space_id, previous_space_id, building_space_id FROM lumibase_vector_site_models WHERE site_id = ${siteId}`;
    const r = rows[0];
    const load = (id: string | null | undefined) => (id ? this.space(id) : Promise.resolve(null));
    return { active: await load(r?.active_space_id), previous: await load(r?.previous_space_id), building: await load(r?.building_space_id) };
  }

  /** Use (model, dimension) for a site that has no model yet, or start building it for a switch. */
  async beginModelSwitch(siteId: string, model: string, dimension: number): Promise<VectorSpace> {
    const space = await this.ensureSpace(model, dimension);
    await this.sql`
      INSERT INTO lumibase_vector_site_models (site_id, active_space_id, building_space_id)
      VALUES (${siteId}, NULL, ${space.id})
      ON CONFLICT (site_id) DO UPDATE SET building_space_id = EXCLUDED.building_space_id, updated_at = now()`;
    return space;
  }

  /** Make the building space active; the old active one is kept for rollback. */
  async activateModel(siteId: string): Promise<void> {
    const rows = await this.sql`
      UPDATE lumibase_vector_site_models
         SET previous_space_id = CASE WHEN active_space_id IS DISTINCT FROM building_space_id THEN active_space_id ELSE previous_space_id END,
             active_space_id = building_space_id, building_space_id = NULL, updated_at = now()
       WHERE site_id = ${siteId} AND building_space_id IS NOT NULL
       RETURNING 1`;
    if (rows.length === 0) throw new Error(`site ${siteId} has no model being built`);
  }

  /** Swap back to the previous space. */
  async rollbackModel(siteId: string): Promise<void> {
    const rows = await this.sql`
      UPDATE lumibase_vector_site_models
         SET active_space_id = previous_space_id, previous_space_id = active_space_id, updated_at = now()
       WHERE site_id = ${siteId} AND previous_space_id IS NOT NULL
       RETURNING 1`;
    if (rows.length === 0) throw new Error(`site ${siteId} has no previous model to roll back to`);
  }

  /**
   * Delete the previous space's entries for the site once the switch is
   * final. Runs under the site's binding row lock, so a concurrent rollback
   * either happens first (and then nothing active is deleted) or waits.
   */
  async dropPreviousModel(siteId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [binding] = await tx<{ active_space_id: string | null; previous_space_id: string | null }[]>`
        SELECT active_space_id, previous_space_id FROM lumibase_vector_site_models WHERE site_id = ${siteId} FOR UPDATE`;
      if (!binding?.previous_space_id || binding.previous_space_id === binding.active_space_id) return;
      const [space] = await tx<{ table_name: string }[]>`SELECT table_name FROM lumibase_vector_spaces WHERE id = ${binding.previous_space_id}`;
      if (space) await tx.unsafe(`DELETE FROM ${space.table_name} WHERE site_id = $1`, [siteId]);
      await tx`UPDATE lumibase_vector_site_models SET previous_space_id = NULL, updated_at = now() WHERE site_id = ${siteId}`;
    });
  }

  /** Insert or replace entries in a space; each vector must have the space's dimension. */
  async upsert(space: VectorSpace, entries: VectorEntryInput[]): Promise<void> {
    if (entries.length === 0) return;
    await this.requireExtension();
    const sites = [...new Set(entries.map((e) => e.siteId))];
    const generations = await this.generations(sites);
    for (const e of entries) {
      if (e.embedding.length !== space.dimension) {
        throw new VectorDimensionError(`${space.model} vectors have ${space.dimension} dimensions, got ${e.embedding.length}`);
      }
      await this.sql.unsafe(
        `INSERT INTO ${space.tableName}
           (site_id, source_type, source_id, chunk, purpose, revision, model, dimension, permission_generation, content, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12::${space.columnType})
         ON CONFLICT (site_id, source_type, source_id, chunk, purpose) DO UPDATE SET
           revision = EXCLUDED.revision, permission_generation = EXCLUDED.permission_generation,
           content = EXCLUDED.content, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding, updated_at = now()`,
        [
          e.siteId, e.sourceType, e.sourceId, e.chunk ?? 0, e.purpose, e.revision, space.model, space.dimension,
          generations.get(e.siteId) ?? 0, e.content, JSON.stringify(e.metadata ?? {}), literal(e.embedding),
        ],
      );
    }
  }

  /** Remove a source's entries from every space the site uses. */
  async deleteSource(siteId: string, sourceType: string, sourceId: string): Promise<void> {
    const { active, previous, building } = await this.siteModel(siteId);
    for (const s of [active, previous, building]) {
      if (!s) continue;
      await this.sql.unsafe(`DELETE FROM ${s.tableName} WHERE site_id = $1 AND source_type = $2 AND source_id = $3`, [siteId, sourceType, sourceId]);
    }
  }

  private async generations(siteIds: string[]): Promise<Map<string, number>> {
    if (siteIds.length === 0) return new Map();
    const rows = await this.sql<{ site_id: string; generation: string }[]>`
      SELECT site_id, generation::text AS generation FROM lumibase_access_generations WHERE site_id = ANY(${siteIds}::text[])`;
    return new Map(rows.map((r) => [r.site_id, Number(r.generation)]));
  }

  async query(q: VectorQuery): Promise<VectorQueryResult> {
    const limit = Math.min(Math.max(q.limit ?? 10, 1), 200);
    const skipped: VectorQueryResult['skipped'] = [];
    const sites = [...new Set(q.siteIds)];
    if (sites.length === 0) return { hits: [], skipped };
    await this.requireExtension();

    // 1. Sites whose active space is exactly this model and dimension.
    const bindings = await this.sql<{ site_id: string; space_id: string | null }[]>`
      SELECT s.id AS site_id, m.active_space_id AS space_id
        FROM unnest(${sites}::text[]) AS s(id)
        LEFT JOIN lumibase_vector_site_models m ON m.site_id = s.id`;
    let space: VectorSpace | null = null;
    const searchable: string[] = [];
    for (const b of bindings) {
      const s = b.space_id ? await this.space(b.space_id) : null;
      if (!s) skipped.push({ siteId: b.site_id, reason: 'no active embedding model' });
      else if (s.model !== q.model || s.dimension !== q.vector.length) {
        skipped.push({ siteId: b.site_id, reason: `active model is ${s.model} (${s.dimension} dimensions)` });
      } else {
        space = s;
        searchable.push(b.site_id);
      }
    }
    if (!space || searchable.length === 0) return { hits: [], skipped };
    searchable.sort();

    // 2–4. Fetch, verify every candidate, refill with the same filters.
    const generations = await this.generations(searchable);
    const page = limit * 2;
    const rounds = Math.max(1, q.maxRounds ?? 4);
    const accepted: VectorCandidate[] = [];
    const seen = new Set<string>();
    for (let round = 0; round < rounds && accepted.length < limit; round++) {
      const key = `vector:${space.id}:${q.purpose}:${searchable.join(',')}:${createHash('sha256').update(literal(q.vector)).digest('hex')}:${page}:${round}`;
      let batch = q.cache ? await q.cache.get(key) : null;
      if (!batch) {
        batch = await this.fetchCandidates(space, searchable, q.purpose, q.vector, page, round * page);
        if (q.cache) await q.cache.set(key, batch);
      }
      // A cached candidate carries its generation from when it was cached; refresh it.
      const fresh = batch
        .filter((c) => searchable.includes(c.siteId) && c.purpose === q.purpose && c.model === q.model && c.dimension === q.vector.length)
        .map((c) => ({ ...c, currentPermissionGeneration: generations.get(c.siteId) ?? 0 }))
        .filter((c) => !seen.has(`${c.siteId}|${c.sourceType}|${c.sourceId}|${c.chunk}`));
      for (const c of fresh) seen.add(`${c.siteId}|${c.sourceType}|${c.sourceId}|${c.chunk}`);
      const ok = fresh.length ? await q.verify(fresh) : [];
      const allowed = new Set(fresh.map((c) => c));
      for (const c of ok) if (allowed.has(c) && accepted.length < limit) accepted.push(c);
      if (batch.length < page) break;
    }
    return { hits: accepted, skipped };
  }

  private async fetchCandidates(
    space: VectorSpace,
    siteIds: string[],
    purpose: VectorPurpose,
    vector: number[],
    limit: number,
    offset: number,
  ): Promise<VectorCandidate[]> {
    const rows = await this.sql.begin(async (tx) => {
      // Keep scanning the HNSW graph until enough rows pass the site/purpose filter.
      await tx`SET LOCAL hnsw.iterative_scan = strict_order`;
      return tx.unsafe<
        Array<{
          site_id: string; source_type: string; source_id: string; chunk: number; revision: string; purpose: VectorPurpose;
          model: string; dimension: number; content: string; metadata: Record<string, unknown>; distance: number; permission_generation: string;
        }>
      >(
        `SELECT site_id, source_type, source_id, chunk, revision, purpose, model, dimension, content, metadata,
                permission_generation::text AS permission_generation, embedding <=> $1::${space.columnType} AS distance
           FROM ${space.tableName}
          WHERE site_id = ANY($2::text[]) AND purpose = $3
          ORDER BY embedding <=> $1::${space.columnType}
          LIMIT $4 OFFSET $5`,
        [literal(vector), siteIds, purpose, limit, offset],
      );
    });
    return rows.map((r) => ({
      siteId: r.site_id,
      sourceType: r.source_type,
      sourceId: r.source_id,
      chunk: r.chunk,
      revision: r.revision,
      purpose: r.purpose,
      model: r.model,
      dimension: r.dimension,
      content: r.content,
      metadata: r.metadata ?? {},
      distance: Number(r.distance),
      permissionGeneration: Number(r.permission_generation),
      currentPermissionGeneration: 0,
    }));
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
