import { describe, expect, it } from 'vitest';

import journal from '../../drizzle/meta/_journal.json';
import { getMigrationReadiness, LATEST_MIGRATION, type MigrationStatusQuery } from '../migration-status';

function queryReturning(rows: Array<Record<string, unknown>>): MigrationStatusQuery {
  return async () => rows;
}

function queryFailingWith(code: string): MigrationStatusQuery {
  return async () => {
    throw Object.assign(new Error(`postgres error ${code}`), { code });
  };
}

describe('migration readiness', () => {
  it('points at the newest journal entry', () => {
    const entries = (journal as { entries: Array<{ tag: string; when: number }> }).entries;
    expect(LATEST_MIGRATION).toEqual({ tag: entries.at(-1)!.tag, when: entries.at(-1)!.when });
  });

  it('is up to date when the newest applied migration matches the build', async () => {
    const state = await getMigrationReadiness(queryReturning([{ latest: String(LATEST_MIGRATION.when) }]));
    expect(state).toEqual({ upToDate: true, latestApplied: LATEST_MIGRATION.when, expected: LATEST_MIGRATION.when });
  });

  it('reports pending migrations when the database is behind', async () => {
    const state = await getMigrationReadiness(queryReturning([{ latest: LATEST_MIGRATION.when - 1 }]));
    expect(state.upToDate).toBe(false);
  });

  it('reports pending migrations when nothing has been applied yet', async () => {
    expect((await getMigrationReadiness(queryReturning([{ latest: null }]))).upToDate).toBe(false);
    expect((await getMigrationReadiness(queryFailingWith('42P01'))).upToDate).toBe(false);
    expect((await getMigrationReadiness(queryFailingWith('3F000'))).upToDate).toBe(false);
  });

  it('propagates other database errors instead of guessing', async () => {
    await expect(getMigrationReadiness(queryFailingWith('08006'))).rejects.toThrow(/08006/);
  });
});
