#!/usr/bin/env -S npx tsx
/**
 * `heopress upgrade` (HeoPress P13 tasks 2.1, 2.3; spec ops/upgrades). Run on the host, from a checkout of the release
 * to install, with the owner connection of production:
 *
 *   heopress upgrade check                 # compatibility only; changes nothing
 *   heopress upgrade run                   # back up, rehearse, freeze, final backup, migrate, switch, smoke, open
 *   heopress upgrade status [--id <id>]    # the journal of the latest (or a given) run
 *   heopress upgrade rollback --id <id>    # retry the restore of a run that failed in maintenance
 *
 * Environment (no secret is printed):
 *   DATABASE_OWNER_URL                     owner connection of production (falls back to DATABASE_URL)
 *   HEOPRESS_UPGRADE_DIR                   journal, configuration copies (default ./data/upgrades)
 *   HEOPRESS_UPGRADE_ENV_FILE              Compose env file with HEOPRESS_VERSION (default ./.env)
 *   HEOPRESS_UPGRADE_COMPOSE_ARGS          arguments before `up` (default "-f docker/docker-compose.yml -f docker/docker-compose.prod.yml")
 *   HEOPRESS_UPGRADE_SERVICES              services to switch (default "cms worker site")
 *   HEOPRESS_UPGRADE_CONFIG_FILES          more configuration files to snapshot, comma-separated
 *   HEOPRESS_UPGRADE_CMS_URL               the CMS as seen from the host (default http://127.0.0.1:1989)
 *   HEOPRESS_UPGRADE_SMOKE_URLS            public pages that must answer 200 afterwards, comma-separated
 *   HEOPRESS_UPGRADE_DRAIN_TIMEOUT_SECONDS how long writers may take to drain (default 120)
 *   HEOPRESS_UPGRADE_TARGET_VERSION        the release installed (default: this checkout's version)
 *   MIGRATIONS_FOLDER                      the release's migrations (default packages/database/drizzle)
 *
 * Backups come from the backup module (P13 1.x), configured as for `heopress backup` (`HEOPRESS_BACKUP_TARGET` and
 * the other `HEOPRESS_BACKUP_*` settings; the upgrade's backups are dumps): registered here with
 * `registerUpgradeBackupProvider`. Without a backup target the upgrade stops at the compatibility check.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { resolveBuildMetadata } from '../src/routes/system';
import { backupsConfigured } from '../src/services/backup/config';
import { backupModuleProviderFromEnv } from '../src/services/upgrade/adapters/backup-module';
import { ComposeAppRelease } from '../src/services/upgrade/adapters/compose-app';
import { ConfigFiles } from '../src/services/upgrade/adapters/config-files';
import { HttpSmoke } from '../src/services/upgrade/adapters/http-smoke';
import { ScratchDatabase } from '../src/services/upgrade/adapters/scratch-db';
import { checkCompatibility } from '../src/services/upgrade/compat';
import { UpgradeJournal, type UpgradeRun } from '../src/services/upgrade/journal';
import { listInstalledPlugins, MaintenanceControl, type ControlSql } from '../src/services/upgrade/maintenance-control';
import { DrizzleMigrations, upgradeConnection } from '../src/services/upgrade/migrations';
import { rollbackUpgrade, runUpgrade, type UpgradeDeps } from '../src/services/upgrade/orchestrator';
import { registerUpgradeBackupProvider, upgradeBackupProvider } from '../src/services/upgrade/ports';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function list(value: string | undefined, sep: RegExp): string[] {
  return (value ?? '').split(sep).map((s) => s.trim()).filter(Boolean);
}

function printRun(run: UpgradeRun): void {
  console.log(`upgrade ${run.id}: ${run.fromVersion} → ${run.toVersion} — ${run.status}`);
  for (const s of run.steps) console.log(`  ${s.status === 'ok' ? '✔' : s.status === 'failed' ? '✖' : '-'} ${s.name}${s.detail ? `: ${s.detail}` : ''}`);
  if (run.status === 'failed-in-maintenance') {
    console.log('  Maintenance stays on and writes stay refused until the restore verifies.');
    console.log(`  Fix the failed step, then: heopress upgrade rollback --id ${run.id}`);
  }
}

export async function runUpgradeCli(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const [command] = args;
  const dir = path.resolve(env.HEOPRESS_UPGRADE_DIR?.trim() || 'data/upgrades');
  const journal = new UpgradeJournal(dir);
  if (command === 'status') {
    const id = flag(args, 'id');
    const run = id ? journal.load(id) : journal.latest();
    if (!run) {
      console.log(id ? `no upgrade ${id}` : 'no upgrade has run yet');
      return id ? 1 : 0;
    }
    printRun(run);
    return 0;
  }
  if (command !== 'check' && command !== 'run' && command !== 'rollback') {
    console.error('Usage: heopress upgrade <check|run|status|rollback> [--id <id>]');
    return 1;
  }
  const ownerUrl = env.DATABASE_OWNER_URL?.trim() || env.DATABASE_URL?.trim();
  if (!ownerUrl) {
    console.error('DATABASE_OWNER_URL (the owner connection of production) is required.');
    return 1;
  }
  const migrationsFolder = path.resolve(env.MIGRATIONS_FOLDER?.trim() || path.join(HERE, '../../../packages/database/drizzle'));
  const targetVersion =
    env.HEOPRESS_UPGRADE_TARGET_VERSION?.trim() || (JSON.parse(readFileSync(path.join(HERE, '../package.json'), 'utf8')) as { version: string }).version;
  const envFile = path.resolve(env.HEOPRESS_UPGRADE_ENV_FILE?.trim() || '.env');
  const cmsUrl = env.HEOPRESS_UPGRADE_CMS_URL?.trim() || 'http://127.0.0.1:1989';
  const sql = upgradeConnection(ownerUrl);
  const control = sql as unknown as ControlSql;
  // The backup module, when a backup target is configured and nothing else registered a provider.
  let closeBackups: (() => Promise<void>) | null = null;
  if (!upgradeBackupProvider() && backupsConfigured(env)) {
    const runtime = createRuntime(env);
    const client = postgres(ownerUrl, { max: 2, onnotice: () => {}, fetch_types: false });
    const build = resolveBuildMetadata();
    const unregister = registerUpgradeBackupProvider(
      backupModuleProviderFromEnv({
        env,
        db: drizzle(client, { schema }) as unknown as Database,
        storage: runtime.storage,
        keys: runtime.keys,
        app: { version: build.version, gitSha: build.gitSha },
        productionDatabaseUrl: ownerUrl,
      }),
    );
    closeBackups = async () => {
      unregister();
      await runtime.queue.close?.().catch(() => undefined);
      await runtime.database.close().catch(() => undefined);
      await client.end({ timeout: 2 });
    };
  }
  try {
    const app = new ComposeAppRelease({
      envFile,
      composeArgs: list(env.HEOPRESS_UPGRADE_COMPOSE_ARGS ?? '-f docker/docker-compose.yml -f docker/docker-compose.prod.yml', /\s+/),
      services: list(env.HEOPRESS_UPGRADE_SERVICES ?? 'cms worker site', /\s+/),
      versionUrl: `${cmsUrl.replace(/\/+$/, '')}/api/v1/system/version`,
    });
    const migrations = new DrizzleMigrations(migrationsFolder, env);
    const deps: UpgradeDeps = {
      journal,
      backup: upgradeBackupProvider(),
      app,
      config: new ConfigFiles([envFile, ...list(env.HEOPRESS_UPGRADE_CONFIG_FILES, /,/).map((f) => path.resolve(f))], dir),
      migrations,
      rehearsal: new ScratchDatabase(ownerUrl),
      smoke: new HttpSmoke({ cmsUrl, urls: list(env.HEOPRESS_UPGRADE_SMOKE_URLS, /,/) }),
      maintenance: new MaintenanceControl({ sql: control }),
      listPlugins: () => listInstalledPlugins(control),
      databaseUrl: ownerUrl,
      targetVersion,
      drainTimeoutMs: Number(env.HEOPRESS_UPGRADE_DRAIN_TIMEOUT_SECONDS ?? 120) * 1000,
      log: (line) => console.log(line),
    };
    if (command === 'check') {
      const status = await migrations.status(ownerUrl);
      const report = checkCompatibility({
        currentVersion: (await app.current()).version,
        targetVersion,
        postgresVersionNum: status.postgresVersionNum,
        applied: status.applied,
        bundled: status.bundled,
        plugins: await deps.listPlugins(),
        backupProvider: deps.backup !== null,
      });
      for (const p of report.problems) console.log(`✖ ${p}`);
      if (report.ok) console.log(report.upToDate ? `already on ${targetVersion}` : `ready: ${report.pending.length} pending migration(s)`);
      return report.ok ? 0 : 2;
    }
    if (command === 'rollback') {
      const id = flag(args, 'id');
      if (!id) {
        console.error('rollback needs --id <upgrade id> (see `heopress upgrade status`)');
        return 1;
      }
      const out = await rollbackUpgrade(id, deps);
      if (out.refused) {
        console.error(out.refused);
        return 2;
      }
      printRun(out.run!);
      return out.run!.status === 'failed-in-maintenance' ? 3 : 0;
    }
    const run = await runUpgrade(deps);
    printRun(run);
    return run.status === 'completed' || run.status === 'up-to-date' ? 0 : run.status === 'failed-in-maintenance' ? 3 : 2;
  } finally {
    await sql.end({ timeout: 5 });
    await closeBackups?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runUpgradeCli(process.argv.slice(2));
}
