import { describe, expect, it } from 'vitest';

import { ensureDatabaseExtensions, evaluateCapabilities, type ExtensionAdminSql } from '../capabilities';

/**
 * Which extensions the migrate script installs (P03 task 1.2, Codex review
 * finding 5): only those the deployment uses, and an optional one that cannot
 * be installed (no privilege, not offered) never blocks migrating.
 */

function fakeSql(available: string[], failing: string[] = []) {
  const statements: string[] = [];
  const sql = (async () => available.map((name) => ({ name }))) as unknown as ExtensionAdminSql;
  sql.unsafe = async (query: string) => {
    statements.push(query.trim());
    const failed = failing.find((ext) => query.includes(`EXTENSION IF NOT EXISTS ${ext}`));
    if (failed) throw new Error(`permission denied to create extension "${failed}"`);
    return [];
  };
  return { sql, statements };
}

describe('ensureDatabaseExtensions', () => {
  it('does not install vector when vector search is disabled, even if the server offers it', async () => {
    const { sql, statements } = fakeSql(['pg_trgm', 'vector', 'zhparser']);
    const result = await ensureDatabaseExtensions(sql, { vectorSearch: false });
    expect(statements.some((q) => q.includes('EXTENSION IF NOT EXISTS vector'))).toBe(false);
    expect(result).toEqual({ created: ['pg_trgm', 'zhparser'], skipped: ['vector'] });
  });

  it('continues without zhparser when the role may not install it', async () => {
    const { sql } = fakeSql(['pg_trgm', 'zhparser'], ['zhparser']);
    const logs: string[] = [];
    const result = await ensureDatabaseExtensions(sql, { vectorSearch: false }, (m) => logs.push(m));
    expect(result).toEqual({ created: ['pg_trgm'], skipped: ['vector', 'zhparser'] });
    expect(logs.join(' ')).toMatch(/pg_trgm/);
  });

  it('installs vector when vector search is enabled, and fails loudly when it cannot', async () => {
    const ok = fakeSql(['pg_trgm', 'vector']);
    expect((await ensureDatabaseExtensions(ok.sql, { vectorSearch: true })).created).toEqual(['pg_trgm', 'vector']);
    await expect(ensureDatabaseExtensions(fakeSql(['pg_trgm']).sql, { vectorSearch: true })).rejects.toThrow(/does not offer the vector extension/);
    await expect(
      ensureDatabaseExtensions(fakeSql(['pg_trgm', 'vector'], ['vector']).sql, { vectorSearch: true }),
    ).rejects.toThrow(/could not be created: permission denied/);
  });

  it('requires pg_trgm', async () => {
    await expect(ensureDatabaseExtensions(fakeSql([]).sql)).rejects.toThrow(/pg_trgm/);
    await expect(ensureDatabaseExtensions(fakeSql(['pg_trgm'], ['pg_trgm']).sql)).rejects.toThrow(/pg_trgm/);
  });
});

describe('evaluateCapabilities', () => {
  const all = { trgm: true, vector: true, zhparser: true, zhConfig: true };
  it('needs vector only when vector search is enabled', () => {
    expect(evaluateCapabilities({ ...all, vector: false }, { vectorSearch: false }).ready).toBe(true);
    expect(evaluateCapabilities({ ...all, vector: false }, { vectorSearch: true }).missing.join()).toMatch(/vector/);
  });
  it('falls back to pg_trgm for Chinese without blocking readiness', () => {
    const report = evaluateCapabilities({ ...all, zhparser: false, zhConfig: false }, { vectorSearch: false });
    expect(report).toMatchObject({ ready: true, chineseSearch: 'trgm' });
  });
});
