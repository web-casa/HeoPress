/**
 * `heopress upgrade` against a real PostgreSQL (HeoPress P13 tasks 2.1, 2.3; spec ops/upgrades "迁移失败", "预演发现问题",
 * "预演期间继续写入").
 *
 * Production is a scratch database migrated with the real migrations; the target release is the same migrations plus
 * one probe migration. Real: migrations (`DrizzleMigrations`), rehearsal database, maintenance switch and drain, the
 * process write gate and its HTTP guard, configuration snapshot, the Compose release adapter (its `docker compose`
 * runner and version endpoint replaced).
 *
 * The scenarios that back up and restore run twice: with a test double that copies whole databases (`CREATE DATABASE
 * … TEMPLATE`), and with the backup module itself (P13 1.x; `BackupModuleUpgradeProvider`, as `heopress upgrade`
 * registers it: dumps in a local target, encrypted, restored with `pg_restore` and swapped in). The second needs the
 * PostgreSQL 18 programs (`HEOPRESS_TEST_PG_BIN_DIR`, default `/usr/lib/postgresql/18/bin`); CI sets
 * `HEOPRESS_TEST_BACKUP_TOOLS=required`, where their absence fails the suite instead of skipping those scenarios.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, type Database } from '@heopress/database';
import { LocalFileStorageProvider } from '@heopress/runtime/docker';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import type { AppEnv } from '../../../env';
import { withWriteGate } from '../../../middleware/maintenance';
import { instanceMediaSource } from '../../backup/media-backup';
import { backupDir } from '../../backup/manifest';
import { pgToolsAvailable } from '../../backup/pg-tools';
import { LocalDirTarget } from '../../backup/target';
import { WriteGate, type GateSql } from '../../maintenance/write-gate';
import type { DeletionLedgerEntry, DeletionLedgerSink } from '../../retention/deletion-ledger';
import { BackupModuleUpgradeProvider, type BackupModuleProviderDeps } from '../adapters/backup-module';
import { ComposeAppRelease } from '../adapters/compose-app';
import { ConfigFiles } from '../adapters/config-files';
import { ScratchDatabase } from '../adapters/scratch-db';
import { UpgradeJournal } from '../journal';
import { isConnectionLost, listInstalledPlugins, MaintenanceControl, type ControlSql } from '../maintenance-control';
import { DrizzleMigrations, readBundledMigrations, upgradeConnection } from '../migrations';
import { rollbackUpgrade, runUpgrade, type UpgradeDeps } from '../orchestrator';
import type { UpgradeBackupProvider, UpgradeBackupRef } from '../ports';

const MIGRATIONS = path.resolve(__dirname, '../../../../../../packages/database/drizzle');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BIN = process.env.HEOPRESS_TEST_PG_BIN_DIR?.trim() || (existsSync('/usr/lib/postgresql/18/bin') ? '/usr/lib/postgresql/18/bin' : null);
const toolsRequired = process.env.HEOPRESS_TEST_BACKUP_TOOLS === 'required';
const toolsPresent = hasDbIntegrationUrl ? await pgToolsAvailable(['pg_dump', 'pg_restore'], BIN) : false;
type BackupKind = 'template double' | 'backup module';
// Without the programs the backup module's scenarios are skipped — unless CI requires them, where they fail.
const BACKUP_KINDS: BackupKind[] = toolsPresent || toolsRequired ? ['template double', 'backup module'] : ['template double'];

/**
 * The test's own statements (a user's save, reading the state back). The backup double terminates every session of
 * production on each copy, as a restore does, so the next statement on the pool can fail with 57P01 or a closed
 * connection; a user would retry, and so does the test.
 */
async function again<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 3 || !isConnectionLost(err)) throw err;
      await sleep(50);
    }
  }
}

