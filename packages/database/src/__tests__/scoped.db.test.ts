import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgTable, text } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { schema, type Database } from '../client';
import { databaseScope, scopedDatabase } from '../scoped';
import { rlsPolicyStatements } from '../rls/policies';

/**
 * Site-scoped database handles (HeoPress P14 task 1.2, ADR-0023, design D1.4) on the pinned drizzle-orm and postgres
 * versions: the paths the Drizzle postgres-js driver takes (select with fields → `.values()`, insert, `returning`,
 * `execute`, transactions with an isolation level, nested savepoints) all run in the scope, and a connection goes back
 * to the pool without one.
 *
 * The owner (DATABASE_OWNER_URL) creates a probe table with a site policy; the handles connect as the application
 * role (DATABASE_URL), which the policy binds.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim() || undefined;
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const TABLE = `heopress_scoped_probe_${process.pid}`;
/** A table under the `site-or-instance` policy (the audit log's): site rows and instance rows (no site). */
const INSTANCE_TABLE = `heopress_scoped_inst_${process.pid}`;

const probe = pgTable(TABLE, {
  id: text('id').primaryKey(),
  siteId: text('site_id').notNull(),
  body: text('body'),
});
const instanceProbe = pgTable(INSTANCE_TABLE, {
  id: text('id').primaryKey(),
  siteId: text('site_id'),
  body: text('body'),
});

/** The database error behind a Drizzle query error (`DrizzleQueryError` keeps it as `cause`). */
async function failure(promise: PromiseLike<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause ?? err;
    return cause as { code?: string; message: string };
  }
  throw new Error('expected the statement to fail');
}

