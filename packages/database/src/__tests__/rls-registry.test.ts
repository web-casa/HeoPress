import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { RLS_REGISTRY, unregisteredSiteTables } from '../rls/registry';
import * as schema from '../schema/index';

/**
 * Every table with a site is either isolated or a registered exception (HeoPress P14 task 1.1, ADR-0023, spec
 * `platform/tenant-isolation` "新增的站点表漏掉隔离"). No database: the schema is the source.
 */

const SCHEMA_DIR = path.resolve(__dirname, '../schema');

function schemaTables(): Array<{ name: string; hasSite: boolean }> {
  const out: Array<{ name: string; hasSite: boolean }> = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    out.push({ name: config.name, hasSite: config.columns.some((c) => c.name === 'site_id') });
  }
  return out;
}

/** Tables declared in `src/schema/*.ts`, by name, read from the source: an unexported table is still a table. */
function declaredTableNames(): string[] {
  const names: string[] = [];
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
    for (const m of source.matchAll(/pgTable\(\s*['"]([a-z0-9_]+)['"]/g)) names.push(m[1]!);
  }
  return names;
}

describe('RLS registry (P14 task 1.1)', () => {
  const tables = schemaTables();
  const byName = new Map(tables.map((t) => [t.name, t]));

  it('reads the schema: every declared table is exported, and there are tables with a site', () => {
    // A table the barrel does not export would escape the check below; so would a broken import.
    const missing = declaredTableNames().filter((n) => !byName.has(n));
    expect(missing, 'tables declared in src/schema but not exported from src/schema/index.ts').toEqual([]);
    expect(tables.filter((t) => t.hasSite).length).toBeGreaterThan(190);
  });

  it('every table with a site_id column is isolated or a registered exception', () => {
    expect(
      unregisteredSiteTables(tables, RLS_REGISTRY),
      'tables with site_id that are neither under a policy nor a registered exception: add each to packages/database/src/rls/registry.ts (docs/dev/tenant-isolation.md)',
    ).toEqual([]);
  });

  it('the check fails for a new table with a site that is not registered', () => {
    expect(unregisteredSiteTables([...tables, { name: 'lumibase_new_site_table', hasSite: true }], RLS_REGISTRY)).toEqual([
      'lumibase_new_site_table',
    ]);
  });

  it('every registered table exists in the schema, once', () => {
    const names = RLS_REGISTRY.map((e) => e.table);
    expect(names.filter((n, i) => names.indexOf(n) !== i), 'registered twice').toEqual([]);
    expect(names.filter((n) => !byName.has(n)), 'registered but not in the schema').toEqual([]);
  });

  it('site policies are only on tables with a site; exceptions all carry a reason', () => {
    const siteless = RLS_REGISTRY.filter((e) => ['site', 'site-or-global-read', 'translation-group'].includes(e.policy) && !byName.get(e.table)?.hasSite);
    expect(siteless.map((e) => e.table)).toEqual([]);
    for (const e of RLS_REGISTRY) {
      if (e.policy === 'exempt') {
        expect(e.reason?.category, e.table).toMatch(/^(pre-site-lookup|cross-site-schedule|render-cache|instance)$/);
        expect(e.reason?.note.length ?? 0, e.table).toBeGreaterThan(10);
      } else {
        expect(e.reason, e.table).toBeUndefined();
      }
    }
  });

  it('exceptions stay few: an exception is a reason, not a default', () => {
    const exempt = RLS_REGISTRY.filter((e) => e.policy === 'exempt');
    expect(exempt.length).toBeLessThanOrEqual(20);
  });
});
