import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * P02 migration baseline (task 7.1; spec platform/feature-surface "全新安装使用
 * 单一初始迁移"): a fresh install applies one generated migration, and it does
 * not create the tables of removed features.
 *
 * The structural equivalence with the old chain was checked once with
 * `scripts/compare-schemas.ts` (hash recorded in UPSTREAM.md); this test keeps
 * the properties that must hold for every later migration.
 */

const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle');
const REMOVED_TABLES = [
  'lumibase_cdc_pipelines',
  'lumibase_cdc_deployments',
  'lumibase_cdc_pipeline_health',
  'lumibase_firebase_sync_pipelines',
  'lumibase_firebase_sync_log',
  'lumibase_push_subscriptions',
  'lumibase_scim_tokens',
];

const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>;
};

describe('migration baseline (files)', () => {
  it('starts the history with the single generated baseline', () => {
    expect(journal.entries[0]).toMatchObject({ idx: 0, tag: '0000_heopress_baseline' });
    expect(fs.existsSync(path.join(DRIZZLE_DIR, 'meta/0000_snapshot.json'))).toBe(true);
  });

  it('creates none of the removed feature tables', () => {
    const sql = fs.readFileSync(path.join(DRIZZLE_DIR, '0000_heopress_baseline.sql'), 'utf8');
    for (const table of REMOVED_TABLES) expect(sql).not.toContain(`"${table}"`);
  });
});

const TEST_DATABASE_URL = process.env.DATABASE_URL?.trim() || undefined;

describe.skipIf(!TEST_DATABASE_URL)('migration baseline (migrated PostgreSQL)', () => {
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    client = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    await client`SELECT 1`;
  });

  afterAll(async () => {
    await client?.end({ timeout: 1 });
  });

  it('records the baseline as the first applied migration', async () => {
    const rows = await client<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    expect(rows[0]!.n).toBe(journal.entries.length);
  });

  it('has no removed feature table and keeps the retained ones', async () => {
    const rows = await client<{ name: string; present: boolean }[]>`
      SELECT t AS name, to_regclass('public.' || t) IS NOT NULL AS present
      FROM unnest(${[...REMOVED_TABLES, 'lumibase_items', 'lumibase_cdc_change_events']}::text[]) AS t`;
    const present = Object.fromEntries(rows.map((r) => [r.name, r.present]));
    for (const table of REMOVED_TABLES) expect(present[table], table).toBe(false);
    expect(present.lumibase_items).toBe(true);
    expect(present.lumibase_cdc_change_events).toBe(true);
  });
});