describe.skipIf(!DATABASE_URL)('scopedDatabase (P14 task 1.2)', () => {
  let owner: postgres.Sql;
  let pool: postgres.Sql;
  let root: Database;

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required with DATABASE_URL (see rls.db.test.ts)').toBeDefined();
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    await owner.unsafe(`CREATE TABLE ${TABLE} (id text PRIMARY KEY, site_id text NOT NULL, body text)`);
    await owner.unsafe(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
    await owner.unsafe(`CREATE POLICY site_isolation ON ${TABLE} USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id())`);
    await owner.unsafe(`INSERT INTO ${TABLE} (id, site_id, body) VALUES ('a1', 'site-a', 'A'), ('b1', 'site-b', 'B')`);
    const role = new URL(DATABASE_URL!).username;
    await owner.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO "${role}"`);
    await owner.unsafe(`CREATE TABLE ${INSTANCE_TABLE} (id text PRIMARY KEY, site_id text, body text)`);
    await owner.unsafe(rlsPolicyStatements([{ table: INSTANCE_TABLE, policy: 'site-or-instance' }]).join('\n'));
    await owner.unsafe(`INSERT INTO ${INSTANCE_TABLE} (id, site_id, body) VALUES ('a1', 'site-a', 'A'), ('i1', NULL, 'instance')`);
    await owner.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${INSTANCE_TABLE} TO "${role}"`);
    // One connection: whatever a scoped statement left on it, the next statement sees.
    pool = postgres(DATABASE_URL!, { max: 1, onnotice: () => {}, prepare: false });
    root = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.end({ timeout: 2 });
    await owner?.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await owner?.unsafe(`DROP TABLE IF EXISTS ${INSTANCE_TABLE}`);
    await owner?.end({ timeout: 2 });
  });

  const noScope = async () => {
    await expect(pool`SELECT app_site_id()`).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/^heopress: no site scope/) });
  };

  it('without a scope, app_site_id() raises 42501 and the policy refuses the read', async () => {
    await noScope();
    expect((await failure(root.select().from(probe))).message).toMatch(/no site scope/);
  });

  it('select (with fields, through .values()) and execute see only the site; the connection comes back unscoped', async () => {
    const a = scopedDatabase(root, { site: 'site-a' });
    expect(await a.select().from(probe)).toEqual([{ id: 'a1', siteId: 'site-a', body: 'A' }]);
    expect(await a.select({ id: probe.id }).from(probe).where(eq(probe.id, 'b1'))).toEqual([]);
    const rows = (await a.execute(sql`SELECT app_site_id() AS s, count(*)::int AS n FROM ${probe}`)) as unknown as Array<{ s: string; n: number }>;
    expect([...rows]).toEqual([{ s: 'site-a', n: 1 }]);
    await noScope();
  });

  it('insert, returning, update and delete stay in the site; another site is refused', async () => {
    const a = scopedDatabase(root, { site: 'site-a' });
    const inserted = await a.insert(probe).values({ id: 'a2', siteId: 'site-a', body: 'new' }).returning();
    expect(inserted).toEqual([{ id: 'a2', siteId: 'site-a', body: 'new' }]);
    expect((await failure(a.insert(probe).values({ id: 'x', siteId: 'site-b' }))).message).toMatch(/row-level security/);
    const updated = await a.update(probe).set({ body: 'changed' }).returning({ id: probe.id });
    expect(updated.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
    await a.delete(probe).where(eq(probe.id, 'a2'));
    await a.update(probe).set({ body: 'A' }).where(eq(probe.id, 'a1'));
    expect(await scopedDatabase(root, { site: 'site-b' }).select({ body: probe.body }).from(probe)).toEqual([{ body: 'B' }]);
    await noScope();
  });

  it('a transaction runs in the scope — with an isolation level, through nested savepoints — and leaves no scope', async () => {
    const b = scopedDatabase(root, { site: 'site-b' });
    const seen = await b.transaction(
      async (tx) => {
        const level = (await tx.execute(sql`SHOW transaction_isolation`)) as unknown as Array<{ transaction_isolation: string }>;
        const outer = await tx.select({ id: probe.id }).from(probe);
        const inner = await tx.transaction(async (sp) => {
          await sp.insert(probe).values({ id: 'b2', siteId: 'site-b' });
          const deeper = await sp.transaction(async (sp2) => sp2.select({ id: probe.id }).from(probe).orderBy(probe.id));
          sp.rollback();
          return deeper;
        }).catch((err: unknown) => err);
        const after = await tx.select({ id: probe.id }).from(probe);
        return { level: level[0]?.transaction_isolation, outer, inner, after };
      },
      { isolationLevel: 'serializable' },
    );
    expect(seen.level).toBe('serializable');
    expect(seen.outer).toEqual([{ id: 'b1' }]);
    // The rolled-back savepoint saw its own insert; after it, the row is gone.
    expect(seen.inner).toBeInstanceOf(Error);
    expect(seen.after).toEqual([{ id: 'b1' }]);
    await noScope();
  });

  it('a savepoint as the first statement still runs in the scope', async () => {
    const a = scopedDatabase(root, { site: 'site-a' });
    const ids = await a.transaction(async (tx) => tx.transaction(async (sp) => sp.select({ id: probe.id }).from(probe)));
    expect(ids).toEqual([{ id: 'a1' }]);
    await noScope();
  });

  it('a statement that fails leaves no scope behind either', async () => {
    const a = scopedDatabase(root, { site: 'site-a' });
    expect((await failure(a.execute(sql`SELECT 1/0`))).message).toMatch(/division by zero/);
    expect((await failure(a.transaction(async (tx) => tx.execute(sql`SELECT 1/0`)))).message).toMatch(/division by zero/);
    await noScope();
  });

  it('the platform scope sees no site rows and app_site_id() is NULL in it', async () => {
    const platform = scopedDatabase(root, { platform: true });
    expect(await platform.select().from(probe)).toEqual([]);
    const rows = (await platform.execute(sql`SELECT app_site_id() AS s, app_platform_scope() AS p`)) as unknown as Array<{ s: string | null; p: boolean }>;
    expect([...rows]).toEqual([{ s: null, p: true }]);
    expect((await failure(platform.insert(probe).values({ id: 'p', siteId: 'site-a' }))).message).toMatch(/row-level security/);
    await noScope();
  });

  it('site-or-instance (the audit log): instance rows are inserted from any scope, read and changed only in the platform scope', async () => {
    const ids = async (db: Database) => (await db.select({ id: instanceProbe.id }).from(instanceProbe).orderBy(instanceProbe.id)).map((r) => r.id);
    // No scope: an instance entry is still written; a site's is not.
    await pool.unsafe(`INSERT INTO ${INSTANCE_TABLE} (id, site_id, body) VALUES ('i2', NULL, 'no scope')`);
    await expect(pool.unsafe(`INSERT INTO ${INSTANCE_TABLE} (id, site_id, body) VALUES ('a9', 'site-a', 'x')`)).rejects.toMatchObject({ code: '42501' });
    const siteA = scopedDatabase(root, { site: 'site-a' });
    await siteA.insert(instanceProbe).values({ id: 'i3', siteId: null, body: 'from a site' });
    // A site sees its own rows only — no instance row, no other site's.
    expect(await ids(siteA)).toEqual(['a1']);
    expect(await siteA.update(instanceProbe).set({ body: 'changed' }).where(sql`site_id IS NULL`).returning()).toEqual([]);
    expect((await failure(siteA.insert(instanceProbe).values({ id: 'b9', siteId: 'site-b' }))).message).toMatch(/row-level security/);
    // The platform scope: the instance rows, no site's.
    const platform = scopedDatabase(root, { platform: true });
    expect(await ids(platform)).toEqual(['i1', 'i2', 'i3']);
    expect(await platform.update(instanceProbe).set({ body: 'changed' }).where(sql`id = 'i1'`).returning({ id: instanceProbe.id })).toEqual([{ id: 'i1' }]);
    expect((await failure(platform.insert(instanceProbe).values({ id: 'a8', siteId: 'site-a' }))).message).toMatch(/row-level security/);
    await noScope();
  });

  it('handles are reused per scope, re-scoping a scoped handle uses the same pool, and the scope is readable', async () => {
    const a = scopedDatabase(root, { site: 'site-a' });
    expect(scopedDatabase(root, { site: 'site-a' })).toBe(a);
    expect(databaseScope(a)).toEqual({ site: 'site-a' });
    expect(databaseScope(root)).toBeNull();
    const b = scopedDatabase(a, { site: 'site-b' });
    expect(b).toBe(scopedDatabase(root, { site: 'site-b' }));
    expect(databaseScope(scopedDatabase(b, { platform: true }))).toEqual({ platform: true });
    expect(() => scopedDatabase(root, { site: '' })).toThrow(/site id/);
  });

  it('concurrent statements of different sites on a small pool never see each other’s scope', async () => {
    const small = postgres(DATABASE_URL!, { max: 2, onnotice: () => {}, prepare: false });
    try {
      const base = drizzle(small, { schema }) as unknown as Database;
      const runs = Array.from({ length: 40 }, (_, i) => {
        const site = i % 2 === 0 ? 'site-a' : 'site-b';
        return scopedDatabase(base, { site })
          .select({ siteId: probe.siteId })
          .from(probe)
          .then((rows) => rows.every((r) => r.siteId === site) && rows.length === 1);
      });
      expect((await Promise.all(runs)).every(Boolean)).toBe(true);
    } finally {
      await small.end({ timeout: 2 });
    }
  });
});
