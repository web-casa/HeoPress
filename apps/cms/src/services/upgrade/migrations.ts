/**
 * Applying the target release's migrations for `heopress upgrade` (HeoPress P13 task 2.1): the same steps as
 * `packages/database/scripts/migrate.ts` (extensions, Drizzle migrations, UNLOGGED tables, queue schema), run against
 * the rehearsal copy first and production after. Every connection is an owner connection named `heopress-upgrade`, so
 * the drain does not wait for the upgrade itself.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { applyUnloggedTables, capabilityRequirementsFromEnv, ensureDatabaseExtensions, UNLOGGED_TABLES } from '@heopress/database';
import { installQueueSchema } from '@heopress/runtime/node';
import { UPGRADE_APPLICATION_NAME } from './maintenance-control';
import type { MigrationPort, MigrationStatus } from './ports';

/** The migrations of a release (`<folder>/meta/_journal.json` and the SQL files), oldest first. */
export function readBundledMigrations(folder: string): MigrationStatus['bundled'] {
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> };
  return journal.entries.map((e) => ({
    tag: e.tag,
    when: e.when,
    hash: createHash('sha256').update(readFileSync(path.join(folder, `${e.tag}.sql`), 'utf8')).digest('hex'),
  }));
}

/** An owner connection marked as the upgrade's own. */
export function upgradeConnection(databaseUrl: string): postgres.Sql {
  // `fetch_types: false`: a backup or restore terminates every session of the database (`pg_terminate_backend`), and
  // postgres.js runs its array-type query on each reconnect; when that query is the one terminated its rejection is
  // unhandled and would end the upgrade process mid-run. The upgrade sends no array parameters.
  return postgres(databaseUrl, { max: 1, onnotice: () => {}, fetch_types: false, connection: { application_name: UPGRADE_APPLICATION_NAME } });
}

export class DrizzleMigrations implements MigrationPort {
  constructor(
    private readonly folder: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async status(databaseUrl: string): Promise<MigrationStatus> {
    const sql = upgradeConnection(databaseUrl);
    try {
      const [version] = await sql<Array<{ v: string }>>`SELECT current_setting('server_version_num') AS v`;
      const [table] = await sql<Array<{ t: string | null }>>`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS t`;
      const applied = table?.t
        ? (await sql<Array<{ hash: string; created_at: string | number }>>`
            SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC, id ASC`).map((r) => ({
            hash: r.hash,
            createdAt: Number(r.created_at),
          }))
        : [];
      return { applied, bundled: readBundledMigrations(this.folder), postgresVersionNum: Number(version?.v ?? 0) };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  async apply(databaseUrl: string): Promise<void> {
    const sql = upgradeConnection(databaseUrl);
    try {
      const admin = sql as unknown as Parameters<typeof ensureDatabaseExtensions>[0];
      await ensureDatabaseExtensions(admin, capabilityRequirementsFromEnv(this.env));
      await migrate(drizzle(sql), { migrationsFolder: this.folder });
      await applyUnloggedTables(admin, UNLOGGED_TABLES);
    } finally {
      await sql.end({ timeout: 5 });
    }
    await installQueueSchema(databaseUrl);
  }
}
