import postgres from 'postgres';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collections, items, permissions, policies, rolePolicies, roles, sites, users, userSites, type Database } from '@heopress/database';
import { PgVectorStore, type VectorPurpose } from '@heopress/runtime/node';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { currentMemberSites, itemCandidateVerifier, itemRevision } from '../vector-retrieval';

/**
 * Vector hits are re-checked against current items and permissions before use
 * (P03 task 5.5; spec "检索命中后复核": "内容下架后的旧向量", "用户被降权";
 * Codex review 4, #2–#5). Needs pgvector (the HeoPress database image);
 * skips without it, fails if HEOPRESS_TEST_REQUIRE_VECTOR is set.
 */

const SITE = 'vec_cms_site';
const OTHER = 'vec_cms_other';
const USER = 'vec_cms_user';
const MODEL = 'test-embed-3';
const vec = (i: number) => [0, 1, 2].map((k) => (k === i ? 1 : 0.05));

describe.skipIf(!hasDbIntegrationUrl)('vector retrieval verification (DB)', () => {
  let db: Database;
  let sql: postgres.Sql;
  let store: PgVectorStore;
  let hasVector = false;

  async function cleanup() {
    const spaces = await sql<{ table_name: string }[]>`SELECT table_name FROM lumibase_vector_spaces WHERE model = ${MODEL}`;
    await sql`DELETE FROM lumibase_vector_site_models WHERE site_id IN (${SITE}, ${OTHER})`;
    for (const s of spaces) await sql.unsafe(`DROP TABLE IF EXISTS ${s.table_name}`);
    await sql`DELETE FROM lumibase_vector_spaces WHERE model = ${MODEL}`;
    await db.delete(userSites).where(eq(userSites.userId, USER));
    await db.delete(sites).where(inArray(sites.id, [SITE, OTHER]));
    await db.delete(users).where(eq(users.id, USER));
  }

  /** A role with one policy granting `read` on posts with the given rule and fields. */
  async function role(site: string, id: string, read: { rule?: Record<string, unknown>; fields?: string[] } | null, systemKey?: string) {
    await db.insert(roles).values({ id, siteId: site, name: id, systemKey: systemKey ?? null, adminAccess: false, appAccess: !systemKey } as never);
    if (read) {
      await db.insert(policies).values({ id: `${id}_policy`, siteId: site, name: `${id} policy` } as never);
      await db.insert(rolePolicies).values({ roleId: id, policyId: `${id}_policy` } as never);
      await db.insert(permissions).values({
        id: `${id}_read`, siteId: site, policyId: `${id}_policy`, collection: 'posts', action: 'read',
        permissions: read.rule ?? {}, fields: read.fields ?? ['*'],
      } as never);
    }
  }

  beforeAll(async () => {
    db = await connectDbIntegration('vector-retrieval');
    sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {}, prepare: false });
    store = new PgVectorStore(sql);
    hasVector = await store.available();
    if (!hasVector && process.env.HEOPRESS_TEST_REQUIRE_VECTOR) throw new Error('HEOPRESS_TEST_REQUIRE_VECTOR is set but the vector extension is missing');
  });

  afterAll(async () => {
    if (!db) return;
    if (hasVector) await cleanup();
    await sql.end({ timeout: 1 });
  });

  beforeEach(async (ctx) => {
    if (!hasVector) return ctx.skip();
    await cleanup();
    await db.insert(sites).values([{ id: SITE, name: 'Vector CMS' }, { id: OTHER, name: 'Vector other' }]);
    await db.insert(users).values({ id: USER, email: 'vec-cms@example.test', status: 'active' } as never);
    for (const site of [SITE, OTHER]) {
      await role(site, `${site}_editor`, { fields: ['*'] });
      await role(site, `${site}_public`, { fields: ['*'] }, 'public');
    }
    await role(SITE, 'vec_limited', { rule: { user_created: { _eq: '$CURRENT_USER' } }, fields: ['title'] });
    await role(SITE, 'vec_none', null);
    await db.insert(userSites).values([
      { userId: USER, siteId: SITE, roleId: `${SITE}_editor` },
      { userId: USER, siteId: OTHER, roleId: `${OTHER}_editor` },
    ] as never);
    for (const site of [SITE, OTHER]) {
      await db.insert(collections).values({ id: `${site}_posts`, siteId: site, name: 'posts' } as never);
      const rows = await db
        .insert(items)
        .values([0, 1, 2].map((i) => ({
          id: `${site}_item${i}`, siteId: site, collectionId: `${site}_posts`, status: 'published',
          data: { title: `t${i}`, secret: `s${i}` }, userCreated: i === 0 ? USER : null,
        })))
        .returning({ id: items.id, updatedAt: items.updatedAt });
      const space = await store.beginModelSwitch(site, MODEL, 3);
      await store.upsert(
        space,
        rows.flatMap((r, i) =>
          (['public_answer', 'internal_writing'] as const).flatMap((purpose) => [
            { siteId: site, sourceType: 'item', sourceId: r.id, chunk: 0, revision: itemRevision(r.updatedAt), purpose, content: `title ${i}`, embedding: vec(i), metadata: { fields: ['title'] } },
            { siteId: site, sourceType: 'item', sourceId: r.id, chunk: 1, revision: itemRevision(r.updatedAt), purpose, content: `secret ${i}`, embedding: vec(i), metadata: { fields: ['secret'] } },
          ]),
        ),
      );
      await store.activateModel(site);
    }
  });

  const ask = async (purpose: VectorPurpose, siteIds: string[], userId?: string) =>
    (await store.query({ siteIds, purpose, model: MODEL, vector: vec(0), limit: 20, verify: itemCandidateVerifier({ db, purpose, userId }) })).hits.map((h) => `${h.sourceId}#${h.chunk}`);

  it('a visitor answer never uses an unpublished item whose vector is still indexed', async () => {
    expect(await ask('public_answer', [SITE])).toContain(`${SITE}_item0#0`);
    await db.update(items).set({ status: 'draft' }).where(eq(items.id, `${SITE}_item0`));
    const hits = await ask('public_answer', [SITE]);
    expect(hits.some((h) => h.startsWith(`${SITE}_item0#`))).toBe(false);
    expect(hits).toHaveLength(4);
  });

  it('a visitor answer stops using a site once public read is revoked, though items stay published (Codex review 4, #3)', async () => {
    expect(await ask('public_answer', [SITE])).toHaveLength(6);
    await db.delete(permissions).where(eq(permissions.id, `${SITE}_public_read`));
    expect(await ask('public_answer', [SITE])).toEqual([]);
  });

  it('drops a hit whose item changed since it was embedded, or was deleted', async () => {
    await db.update(items).set({ data: { title: 'edited' }, updatedAt: new Date(Date.now() + 1000) }).where(eq(items.id, `${SITE}_item1`));
    await db.update(items).set({ deletedAt: new Date() }).where(eq(items.id, `${SITE}_item2`));
    expect((await ask('public_answer', [SITE])).sort()).toEqual([`${SITE}_item0#0`, `${SITE}_item0#1`]);
  });

  it('internal writing: a downgraded user no longer gets that site\'s material', async () => {
    const sitesNow = await currentMemberSites(db, USER);
    expect(sitesNow.sort()).toEqual([SITE, OTHER].sort());
    expect((await ask('internal_writing', sitesNow, USER)).some((id) => id.startsWith(SITE))).toBe(true);

    await db.update(userSites).set({ roleId: 'vec_none' }).where(and(eq(userSites.userId, USER), eq(userSites.siteId, SITE)));
    const hits = await ask('internal_writing', await currentMemberSites(db, USER), USER);
    expect(hits.some((id) => id.startsWith(SITE))).toBe(false);
    expect(hits.some((id) => id.startsWith(OTHER))).toBe(true);
  });

  it('a membership removed after the site list was computed still blocks that site (Codex review 4, #4)', async () => {
    const stale = await currentMemberSites(db, USER);
    await db.delete(userSites).where(and(eq(userSites.userId, USER), eq(userSites.siteId, OTHER)));
    const hits = await ask('internal_writing', stale, USER);
    expect(hits.some((id) => id.startsWith(OTHER))).toBe(false);
    expect(hits.some((id) => id.startsWith(SITE))).toBe(true);
  });

  it('row rules and field restrictions apply to chunks (Codex review 4, #2)', async () => {
    await db.update(userSites).set({ roleId: 'vec_limited' }).where(and(eq(userSites.userId, USER), eq(userSites.siteId, SITE)));
    // Only the user's own item, and only its title chunk.
    expect(await ask('internal_writing', [SITE], USER)).toEqual([`${SITE}_item0#0`]);
  });

  it('purposes are judged separately: an internal-only draft never reaches a public answer', async () => {
    await db.update(items).set({ status: 'draft' }).where(eq(items.id, `${SITE}_item0`));
    expect(await ask('internal_writing', [SITE], USER)).toContain(`${SITE}_item0#0`);
    expect((await ask('public_answer', [SITE])).some((h) => h.startsWith(`${SITE}_item0#`))).toBe(false);
    // Without a user, internal retrieval returns nothing (fail closed).
    expect(await ask('internal_writing', [SITE])).toEqual([]);
  });
});
