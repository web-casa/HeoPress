import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { convertJsonbEmbeddings } from '../vector/convert';
import { PgVectorStore, VectorDimensionError, type VectorCandidate, type VectorPurpose } from '../vector/store';
import { PG_URL, connectRuntimeDb, connectRuntimeOwner } from './helpers/pg';

/**
 * Vector retrieval (P03 tasks 5.3–5.5; spec "站点隔离的向量检索",
 * "检索命中后复核"). Needs pgvector: runs on the HeoPress database image
 * (CI job db-image), skips on a stock PostgreSQL.
 */

const SITE_A = 'vec_site_a';
const SITE_B = 'vec_site_b';

/** What the verifier checks against: the "current records". */
interface Doc {
  revision: string;
  published: boolean;
  purposes: VectorPurpose[];
}

const unit = (dim: number, i: number, tilt = 0): number[] =>
  Array.from({ length: dim }, (_, k) => (k === i ? 1 : k === (i + 1) % dim ? tilt : 0));

let sql: postgres.Sql;
/** The owner: fixtures and cross-site checks (the store's own connection, the application role, sees one site per scope). */
let owner: postgres.Sql;
let store: PgVectorStore;
let hasVector = false;

beforeAll(async () => {
  if (!PG_URL) return;
  sql = await connectRuntimeDb(6);
  owner = await connectRuntimeOwner();
  store = new PgVectorStore(sql);
  hasVector = await store.available();
  if (!hasVector && process.env.HEOPRESS_TEST_REQUIRE_VECTOR) throw new Error('HEOPRESS_TEST_REQUIRE_VECTOR is set but the vector extension is missing');
});

afterAll(async () => {
  if (!sql) return;
  await cleanup();
  await sql.end({ timeout: 1 });
  await owner?.end({ timeout: 1 });
});

async function cleanup() {
  if (!owner) return;
  const tables = await owner<{ table_name: string }[]>`SELECT table_name FROM lumibase_vector_spaces`;
  await owner`DELETE FROM lumibase_vector_site_models WHERE site_id IN (${SITE_A}, ${SITE_B})`;
  for (const t of tables) await owner.unsafe(`DROP TABLE IF EXISTS ${t.table_name}`);
  await owner`DELETE FROM lumibase_vector_spaces`;
  await owner`DELETE FROM lumibase_ai_embeddings WHERE site_id IN (${SITE_A}, ${SITE_B})`;
  await owner`DELETE FROM lumibase_sites WHERE id IN (${SITE_A}, ${SITE_B})`;
}