function urlFor(base: string, name: string): string {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Test double of the backup module: a backup is a copy of the whole database (`TEMPLATE`). */
class TemplateBackups implements UpgradeBackupProvider {
  readonly name = 'template-test-double';
  readonly created: string[] = [];
  failRestore = false;
  /** Called before the rehearsal copy is restored (simulates users working meanwhile). */
  beforeCopy: () => Promise<void> = async () => {};
  private restoredFrom: string | null = null;
  private n = 0;

  constructor(
    private readonly admin: postgres.Sql,
    private readonly prod: string,
  ) {}

  /**
   * `CREATE DATABASE … TEMPLATE` needs the source to itself: new sessions are refused while it copies (the gate keeps
   * its last state meanwhile, as in a restore) and the open ones are terminated, so the copy does not race the pool's
   * reconnects (which made it wait out PostgreSQL's 5 s per attempt on a loaded machine).
   */
  private async copy(from: string, to: string): Promise<void> {
    await this.admin.unsafe(`ALTER DATABASE "${from}" ALLOW_CONNECTIONS false`);
    try {
      for (let attempt = 0; ; attempt++) {
        await this.admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${from} AND pid <> pg_backend_pid()`;
        try {
          await this.admin.unsafe(`CREATE DATABASE "${to}" TEMPLATE "${from}"`);
          return;
        } catch (err) {
          if (attempt >= 40 || !/being accessed by other users/.test((err as Error).message)) throw err;
          await sleep(25);
        }
      }
    } finally {
      await this.admin.unsafe(`ALTER DATABASE "${from}" ALLOW_CONNECTIONS true`);
    }
  }

  async takeBackup({ purpose }: { purpose: string }): Promise<UpgradeBackupRef> {
    const id = `${this.prod}_bk${++this.n}`;
    await this.copy(this.prod, id);
    this.created.push(id);
    return { id, takenAt: new Date().toISOString(), manifestSha256: purpose };
  }

  async restoreCopy(backup: UpgradeBackupRef, target: { databaseUrl: string }): Promise<void> {
    await this.beforeCopy();
    const name = new URL(target.databaseUrl).pathname.slice(1);
    await this.admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await this.copy(backup.id, name);
  }

  async restoreProduction(backup: UpgradeBackupRef): Promise<void> {
    if (this.failRestore) throw new Error('backup storage unreachable');
    await this.admin.unsafe(`DROP DATABASE IF EXISTS "${this.prod}" WITH (FORCE)`);
    await this.copy(backup.id, this.prod);
    this.restoredFrom = backup.id;
  }

  async verifyProduction(backup: UpgradeBackupRef): Promise<{ ok: boolean; problems: string[] }> {
    return this.restoredFrom === backup.id ? { ok: true, problems: [] } : { ok: false, problems: [`production was not restored from ${backup.id}`] };
  }
}

/**
 * The backup module, as `heopress upgrade` registers it. `failRestore` corrupts the database object of the backup a
 * restore reads (one flipped byte in the target), so the restore fails on its own integrity check; once cleared, the
 * object is repaired before the next restore.
 */
class ModuleBackups extends BackupModuleUpgradeProvider {
  failRestore = false;
  beforeCopy: () => Promise<void> = async () => {};
  private tampered: { file: string; bytes: Buffer } | null = null;

  constructor(
    deps: BackupModuleProviderDeps,
    private readonly targetRoot: string,
  ) {
    super(deps);
  }

  override async restoreCopy(backup: UpgradeBackupRef, target: { databaseUrl: string }): Promise<void> {
    await this.beforeCopy();
    await super.restoreCopy(backup, target);
  }

  override async restoreProduction(backup: UpgradeBackupRef): Promise<void> {
    if (this.failRestore && !this.tampered) {
      const dir = path.join(this.targetRoot, backupDir(backup.id), 'database');
      const file = path.join(dir, readdirSync(dir)[0]!);
      const bytes = readFileSync(file);
      const bad = Buffer.from(bytes);
      bad[bad.length >> 1]! ^= 0xff;
      writeFileSync(file, bad);
      this.tampered = { file, bytes };
    } else if (!this.failRestore && this.tampered) {
      writeFileSync(this.tampered.file, this.tampered.bytes);
      this.tampered = null;
    }
    await super.restoreProduction(backup);
  }
}

describe.skipIf(!hasDbIntegrationUrl)('heopress upgrade — DB integration', () => {
  let db: Database | undefined;
  let admin: postgres.Sql;
  const adminUrl = process.env.DATABASE_OWNER_URL?.trim() || dbIntegrationUrl!;
  const golden = `heopress_upg_golden_${process.pid}`;
  // The application's role, when it is not the owner: its privileges must survive a restore.
  const appRole = decodeURIComponent(new URL(dbIntegrationUrl ?? 'postgres://x@127.0.0.1/x').username);
  const appRoleApart = hasDbIntegrationUrl && appRole !== decodeURIComponent(new URL(adminUrl).username);
  const databases: string[] = [golden];
  const work = mkdtempSync(path.join(tmpdir(), 'heopress-upgrade-db-'));
  const bundledCount = readBundledMigrations(MIGRATIONS).length;
  let scenario = 0;

  beforeAll(async () => {
    if (toolsRequired) expect(toolsPresent, `the PostgreSQL 18 programs (pg_dump, pg_restore) are required (HEOPRESS_TEST_PG_BIN_DIR)`).toBe(true);
    db = await connectDbIntegration('upgrade');
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${golden}"`);
    await new DrizzleMigrations(MIGRATIONS).apply(urlFor(adminUrl, golden));
    const g = postgres(urlFor(adminUrl, golden), { max: 1, onnotice: () => {} });
    await g`CREATE TABLE upgrade_probe_data (id integer PRIMARY KEY, note text NOT NULL)`;
    await g`INSERT INTO upgrade_probe_data VALUES (1, 'original')`;
    if (appRoleApart) await g.unsafe(`GRANT SELECT, UPDATE ON upgrade_probe_data TO "${appRole}"`);
    await g.end({ timeout: 5 });
  }, 120_000);

  afterAll(async () => {
    if (admin) {
      for (const name of databases) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
    rmSync(work, { recursive: true, force: true });
    await (db as unknown as { $client?: { end?: () => Promise<void> } } | undefined)?.$client?.end?.();
  }, 120_000);

  /** A production database, the target release's migrations (with `probe` as the new migration) and every port. */
  async function world(probe: string, kind: BackupKind = 'template double', opts: { ledgerSink?: DeletionLedgerSink } = {}) {
    scenario += 1;
    const prod = `heopress_upg_prod_${process.pid}_${scenario}`;
    databases.push(prod);
    await admin.unsafe(`CREATE DATABASE "${prod}" TEMPLATE "${golden}"`);
    if (appRoleApart) await admin.unsafe(`GRANT CONNECT ON DATABASE "${prod}" TO "${appRole}"`);
    const prodUrl = urlFor(adminUrl, prod);
    const dir = path.join(work, `s${scenario}`);
    const folder = path.join(dir, 'drizzle');
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journalFile = path.join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as { entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> };
    const last = journal.entries.at(-1)!;
    journal.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag: '9999_upgrade_probe', breakpoints: true });
    writeFileSync(journalFile, JSON.stringify(journal));
    writeFileSync(path.join(folder, '9999_upgrade_probe.sql'), probe);

    const envFile = path.join(dir, 'compose.env');
    writeFileSync(envFile, 'HEOPRESS_VERSION=1.0.0\nHEOPRESS_PUBLIC_URL=https://cms.example.com\n', { mode: 0o600 });
    const pin = () => /^HEOPRESS_VERSION=(.*)$/m.exec(readFileSync(envFile, 'utf8'))?.[1] ?? null;
    let running: string | null = '1.0.0';
    const composeCalls: string[][] = [];
    const app = new ComposeAppRelease({
      envFile,
      composeArgs: ['-f', 'docker-compose.prod.yml'],
      versionUrl: 'http://cms.example.com/api/v1/system/version',
      run: async (_file, args) => {
        composeCalls.push(args);
        running = pin();
      },
      fetch: (async () => new Response(JSON.stringify({ version: running }), { status: 200 })) as typeof fetch,
    });

    // The process's pool (the gate and the test's writes). The backup double terminates its sessions on every copy, as
    // a real restore does; without the array-type query on reconnect a terminated reconnect cannot leave an unhandled
    // rejection behind (postgres.js).
    const sql = postgres(prodUrl, { max: 2, onnotice: () => {}, fetch_types: false });
    // The upgrade's own session, as the command opens it.
    const controlSql = upgradeConnection(prodUrl);
    const gate = new WriteGate({ sql: sql as unknown as GateSql, processRole: 'all', pollMs: 20, heartbeatMs: 200, log: () => {} });
    await gate.start();
    // The backup module's catalogue is production's: its own pool, as the command opens it.
    const catalogueSql = postgres(prodUrl, { max: 2, onnotice: () => {}, fetch_types: false });
    let backups: TemplateBackups | ModuleBackups;
    if (kind === 'template double') backups = new TemplateBackups(admin, prod);
    else {
      const targetRoot = path.join(dir, 'target');
      mkdirSync(path.join(dir, 'keys'), { mode: 0o700 });
      const keyFile = path.join(dir, 'keys', 'backup.key');
      writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
      const media = new LocalFileStorageProvider(path.join(dir, 'media'));
      backups = new ModuleBackups(
        {
          backup: {
            db: drizzle(catalogueSql, { schema }) as unknown as Database,
            config: {
              target: new LocalDirTarget(targetRoot),
              databaseUrl: prodUrl,
              method: 'basebackup',
              keyFile,
              configFiles: [],
              drillDatabaseUrl: null,
              pgBinDir: BIN,
              maxChain: 48,
              schedule: { enabled: false, full: '0 0 0 * * *', incremental: '0 0 * * * *', drill: '0 0 0 * * 0' },
              retention: { daily: 14, weekly: 8 },
            },
            mediaSources: [instanceMediaSource(media)],
            env: { HEOPRESS_PUBLIC_URL: 'https://cms.example.com', JWT_SECRET: 'fake-short' },
            app: { version: '1.0.0', gitSha: 'test' },
          },
          productionDatabaseUrl: prodUrl,
          storage: media,
          ledgerSink: opts.ledgerSink ?? null,
        },
        targetRoot,
      );
    }
    const smoke = { failures: [] as string[] };
    const deps: UpgradeDeps = {
      journal: new UpgradeJournal(path.join(dir, 'journal')),
      backup: backups,
      app,
      config: new ConfigFiles([envFile], path.join(dir, 'journal')),
      migrations: new DrizzleMigrations(folder),
      rehearsal: new ScratchDatabase(prodUrl),
      smoke: { run: async () => ({ ok: smoke.failures.length === 0, failures: smoke.failures }) },
      maintenance: new MaintenanceControl({ sql: controlSql as unknown as ControlSql, livenessMs: 5_000, pollMs: 20 }),
      listPlugins: () => listInstalledPlugins(controlSql as unknown as ControlSql),
      databaseUrl: prodUrl,
      targetVersion: '1.1.0',
      drainTimeoutMs: 10_000,
    };
    /** The double's copies; the module's replaced or half-restored databases. */
    const besideProduction = async () =>
      (await admin<Array<{ datname: string }>>`SELECT datname FROM pg_database WHERE datname LIKE ${`${prod}\\_%`} ORDER BY 1`).map((r) => r.datname);
    /** Production as the application's role sees it. */
    const asApp = async () => {
      const app = postgres(urlFor(dbIntegrationUrl!, prod), { max: 1, onnotice: () => {}, fetch_types: false });
      try {
        const [row] = await app<Array<{ note: string }>>`SELECT note FROM upgrade_probe_data WHERE id = 1`;
        return row?.note;
      } finally {
        await app.end({ timeout: 5 });
      }
    };
    const done = async () => {
      await gate.stop();
      await sql.end({ timeout: 5 });
      await controlSql.end({ timeout: 5 });
      await catalogueSql.end({ timeout: 5 });
      for (const name of await besideProduction()) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    };
    const q = async <T extends readonly object[]>(text: string) => (await again(() => sql.unsafe(text))) as unknown as T;
    const state = async () => {
      const [m] = await q<Array<{ active: boolean; epoch: string }>>('SELECT active, epoch FROM lumibase_maintenance WHERE id = 1');
      const [h] = await q<Array<{ n: string }>>('SELECT count(*) AS n FROM drizzle.__drizzle_migrations');
      const [d] = await q<Array<{ note: string }>>('SELECT note FROM upgrade_probe_data WHERE id = 1');
      const cols = await q<Array<{ column_name: string }>>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'upgrade_probe_data' ORDER BY column_name",
      );
      return { active: m!.active, epoch: Number(m!.epoch), migrations: Number(h!.n), note: d!.note, columns: cols.map((c) => c.column_name) };
    };
    const scratchLeft = async () =>
      (await admin<Array<{ datname: string }>>`SELECT datname FROM pg_database WHERE datname LIKE 'heopress_upgrade_%'`).map((r) => r.datname);
    /** Wait until the gate has read the switch again. */
    const settle = async () => {
      await sleep(60);
      await gate.poll();
    };
    /**
     * Production's effective database and table privileges: a missing list is the defaults (a dump writes no grants
     * for a list equal to them), and the entries are compared in any order.
     */
    const privileges = async () =>
      q<Array<{ name: string; acl: string }>>(
        `SELECT '' AS name, (SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(coalesce(datacl, acldefault('d', datdba))) a) AS acl
           FROM pg_database WHERE datname = current_database()
         UNION ALL
         SELECT n.nspname || '.' || c.relname,
                (SELECT string_agg(a::text, ',' ORDER BY a::text)
                   FROM unnest(coalesce(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) a)
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
         ORDER BY 1`,
      );
    const catalogue = async () => (await q<Array<{ status: string }>>('SELECT status FROM lumibase_backups ORDER BY started_at')).map((r) => r.status);
    return {
      deps,
      gate,
      sql,
      controlSql,
      prod,
      backups,
      smoke,
      pin,
      composeCalls,
      state,
      privileges,
      catalogue,
      besideProduction,
      asApp,
      scratchLeft,
      settle,
      done,
      running: () => running,
    };
  }

  const FAILS_AFTER_EDIT =
    `ALTER TABLE upgrade_probe_data ADD COLUMN added text;--> statement-breakpoint\n` +
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM upgrade_probe_data WHERE note = 'edited during rehearsal') THEN RAISE EXCEPTION 'probe: injected failure'; END IF; END $$;`;

  it('a migration that fails in the rehearsal never enters maintenance and leaves production unchanged', async () => {
    const w = await world('SELECT * FROM upgrade_probe_missing_table;');
    try {
      const before = await w.state();
      const run = await runUpgrade(w.deps);
      expect(run.status).toBe('aborted');
      expect(run.failures[0]).toMatch(/^rehearsal: .*upgrade_probe_missing_table/);
      expect(run.steps.map((s) => s.name)).not.toContain('maintenance');
      expect(run.backups.final).toBeUndefined();
      expect(await w.state()).toEqual(before);
      expect(before).toMatchObject({ active: false, migrations: bundledCount });
      expect(w.gate.isFrozen()).toBe(false);
      expect(w.composeCalls).toEqual([]);
      expect(await w.scratchLeft()).toEqual([]);
    } finally {
      await w.done();
    }
  }, 120_000);

  describe.each(BACKUP_KINDS)('with the %s', (kind) => {
    it('a change saved during the rehearsal survives a migration failure on production; writes reopen after the verified restore', async () => {
      const w = await world(FAILS_AFTER_EDIT, kind);
      try {
        // A user saves while the rehearsal runs: through the gate, like an API write.
        let saved: string | undefined;
        const privileges = await w.privileges();
        w.backups.beforeCopy = async () => {
          const leave = w.gate.enter();
          expect(leave).toBeTypeOf('function');
          await again(() => w.sql`UPDATE upgrade_probe_data SET note = 'edited during rehearsal' WHERE id = 1`);
          leave!();
          saved = (await again(() => w.sql<Array<{ note: string }>>`SELECT note FROM upgrade_probe_data WHERE id = 1`))[0]?.note;
        };
        const run = await runUpgrade(w.deps);
        // A failure shows which path the run took.
        const outcome = JSON.stringify({ saved, failures: run.failures, steps: run.steps.map((s) => `${s.name}:${s.status}`) });
        expect(run.status, outcome).toBe('rolled-back');
        expect(saved).toBe('edited during rehearsal');
        expect(run.failures[0]).toMatch(/^migrate: .*probe: injected failure/);
        expect(run.steps.filter((s) => s.name === 'rehearsal')[0]!.status).toBe('ok');
        const after = await w.state();
        expect(after).toMatchObject({ active: false, migrations: bundledCount, note: 'edited during rehearsal', columns: ['id', 'note'] });
        await w.settle();
        expect(w.gate.isFrozen()).toBe(false);
        expect(w.pin()).toBe('1.0.0');
        if (kind === 'backup module') {
          // A real restore: production's privileges (database and tables) as before, the application's role can use it,
          // both backups in its catalogue as they finished, the replaced database dropped once verified.
          expect(await w.privileges()).toEqual(privileges);
          if (appRoleApart) expect(await w.asApp()).toBe('edited during rehearsal');
          expect(await w.catalogue()).toEqual(['succeeded', 'succeeded']);
          expect(await w.besideProduction()).toEqual([]);
        }
      } finally {
        await w.done();
      }
    }, 120_000);

    it('a failed smoke test after the switch restores database, configuration and application', async () => {
      const w = await world('ALTER TABLE upgrade_probe_data ADD COLUMN added text;', kind);
      try {
        w.smoke.failures = ['/health/ready answered 503'];
        const run = await runUpgrade(w.deps);
        expect(run.status).toBe('rolled-back');
        expect(run.steps.map((s) => `${s.name}:${s.status}`).slice(-7)).toEqual([
          'activate:ok',
          'smoke:failed',
          'restore-config:ok',
          'restore-database:ok',
          'restore-app:ok',
          'verify-restore:ok',
          'open-writes:ok',
        ]);
        // The migration had been applied and was undone by the restore.
        expect(await w.state()).toMatchObject({ active: false, migrations: bundledCount, columns: ['id', 'note'] });
        expect(w.pin()).toBe('1.0.0');
        expect(w.running()).toBe('1.0.0');
        expect(w.composeCalls.map((a) => a.join(' '))).toEqual([
          'compose -f docker-compose.prod.yml up -d --wait cms cms-worker site-classic',
          'compose -f docker-compose.prod.yml up -d --wait cms cms-worker site-classic',
        ]);
      } finally {
        await w.done();
      }
    }, 120_000);

    it('a restore that fails keeps maintenance on and every write refused; a later rollback opens them after verifying', async () => {
      const w = await world(FAILS_AFTER_EDIT, kind);
      try {
        w.backups.beforeCopy = async () => {
          await again(() => w.sql`UPDATE upgrade_probe_data SET note = 'edited during rehearsal' WHERE id = 1`);
        };
        w.backups.failRestore = true;
        const run = await runUpgrade(w.deps);
        expect(run.status).toBe('failed-in-maintenance');
        expect(run.failures.map((f) => f.split(':')[0])).toEqual(['migrate', 'restore-database', 'verify-restore']);
        expect((await w.state()).active).toBe(true);
        await w.settle();
        expect(w.gate.isFrozen()).toBe(true);
        const api = new Hono<AppEnv>();
        api.use('*', withWriteGate(() => w.gate));
        api.post('/api/v1/items/posts', (c) => c.json({ data: 'saved' }));
        expect((await api.request('/api/v1/items/posts', { method: 'POST' })).status).toBe(503);
        expect(new UpgradeJournal(path.join(work, `s${scenario}`, 'journal')).load(run.id)?.status).toBe('failed-in-maintenance');
        if (kind === 'backup module') {
          // The corrupted backup was refused before anything replaced production.
          expect(run.failures[1]).toMatch(/could not be decrypted: wrong key, or the file was altered/);
          expect(await w.besideProduction()).toEqual([]);
        }

        w.backups.failRestore = false;
        const retried = await rollbackUpgrade(run.id, w.deps);
        expect(retried.run?.status).toBe('rolled-back');
        expect(await w.state()).toMatchObject({ active: false, migrations: bundledCount, note: 'edited during rehearsal' });
        await w.settle();
        expect(w.gate.isFrozen()).toBe(false);
        expect((await api.request('/api/v1/items/posts', { method: 'POST' })).status).toBe(200);
        if (kind === 'backup module') expect(await w.besideProduction()).toEqual([]);
      } finally {
        await w.done();
      }
    }, 120_000);

    it('a successful upgrade opens writes on the new release, and rollback then refuses to discard data', async () => {
      const w = await world('ALTER TABLE upgrade_probe_data ADD COLUMN added text;', kind);
      try {
        const run = await runUpgrade(w.deps);
        expect(run.failures).toEqual([]);
        expect(run.status).toBe('completed');
        expect(await w.state()).toMatchObject({ active: false, migrations: bundledCount + 1, columns: ['added', 'id', 'note'] });
        expect(w.pin()).toBe('1.1.0');
        expect(await w.scratchLeft()).toEqual([]);
        await again(() => w.sql`UPDATE upgrade_probe_data SET note = 'written on 1.1.0' WHERE id = 1`);
        const out = await rollbackUpgrade(run.id, w.deps);
        expect(out.refused).toMatch(/writes have been open on 1\.1\.0/);
        expect(await w.state()).toMatchObject({ note: 'written on 1.1.0', migrations: bundledCount + 1 });
        // Up to date now: a second run changes nothing.
        expect((await runUpgrade({ ...w.deps, app: { ...w.deps.app, current: async () => ({ version: '1.1.0' }) } })).status).toBe('up-to-date');
      } finally {
        await w.done();
      }
    }, 120_000);
  });

  it.runIf(BACKUP_KINDS.includes('backup module'))(
    'with the backup module, a backup that fails stops the upgrade before maintenance, and a restore it did not do is not vouched for',
    async () => {
      const w = await world('ALTER TABLE upgrade_probe_data ADD COLUMN added text;', 'backup module');
      const keyFile = path.join(work, `s${scenario}`, 'keys', 'backup.key');
      const key = readFileSync(keyFile);
      try {
        const before = await w.state();
        rmSync(keyFile);
        const run = await runUpgrade(w.deps);
        expect(run.status).toBe('aborted');
        expect(run.failures[0]).toMatch(/^backup: backup \S+ failed: KEY_/);
        expect(run.steps.map((s) => s.name)).not.toContain('maintenance');
        expect(await w.state()).toEqual(before);
        expect(await w.catalogue()).toEqual(['failed']);

        writeFileSync(keyFile, key, { mode: 0o600 });
        const module = w.backups as ModuleBackups;
        const ref = await module.takeBackup();
        expect(ref.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
        const verdict = await module.verifyProduction(ref);
        expect(verdict.ok).toBe(false);
        expect(verdict.problems).toEqual([`production was not restored from ${ref.id} by this run`]);
      } finally {
        await w.done();
      }
    },
    120_000,
  );

  // P13 task 6.4 (reverse acceptance): skipping the ledger replay in the module's production restore, or opening writes
  // although a record failed, left every other scenario green — the restore flow's own replay was untested.
  // Three restores (two upgrades and a rollback): a longer budget than the scenarios with one.
  it.runIf(BACKUP_KINDS.includes('backup module'))(
    'with the backup module, the restore replays the deletion ledger before writes open; a record it cannot delete again keeps maintenance on (P13 task 5.2)',
    async () => {
      // The external ledger: outside the database, so a restore does not roll it back.
      const entries: DeletionLedgerEntry[] = [];
      const sink: DeletionLedgerSink = {
        name: 'test-ledger',
        readAll: async () => [...entries],
        append: async (more) => {
          entries.push(...more);
        },
      };
      const w = await world('ALTER TABLE upgrade_probe_data ADD COLUMN added text;', 'backup module', { ledgerSink: sink });
      const site = `site_upg_ledger_${scenario}`;
      const erased = `${site}_erased`;
      const kept = `${site}_kept`;
      const entry = (n: number, objectScope: string, objectId: string): DeletionLedgerEntry => ({
        id: `led_${site}_${n}`,
        siteId: site,
        requestId: `req_${site}`,
        objectKind: 'item',
        objectScope,
        objectId,
        action: 'hard_delete',
        erasedAt: new Date().toISOString(),
      });
      const itemsLeft = async () =>
        (await again(() => w.sql<Array<{ id: string }>>`SELECT id FROM lumibase_items WHERE site_id = ${site} ORDER BY id`)).map((r) => r.id);
      try {
        // Production holds an item the ledger names (recorded before the row is deleted, so a crash in between leaves
        // it): it is in every backup the upgrade takes, and the restore must delete it again before writes open.
        await again(() => w.sql`INSERT INTO lumibase_sites (id, name) VALUES (${site}, 'Ledger replay')`);
        await again(() => w.sql`INSERT INTO lumibase_collections (id, site_id, name) VALUES (${`${site}_articles`}, ${site}, 'articles')`);
        await again(() => w.sql`INSERT INTO lumibase_items (id, site_id, collection_id) VALUES (${erased}, ${site}, ${`${site}_articles`}), (${kept}, ${site}, ${`${site}_articles`})`);
        entries.push(entry(1, 'articles', erased));
        w.smoke.failures = ['/health/ready answered 503'];
        const run = await runUpgrade(w.deps);
        expect(run.status, JSON.stringify(run.failures)).toBe('rolled-back');
        expect(await itemsLeft()).toEqual([kept]);
        // The restored (older) ledger table has the record again.
        expect((await again(() => w.sql`SELECT id FROM lumibase_deletion_ledger WHERE site_id = ${site}`)).map((r) => r.id)).toEqual([`led_${site}_1`]);
        await w.settle();
        expect(w.gate.isFrozen()).toBe(false);

        // A record that cannot be deleted again (its collection does not exist): the restore fails and writes stay closed.
        const bad = entry(2, 'no_such_collection', kept);
        entries.push(bad);
        const failed = await runUpgrade(w.deps);
        expect(failed.status).toBe('failed-in-maintenance');
        expect(failed.failures.find((f) => f.startsWith('restore-database:'))).toMatch(/deletion ledger replay failed for 1 record/);
        expect((await w.state()).active).toBe(true);
        await w.settle();
        expect(w.gate.isFrozen()).toBe(true);
        expect(await itemsLeft()).toEqual([kept]);

        // Once the record is dealt with, the rollback replays again and opens writes.
        entries.splice(entries.indexOf(bad), 1);
        const retried = await rollbackUpgrade(failed.id, w.deps);
        expect(retried.run?.status, JSON.stringify(retried.run?.failures)).toBe('rolled-back');
        expect((await w.state()).active).toBe(false);
        await w.settle();
        expect(w.gate.isFrozen()).toBe(false);
        expect(await itemsLeft()).toEqual([kept]);
      } finally {
        await w.done();
      }
    },
    300_000,
  );

  it('the drain waits for writes in flight and for write transactions outside the gate', async () => {
    const w = await world('SELECT 1;');
    const other = postgres(w.deps.databaseUrl, { max: 1, onnotice: () => {} });
    try {
      const control = w.deps.maintenance as MaintenanceControl;
      const held = w.gate.enter()!;
      const epoch = await control.enter({ upgradeId: 'drain-test', fromVersion: '1.0.0', toVersion: '1.1.0' });
      await w.settle();
      expect(w.gate.enter()).toBeNull();
      const first = await control.drain(epoch, 200);
      expect(first.ok).toBe(false);
      expect(first.waitingFor.join()).toMatch(/has 1 write\(s\) in flight/);
      held();

      // A session that bypasses the gate and holds a write transaction open.
      let commit: () => void = () => {};
      const tx = other.begin(async (t) => {
        await t`UPDATE upgrade_probe_data SET note = 'outside the gate' WHERE id = 1`;
        await new Promise<void>((r) => {
          commit = r;
        });
      });
      await sleep(50);
      const second = await control.drain(epoch, 200);
      expect(second.ok).toBe(false);
      expect(second.waitingFor.join()).toMatch(/open write transaction/);
      commit();
      await tx;
      expect(await control.drain(epoch, 2_000)).toEqual({ ok: true, waitingFor: [] });

      await expect(control.enter({ upgradeId: 'someone-else', fromVersion: '1.0.0', toVersion: '1.1.0' })).rejects.toThrow(/already on for upgrade drain-test/);
      await control.exit('drain-test');
      await w.settle();
      expect(w.gate.isFrozen()).toBe(false);
    } finally {
      await other.end({ timeout: 5 });
      await w.done();
    }
  }, 60_000);

  it('the maintenance control keeps working after a backup or restore terminated its session', async () => {
    const w = await world('SELECT 1;');
    const control = w.deps.maintenance as MaintenanceControl;
    const terminate = async () => {
      await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${w.prod} AND application_name = 'heopress-upgrade'`;
    };
    try {
      await control.state();
      await terminate();
      const epoch = await control.enter({ upgradeId: 'terminated', fromVersion: '1.0.0', toVersion: '1.1.0' });
      await terminate();
      await control.step('migrate');
      await terminate();
      expect(await control.state()).toEqual({ active: true, upgradeId: 'terminated' });
      await terminate();
      await w.settle();
      expect(await control.drain(epoch, 5_000)).toEqual({ ok: true, waitingFor: [] });
      await terminate();
      await control.exit('terminated');
      expect((await w.state()).active).toBe(false);
    } finally {
      await w.done();
    }
  }, 60_000);
});