describe.skipIf(!PG_URL)('vector store (PostgreSQL + pgvector)', () => {
  const docs = new Map<string, Doc>();
  const verifier =
    (purpose: VectorPurpose) =>
    async (candidates: VectorCandidate[]): Promise<VectorCandidate[]> =>
      candidates.filter((c) => {
        const d = docs.get(`${c.siteId}/${c.sourceId}`);
        if (!d || d.revision !== c.revision) return false;
        if (!d.purposes.includes(purpose)) return false;
        return purpose === 'internal_writing' || d.published;
      });

  beforeEach(async (ctx) => {
    if (!hasVector) return ctx.skip();
    await cleanup();
    await owner`INSERT INTO lumibase_sites (id, name) VALUES (${SITE_A}, 'Vector A'), (${SITE_B}, 'Vector B')`;
    docs.clear();
  });

  async function seed(site: string, model: string, dim: number, n: number, purpose: VectorPurpose = 'public_answer') {
    const space = await store.beginModelSwitch(site, model, dim);
    await store.upsert(
      space,
      Array.from({ length: n }, (_, i) => {
        docs.set(`${site}/doc${i}`, { revision: 'r1', published: true, purposes: ['public_answer', 'internal_writing'] });
        return { siteId: site, sourceType: 'item', sourceId: `doc${i}`, revision: 'r1', purpose, content: `${site} doc ${i}`, embedding: unit(dim, i % dim, 0.1) };
      }),
    );
    await store.activateModel(site);
    return space;
  }

  it('different models and dimensions coexist per site, without dimension errors or leaks', async () => {
    await seed(SITE_A, 'model-small', 3, 3);
    await seed(SITE_B, 'model-large', 5, 5);
    const a = await store.query({ siteIds: [SITE_A, SITE_B], purpose: 'public_answer', model: 'model-small', vector: unit(3, 0), verify: verifier('public_answer') });
    expect(a.hits.every((h) => h.siteId === SITE_A && h.dimension === 3)).toBe(true);
    expect(a.hits[0]!.sourceId).toBe('doc0');
    expect(a.skipped).toEqual([{ siteId: SITE_B, reason: 'active model is model-large (5 dimensions)' }]);
    const b = await store.query({ siteIds: [SITE_A, SITE_B], purpose: 'public_answer', model: 'model-large', vector: unit(5, 4), verify: verifier('public_answer') });
    expect(b.hits.every((h) => h.siteId === SITE_B && h.model === 'model-large')).toBe(true);
    expect(b.hits[0]!.sourceId).toBe('doc4');
    // Each space has its own table and HNSW index.
    const idx = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_indexes WHERE indexdef ILIKE '%USING hnsw%' AND tablename LIKE 'lumibase_vectors_%'`;
    expect(idx[0]!.n).toBe(2);
  });

  it('refuses a vector of the wrong dimension for a space', async () => {
    const space = await store.ensureSpace('model-small', 3);
    await expect(
      store.upsert(space, [{ siteId: SITE_A, sourceType: 'item', sourceId: 'x', revision: 'r1', purpose: 'public_answer', content: 'x', embedding: [1, 0] }]),
    ).rejects.toBeInstanceOf(VectorDimensionError);
  });

  it('HeoPress P14 (ADR-0024): a new model gets its space from the owner\'s entry — the table is not the role\'s, and has row-level security', async () => {
    // A quote in the name reaches the table's CHECK as a literal, nothing more.
    const space = await store.ensureSpace("o'brien/embed:v1", 3);
    const [t] = await owner<{ owner: string; rls: boolean; force: boolean; policies: string[] }[]>`
      SELECT pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
             ARRAY(SELECT policyname::text FROM pg_policies p WHERE p.tablename = c.relname ORDER BY 1) AS policies
        FROM pg_class c WHERE c.oid = to_regclass(${`public.${space.tableName}`})`;
    const [me] = await sql<{ u: string }[]>`SELECT current_user AS u`;
    expect(t).toMatchObject({ rls: true, force: false, policies: ['site_isolation'] });
    expect(t!.owner).not.toBe(me!.u);
    // Usable as before: written and found in one site's scope; the other site sees none of it.
    await store.beginModelSwitch(SITE_A, "o'brien/embed:v1", 3);
    await store.upsert(space, [{ siteId: SITE_A, sourceType: 'item', sourceId: 'q', revision: 'r1', purpose: 'public_answer', content: 'q', embedding: unit(3, 0) }]);
    await store.activateModel(SITE_A);
    const hits = await store.query({ siteIds: [SITE_A], purpose: 'public_answer', model: "o'brien/embed:v1", vector: unit(3, 0), verify: async (c) => c });
    expect(hits.hits.map((h) => h.sourceId)).toEqual(['q']);
    const seenByB = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.site_id', ${SITE_B}, true)`;
      return tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${space.tableName}`);
    });
    expect(seenByB[0]!.n).toBe(0);
    // Asking again changes nothing.
    expect(await store.ensureSpace("o'brien/embed:v1", 3)).toEqual(space);
    // The role itself creates no table.
    await expect(sql.unsafe(`CREATE TABLE public.lumibase_vectors_by_hand (id int)`)).rejects.toMatchObject({ code: '42501' });
  });

  it('HeoPress P14 (ADR-0024): the entry refuses an invalid model name or dimension and creates nothing', async () => {
    const objects = async () =>
      (await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE 'lumibase\\_vectors\\_%'`)[0]!.n;
    const before = await objects();
    const invalid: Array<[string | null, number | null]> = [
      ['', 3], ['two words', 3], ["x'); DROP TABLE lumibase_sites; --", 3], ['tab\tmodel', 3], ['m'.repeat(201), 3], ['模型', 3], [null, 3],
      ['model-ok', 0], ['model-ok', -1], ['model-ok', 4001], ['model-ok', null],
    ];
    for (const [model, dimension] of invalid) {
      await expect(sql`SELECT public.heopress_ensure_vector_space(${model}, ${dimension}::int)`, `${model} ${dimension}`).rejects.toMatchObject({ code: '22023' });
    }
    expect(await objects()).toBe(before);
    expect(await owner`SELECT id FROM lumibase_vector_spaces`).toEqual([]);
    // The store refuses them before asking.
    await expect(store.ensureSpace('two words', 3)).rejects.toBeInstanceOf(VectorDimensionError);
    await expect(store.ensureSpace('model-ok', 4001)).rejects.toBeInstanceOf(VectorDimensionError);
  });

  it('a model switch is built alongside, activated, and can be rolled back', async () => {
    await seed(SITE_A, 'model-old', 3, 3);
    const next = await store.beginModelSwitch(SITE_A, 'model-new', 4);
    // While building, queries still use the old model.
    expect((await store.query({ siteIds: [SITE_A], purpose: 'public_answer', model: 'model-old', vector: unit(3, 1), verify: verifier('public_answer') })).hits[0]!.sourceId).toBe('doc1');
    await store.upsert(next, [0, 1, 2].map((i) => ({ siteId: SITE_A, sourceType: 'item', sourceId: `doc${i}`, revision: 'r1', purpose: 'public_answer' as const, content: `new ${i}`, embedding: unit(4, 3 - i) })));
    await store.activateModel(SITE_A);
    const after = await store.query({ siteIds: [SITE_A], purpose: 'public_answer', model: 'model-new', vector: unit(4, 3), verify: verifier('public_answer') });
    expect(after.hits[0]).toMatchObject({ sourceId: 'doc0', model: 'model-new', dimension: 4 });
    expect((await store.query({ siteIds: [SITE_A], purpose: 'public_answer', model: 'model-old', vector: unit(3, 1), verify: verifier('public_answer') })).hits).toEqual([]);

    await store.rollbackModel(SITE_A);
    const back = await store.query({ siteIds: [SITE_A], purpose: 'public_answer', model: 'model-old', vector: unit(3, 1), verify: verifier('public_answer') });
    expect(back.hits[0]).toMatchObject({ sourceId: 'doc1', model: 'model-old' });
  });

  it('dropping the previous model never empties the active one, even racing a rollback (Codex review 4, #8)', async () => {
    await seed(SITE_A, 'model-old', 3, 3);
    const next = await store.beginModelSwitch(SITE_A, 'model-new', 4);
    await store.upsert(next, [{ siteId: SITE_A, sourceType: 'item', sourceId: 'doc0', revision: 'r1', purpose: 'public_answer', content: 'new', embedding: unit(4, 0) }]);
    await store.activateModel(SITE_A);
    // If the drop wins, the rollback has nothing to go back to and says so.
    await Promise.allSettled([store.rollbackModel(SITE_A), store.dropPreviousModel(SITE_A)]);
    const { active, previous } = await store.siteModel(SITE_A);
    const count = async (t: string) => (await owner.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t} WHERE site_id = $1`, [SITE_A]))[0]!.n;
    // Whichever ran first, the active space still has its entries.
    expect(await count(active!.tableName)).toBeGreaterThan(0);
    if (previous) expect(await count(previous.tableName)).toBeGreaterThan(0);
  });

  it('drops stale results: unpublished content, changed revision, revoked purpose, downgraded user', async () => {
    await seed(SITE_A, 'model-small', 3, 3);
    await seed(SITE_B, 'model-small', 3, 3);
    const run = (siteIds: string[], purpose: VectorPurpose = 'public_answer') =>
      store.query({ siteIds, purpose, model: 'model-small', vector: unit(3, 0), limit: 10, verify: verifier(purpose) });

    docs.get(`${SITE_A}/doc0`)!.published = false; // unpublished, vector still there
    docs.get(`${SITE_A}/doc1`)!.revision = 'r2'; // edited since indexing
    docs.get(`${SITE_A}/doc2`)!.purposes = ['internal_writing']; // no longer for public answers
    const hits = (await run([SITE_A])).hits.map((h) => h.sourceId);
    expect(hits).toEqual([]);

    // The user lost read access to site B: the caller passes only current sites.
    expect((await run([SITE_A])).hits.some((h) => h.siteId === SITE_B)).toBe(false);
    // Internal writing is judged separately: doc2 is fine there, the unpublished doc0 too.
    await store.upsert((await store.siteModel(SITE_A)).active!, [0, 2].map((i) => ({ siteId: SITE_A, sourceType: 'item', sourceId: `doc${i}`, revision: 'r1', purpose: 'internal_writing' as const, content: `${i}`, embedding: unit(3, i) })));
    expect((await run([SITE_A], 'internal_writing')).hits.map((h) => h.sourceId).sort()).toEqual(['doc0', 'doc2']);
  });

  it('verifies cached candidates too, and refills without relaxing the filters', async () => {
    await seed(SITE_A, 'model-small', 3, 3);
    await seed(SITE_B, 'model-small', 3, 3);
    const store2 = new Map<string, VectorCandidate[]>();
    const cache = { get: async (k: string) => store2.get(k) ?? null, set: async (k: string, v: VectorCandidate[]) => void store2.set(k, v) };
    const q = { siteIds: [SITE_A], purpose: 'public_answer' as const, model: 'model-small', vector: unit(3, 0), limit: 1, cache };
    expect((await store.query({ ...q, verify: verifier('public_answer') })).hits[0]!.sourceId).toBe('doc0');
    expect(store2.size).toBeGreaterThan(0);

    docs.get(`${SITE_A}/doc0`)!.published = false;
    // Same query, served from the cache: doc0 is dropped, the next candidate is used.
    const seen: string[] = [];
    const res = await store.query({
      ...q,
      verify: async (c) => {
        seen.push(...c.map((x) => `${x.siteId}/${x.purpose}`));
        return verifier('public_answer')(c);
      },
    });
    expect(res.hits.map((h) => h.sourceId)).not.toContain('doc0');
    expect(res.hits).toHaveLength(1);
    // Refill candidates kept the site and purpose filters.
    expect(new Set(seen)).toEqual(new Set([`${SITE_A}/public_answer`]));

    // A poisoned cache entry naming another site or purpose is ignored, not trusted.
    for (const [k, v] of store2) store2.set(k, v.map((c) => ({ ...c, siteId: SITE_B })));
    expect((await store.query({ ...q, verify: async (c) => c })).hits.every((h) => h.siteId === SITE_A)).toBe(true);
  });

  it('refills from the next page when a whole page is rejected, with the same filters (Codex review 4, #11)', async () => {
    await seed(SITE_A, 'model-small', 3, 3);
    await seed(SITE_B, 'model-small', 3, 3);
    // Nearest first for unit(3, 0): doc0, doc2, doc1. Page size is 2 for limit 1.
    docs.get(`${SITE_A}/doc0`)!.published = false;
    docs.get(`${SITE_A}/doc2`)!.published = false;
    const batches: string[][] = [];
    const res = await store.query({
      siteIds: [SITE_A], purpose: 'public_answer', model: 'model-small', vector: unit(3, 0), limit: 1,
      verify: async (c) => {
        batches.push(c.map((x) => `${x.siteId}/${x.sourceId}/${x.purpose}/${x.model}`));
        return verifier('public_answer')(c);
      },
    });
    expect(res.hits.map((h) => h.sourceId)).toEqual(['doc1']);
    expect(batches).toEqual([
      [`${SITE_A}/doc0/public_answer/model-small`, `${SITE_A}/doc2/public_answer/model-small`],
      [`${SITE_A}/doc1/public_answer/model-small`],
    ]);
  });

  it('records the permission generation, and a membership change bumps it', async () => {
    await seed(SITE_A, 'model-small', 3, 1);
    const before = (await store.query({ siteIds: [SITE_A], purpose: 'public_answer', model: 'model-small', vector: unit(3, 0), verify: async (c) => c })).hits[0]!;
    expect(before.permissionGeneration).toBe(before.currentPermissionGeneration);
    await owner`INSERT INTO lumibase_roles (id, site_id, name) VALUES ('vec_role', ${SITE_A}, 'Vec role')`;
    const after = (await store.query({ siteIds: [SITE_A], purpose: 'public_answer', model: 'model-small', vector: unit(3, 0), verify: async (c) => c })).hits[0]!;
    expect(after.currentPermissionGeneration).toBeGreaterThan(after.permissionGeneration);
  });

  it('converts JSONB embeddings into per-model spaces, and running it twice changes nothing', async () => {
    await owner`
      INSERT INTO lumibase_ai_embeddings (id, site_id, collection, item_id, chunk_text, embedding, model) VALUES
        ('emb1', ${SITE_A}, 'posts', 'p1', 'one', '[1,0,0]'::jsonb, 'legacy-3'),
        ('emb2', ${SITE_A}, 'posts', 'p2', 'two', '[0,1,0]'::jsonb, 'legacy-3'),
        ('emb3', ${SITE_B}, 'posts', 'p3', 'three', '[0,0,0,1]'::jsonb, 'legacy-4'),
        ('emb4', ${SITE_B}, 'posts', 'p4', 'bad', '"not a vector"'::jsonb, 'legacy-4')`;
    const snapshot = async () => {
      const spaces = await owner<{ table_name: string }[]>`SELECT table_name FROM lumibase_vector_spaces ORDER BY id`;
      const out: unknown[] = [];
      for (const s of spaces) {
        out.push(await owner.unsafe(`SELECT site_id, source_id, model, dimension, content, embedding::text FROM ${s.table_name} ORDER BY site_id, source_id`));
      }
      out.push(await owner`SELECT site_id, active_space_id FROM lumibase_vector_site_models WHERE site_id IN (${SITE_A}, ${SITE_B}) ORDER BY site_id`);
      return JSON.stringify(out);
    };
    const first = await convertJsonbEmbeddings(sql, store);
    expect(first).toMatchObject({ converted: 3, skipped: 1 });
    expect(first.spaces.map((s) => [s.model, s.dimension, s.rows]).sort()).toEqual([['legacy-3', 3, 2], ['legacy-4', 4, 1]]);
    const once = await snapshot();
    const second = await convertJsonbEmbeddings(sql, store);
    expect(second).toMatchObject({ converted: 3, skipped: 1 });
    expect(await snapshot()).toBe(once);
    // Converted vectors are searchable in their own space.
    const hit = await store.query({ siteIds: [SITE_A], purpose: 'internal_writing', model: 'legacy-3', vector: [0, 1, 0], verify: async (c) => c });
    expect(hit.hits[0]).toMatchObject({ sourceId: 'emb2', content: 'two' });
  });
});
