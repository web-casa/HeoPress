import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { backupDrills, backups, collections, deletionLedger, items, notifications, sites, systemEvents, users, type Database } from '@heopress/database';
import { LocalFileStorageProvider } from '@heopress/runtime/docker';
import { loadManifest, runBackup, type BackupDeps } from '../services/backup/backup-service';
import type { BackupConfig } from '../services/backup/config';
import { rowCounts } from '../services/backup/database-backup';
import { runRestoreDrill, type DrillReport } from '../services/backup/drill';
import { instanceMediaSource } from '../services/backup/media-backup';
import { backupDir, blobPath } from '../services/backup/manifest';
import { pgToolsAvailable } from '../services/backup/pg-tools';
import { materializeDatabase, resolveChain, restoreDump, restoreMedia, RestoreError } from '../services/backup/restore';
import { replayLedgerAfterRestore } from '../services/backup/ledger-replay';
import { withDatabase } from '../services/backup/pg-tools';
import { ErasureService } from '../services/erasure-service';
import { fileLedgerSink } from '../services/retention/deletion-ledger';
import { createCrossSiteFixture } from './helpers/cross-site-fixture';
import { registerBackupsPruner } from '../services/backup/retention';
import { runBackupPruners } from '../services/retention/backup-pruner';
import { LocalDirTarget } from '../services/backup/target';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Backups and the restore drill against a real PostgreSQL 18 (HeoPress P13 tasks 1.1, 1.3, 1.5; spec
 * ops/backup-restore): a dump and a base backup chain (encrypted, incremental) each restored by the drill into a
 * temporary database or server and checked; the key held apart; a missing base fails; pruning keeps chains; media
 * changed during a backup stays recoverable; a tampered object fails the drill and is reported; the drill reaches no
 * network and changes nothing in production; the drill and a restore replay the deletion ledger (P13 task 5.2), and a
 * record that cannot be deleted again fails the drill and keeps a restore's writes closed.
 *
 * Needs the PostgreSQL 18 programs (`HEOPRESS_TEST_PG_BIN_DIR`, default `/usr/lib/postgresql/18/bin`), the owner URL
 * (`DATABASE_OWNER_URL`, a role with REPLICATION) and a server with `summarize_wal = on`. CI sets
 * `HEOPRESS_TEST_BACKUP_TOOLS=required`: missing tools fail the suite instead of skipping it.
 */

const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const BIN = process.env.HEOPRESS_TEST_PG_BIN_DIR?.trim() || (existsSync('/usr/lib/postgresql/18/bin') ? '/usr/lib/postgresql/18/bin' : null);
const TOOLS = ['pg_dump', 'pg_restore', 'pg_basebackup', 'pg_combinebackup', 'pg_verifybackup', 'pg_ctl'];
const toolsRequired = process.env.HEOPRESS_TEST_BACKUP_TOOLS === 'required';
const toolsPresent = hasDbIntegrationUrl ? await pgToolsAvailable(TOOLS, BIN) : false;
// Without the programs the suite is skipped — unless CI requires them, where their absence fails it.
const withTools = toolsPresent || toolsRequired;

const SITE = 'site_p13_backup_it';
const PNG = (n: number) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, n)]);

describe.skipIf(!hasDbIntegrationUrl)('backups and the restore drill — DB integration', () => {
  describe.skipIf(!withTools)('with the PostgreSQL 18 programs', () => {
    let db: Database;
    let owner: postgres.Sql;
    let root = '';
    let target: LocalDirTarget;
    let media: LocalFileStorageProvider;
    let keyFile = '';
    let bootstrapId = '';
    let createdBootstrap = false;
    const made: Record<string, string> = {};

    const config = (over: Partial<BackupConfig> = {}): BackupConfig => ({
      target,
      databaseUrl: OWNER_URL!,
      method: 'dump',
      keyFile: null,
      configFiles: [],
      drillDatabaseUrl: null,
      pgBinDir: BIN,
      maxChain: 48,
      schedule: { enabled: false, full: '0 0 0 * * *', incremental: '0 0 * * * *', drill: '0 0 0 * * 0' },
      retention: { daily: 14, weekly: 8 },
      ...over,
    });
    const deps = (over: Partial<BackupConfig> = {}, extra: Partial<BackupDeps> = {}): BackupDeps => ({
      db,
      config: config(over),
      mediaSources: [instanceMediaSource(media)],
      env: { HEOPRESS_PUBLIC_URL: 'https://admin.example.com', JWT_SECRET: 'fake-short' },
      app: { version: 'test', gitSha: 'test' },
      ...extra,
    });
    const drill = (over: Partial<BackupConfig> = {}, req: { backupId?: string } = {}, smoke?: (d: Database) => Promise<{ ok: boolean; pages: [] }>) =>
      runRestoreDrill({ db, config: config(over), productionDatabaseUrl: process.env.DATABASE_URL!, ...(smoke ? { smoke } : {}) }, { trigger: 'manual', ...req });
    const reportOf = (row: { report: unknown }) => row.report as DrillReport;
    const productionCounts = async () => {
      const counts = await owner.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', (tx) => rowCounts(tx));
      for (const k of ['public.lumibase_backup_drills', 'public.lumibase_backups', 'public.lumibase_schedule_runs']) delete counts[k];
      return counts;
    };

    beforeAll(async () => {
      expect(toolsPresent, `the PostgreSQL 18 programs (${TOOLS.join(', ')}) are required (HEOPRESS_TEST_PG_BIN_DIR)`).toBe(true);
      expect(OWNER_URL, 'DATABASE_OWNER_URL is required to take backups').toBeDefined();
      db = await connectDbIntegration('backup-restore');
      owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
      root = await mkdtemp(path.join(tmpdir().length > 60 ? '/tmp' : tmpdir(), 'hpbt-'));
      target = new LocalDirTarget(path.join(root, 'target'));
      media = new LocalFileStorageProvider(path.join(root, 'media'));
      await mkdir(path.join(root, 'keys'), { mode: 0o700 });
      keyFile = path.join(root, 'keys', 'backup.key');
      await writeFile(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
      await db.delete(backupDrills);
      await db.delete(backups);
      const [boot] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
      if (boot) bootstrapId = boot.id;
      else {
        bootstrapId = 'usr_p13_backup_bootstrap';
        await db.insert(users).values({ id: bootstrapId, email: 'bootstrap-backup@example.com', status: 'active', isBootstrap: true });
        createdBootstrap = true;
      }
      // A site of the instance, where the administrator's notifications go.
      await db.delete(sites).where(eq(sites.id, SITE));
      await db.insert(sites).values({ id: SITE, name: 'Backup drill', createdAt: new Date('2000-01-01T00:00:00Z') });
      await media.put('sites/site_backup_a/media/a.png', PNG(1), { contentType: 'image/png' });
      await media.put('sites/site_backup_a/media/b.png', PNG(2), { contentType: 'image/png' });
    }, 60_000);

    afterAll(async () => {
      if (db) {
        await db.delete(backupDrills);
        await db.delete(backups);
        await db.delete(sites).where(eq(sites.id, SITE));
        if (createdBootstrap) await db.delete(users).where(eq(users.id, bootstrapId));
      }
      await owner?.end({ timeout: 2 });
      if (root) await rm(root, { recursive: true, force: true });
    });

    it('dump: a full backup with an exact manifest; its drill passes in a temporary database and changes nothing in production', async () => {
      const row = await runBackup(deps(), { kind: 'full', trigger: 'manual' });
      expect(row.error ?? '').not.toMatch(/^[A-Z_]+:/);
      expect(row.status).toBe('succeeded');
      made.dump = row.id;
      const m = await loadManifest(target, row.id);
      expect(m.database.rowCountsExact).toBe(true);
      expect(m.objects.map((o) => o.path)).toEqual(['config/instance.json', 'database/dump.pgc']);
      expect(m.media.entries.map((e) => e.key).sort()).toEqual(['sites/site_backup_a/media/a.png', 'sites/site_backup_a/media/b.png']);
      const config = (await readFile(path.join(root, 'target', backupDir(row.id), 'config/instance.json'), 'utf8')) as string;
      expect(config).toContain('JWT_SECRET');
      expect(config).not.toContain('fake-short');

      const before = await productionCounts();
      const result = await drill();
      const report = reportOf(result);
      expect(report.failures).toEqual([]);
      expect(result.status).toBe('passed');
      expect(report.checks.map((c) => [c.name, c.status])).toEqual(
        expect.arrayContaining([
          ['manifest', 'passed'],
          ['media', 'passed'],
          ['objects', 'passed'],
          ['database', 'passed'],
          ['row_counts', 'passed'],
          ['render_smoke', 'passed'],
          ['isolation', 'passed'],
        ]),
      );
      expect(report.restoredInto).toMatch(/^temporary database /);
      expect(report.networkAttempts).toEqual([]);
      expect(await owner`SELECT datname FROM pg_database WHERE datname LIKE 'heopress_drill_%'`).toHaveLength(0);
      expect(await productionCounts()).toEqual(before);
    }, 300_000);

    it('spec "演练无生产网络": an outbound request during the drill is refused and fails it', async () => {
      const result = await drill({}, { backupId: made.dump }, async () => {
        await fetch('https://drill-probe.example.com/ping');
        return { ok: true, pages: [] };
      });
      expect(result.status).toBe('failed');
      expect(reportOf(result).networkAttempts).toEqual(['drill-probe.example.com']);
      expect(reportOf(result).failures.map((f) => f.check)).toEqual(expect.arrayContaining(['isolation', 'render_smoke']));
    }, 300_000);

    it('spec "备份中媒体变更可恢复": an object rewritten or removed during the backup is kept as read, or carried over', async () => {
      const changed = PNG(9);
      const row = await runBackup(
        deps(
          {},
          {
            beforeMediaRead: async (o) => {
              if (o.key.endsWith('/a.png')) await media.put(o.key, changed, { contentType: 'image/png' });
              if (o.key.endsWith('/b.png')) await media.delete(o.key);
            },
          },
        ),
        { kind: 'full', trigger: 'manual' },
      );
      expect(row.status).toBe('succeeded');
      made.mediaChanged = row.id;
      const m = await loadManifest(target, row.id);
      const restoredTo = new LocalFileStorageProvider(path.join(root, 'restored-media'));
      const restored = await restoreMedia(target, m, null, () => restoredTo);
      expect(restored.failures).toEqual([]);
      const body = async (k: string) => Buffer.from(await new Response((await restoredTo.get(k))!.body as BodyInit).arrayBuffer());
      expect((await body('sites/site_backup_a/media/a.png')).equals(changed)).toBe(true);
      expect((await body('sites/site_backup_a/media/b.png')).equals(PNG(2))).toBe(true);
      expect(m.media.entries.find((e) => e.key.endsWith('/b.png'))?.carried).toBe(true);
      await media.put('sites/site_backup_a/media/b.png', PNG(2), { contentType: 'image/png' });
    }, 300_000);

    it('spec "演练失败": a media object that does not match its hash fails the drill, is listed, and the administrator is told', async () => {
      const m = await loadManifest(target, made.mediaChanged!);
      const a = m.media.entries.find((e) => e.key.endsWith('/a.png'))!;
      await writeFile(path.join(root, 'target', ...blobPath(a.blob).split('/')), PNG(3));
      const result = await drill({}, { backupId: made.mediaChanged });
      expect(result.status).toBe('failed');
      expect(reportOf(result).failures).toContainEqual(expect.objectContaining({ check: 'media', object: 'default/sites/site_backup_a/media/a.png' }));
      const told = await db.select().from(notifications).where(and(eq(notifications.recipient, bootstrapId), like(notifications.subject, 'Restore drill failed%')));
      expect(told.length).toBeGreaterThan(0);
      const events = await db.select().from(systemEvents).where(eq(systemEvents.event, 'backup_drill_failed'));
      expect(events.some((e) => e.level === 'error' && (e.data as { drillId?: string }).drillId === result.id)).toBe(true);
    }, 300_000);

    it('base backup: an encrypted full and incremental chain; the drill combines, verifies, starts a private server and renders', async () => {
      const over = { method: 'basebackup' as const, keyFile };
      const full = await runBackup(deps(over), { kind: 'full', trigger: 'manual' });
      expect(full.error ?? '').not.toMatch(/^[A-Z_]+:/);
      expect(full.status).toBe('succeeded');
      const inc = await runBackup(deps(over), { kind: 'incremental', trigger: 'manual' });
      expect(inc.error ?? '', 'incrementals need summarize_wal = on and a REPLICATION role').not.toMatch(/^[A-Z_]+:/);
      expect(inc).toMatchObject({ status: 'succeeded', kind: 'incremental', parentId: full.id, baseId: full.id, encrypted: true });
      made.full = full.id;
      made.inc = inc.id;
      // Stored encrypted: no plaintext PostgreSQL manifest in the target.
      const raw = await readFile(path.join(root, 'target', backupDir(inc.id), 'database', 'backup_manifest'));
      expect(raw.subarray(0, 4).toString('latin1')).toBe('HPBK');

      const before = await productionCounts();
      const result = await drill(over);
      const report = reportOf(result);
      expect(report.failures).toEqual([]);
      expect(result.status).toBe('passed');
      expect(report.chain).toEqual([full.id, inc.id]);
      expect(report.restoredInto).toMatch(/private socket/);
      expect(await productionCounts()).toEqual(before);
    }, 600_000);

    it('spec "独立密钥恢复": an encrypted backup needs its key, given apart; another key is named as wrong', async () => {
      await expect(resolveChain(target, made.inc!, null)).rejects.toMatchObject({ code: 'KEY_REQUIRED' });
      await expect(resolveChain(target, made.inc!, randomBytes(32))).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
      const key = Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'hex');
      expect((await resolveChain(target, made.inc!, key)).map((m) => m.id)).toEqual([made.full, made.inc]);
      // A key file kept with the backups is refused.
      const beside = path.join(root, 'target', 'backup.key');
      await writeFile(beside, key.toString('hex'), { mode: 0o600 });
      const refused = await runBackup(deps({ method: 'basebackup', keyFile: beside }), { kind: 'full', trigger: 'manual' });
      expect(refused.status).toBe('failed');
      expect(refused.error).toMatch(/^KEY_BESIDE_BACKUPS:/);
      await rm(beside);
    }, 300_000);

    it('spec "清理不删依赖": the data-retention job prunes through the registered pruner — the latest and every backup its chain needs stay, unreferenced media go', async () => {
      const day = 86_400_000;
      // The full and the dumps are days old; the incremental is today's: one day kept → the incremental and its full.
      await db.update(backups).set({ startedAt: new Date(Date.now() - 3 * day) }).where(eq(backups.id, made.full!));
      for (const id of [made.dump!, made.mediaChanged!]) await db.update(backups).set({ startedAt: new Date(Date.now() - 2 * day) }).where(eq(backups.id, id));
      const blobsBefore = (await target.list('media/')).length;
      // As the daily data-retention job does it (P13 task 5.1): through the pruner registered at start.
      const unregister = registerBackupsPruner({ db, target, databaseUrl: OWNER_URL! });
      let run: Awaited<ReturnType<typeof runBackupPruners>>;
      try {
        run = await runBackupPruners({ daily: 1, weekly: 0 }, new Date());
      } finally {
        unregister();
      }
      expect(run.registered).toBe(true);
      expect(run.pruners.map((p) => [p.name, p.error])).toEqual([['backups', undefined]]);
      const result = run.pruners[0]!;
      expect(result.removed).toEqual(expect.arrayContaining([made.dump, made.mediaChanged]));
      expect(result.removed).not.toContain(made.full);
      expect(result.removed).not.toContain(made.inc);
      expect((await target.list('media/')).length).toBeLessThan(blobsBefore);
      expect(await target.list(`${backupDir(made.dump!)}/`)).toEqual([]);
      const key = Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'hex');
      expect((await resolveChain(target, made.inc!, key)).length).toBe(2);
      const rows = await db.select({ id: backups.id, status: backups.status }).from(backups);
      expect(rows.find((r) => r.id === made.dump)?.status).toBe('removed');
    }, 300_000);

    it('spec "缺基础链失败": without its full backup an incremental neither restores nor is extended', async () => {
      await target.remove(`${backupDir(made.full!)}/`);
      const key = Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'hex');
      const err = await resolveChain(target, made.inc!, key).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RestoreError);
      expect(err).toMatchObject({ code: 'BASE_CHAIN_MISSING' });
      const result = await drill({ method: 'basebackup', keyFile }, { backupId: made.inc });
      expect(result.status).toBe('failed');
      expect(reportOf(result).failures[0]!.message).toMatch(/cannot be restored/);
      const next = await runBackup(deps({ method: 'basebackup', keyFile }), { kind: 'incremental', trigger: 'manual' });
      expect(next.status).toBe('failed');
      expect(next.error).toMatch(/^INCREMENTAL_BASE_MISSING:/);
    }, 300_000);

    it('spec ops/data-retention "删除账本与恢复后重放": the drill and a restore replay the ledger before writes open', async () => {
      const fx = await createCrossSiteFixture(db, { prefix: 'p13bk', jwtSecret: 'fake-short' });
      const siteId = fx.sites.a;
      const ledgerDir = path.join(root, 'ledger');
      const sink = fileLedgerSink(ledgerDir);
      const restoreAdmin = postgres(withDatabase(OWNER_URL!, 'postgres'), { max: 1, onnotice: () => {} });
      const restoredName = `heopress_restore_${randomBytes(5).toString('hex')}`;
      const restoredUrl = withDatabase(OWNER_URL!, restoredName);
      const work = await mkdtemp(path.join(root, 'restore-'));
      try {
        const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
        const [subject] = await db.insert(items).values({ siteId, collectionId: coll!.id, status: 'published', data: { title: 'Profile', email: 'jane@example.com' } }).returning({ id: items.id });
        const [kept] = await db.insert(items).values({ siteId, collectionId: coll!.id, status: 'published', data: { title: 'Kept' } }).returning({ id: items.id });
        const backup = await runBackup(deps(), { kind: 'full', trigger: 'manual' });
        expect(backup.status).toBe('succeeded');

        // After the backup: the subject's data is erased (ledger written outside the database, then the row deleted).
        const erase = new ErasureService({ db, siteId, userId: fx.users.adminA.id, storage: media, ledger: sink });
        const req = await erase.create({ collection: 'articles', filter: { email: 'jane@example.com' } }, 'gdpr');
        await erase.confirm(req!.id);
        expect((await erase.execute(req!.id))!.recordCount).toBe(1);
        expect(await db.select().from(items).where(eq(items.id, subject!.id))).toHaveLength(0);
        const ledgerFiles = async () => (await Promise.all((await readdir(ledgerDir)).sort().map((f) => readFile(path.join(ledgerDir, f), 'utf8')))).join('');
        const ledgerBefore = await ledgerFiles();

        // The weekly drill: the copy has the subject again; the replay deletes it again there, and only there.
        const passed = await runRestoreDrill({ db, config: config(), productionDatabaseUrl: process.env.DATABASE_URL!, ledgerSink: sink }, { trigger: 'manual', backupId: backup.id });
        const report = reportOf(passed);
        expect(report.failures).toEqual([]);
        expect(report.checks).toContainEqual(expect.objectContaining({ name: 'ledger_replay', status: 'passed' }));
        expect(report.ledger!.deletedAgain).toBeGreaterThanOrEqual(1);
        expect(report.ledger!.sources).toEqual(['file', 'database']);
        expect(await db.select().from(items).where(eq(items.id, kept!.id))).toHaveLength(1);
        expect(await ledgerFiles()).toBe(ledgerBefore);

        // A restore: the backup into a new database, then the replay before writes open.
        const chain = await resolveChain(target, backup.id, null);
        const materialized = await materializeDatabase(target, chain, null, work, BIN);
        expect(materialized.kind).toBe('dump');
        await restoreAdmin.unsafe(`CREATE DATABASE "${restoredName}"`);
        await restoreDump((materialized as { file: string }).file, restoredUrl, BIN);
        const restored = postgres(restoredUrl, { max: 1, onnotice: () => {} });
        try {
          const count = async (id: string) => Number((await restored<{ n: string }[]>`SELECT count(*)::text AS n FROM lumibase_items WHERE id = ${id}`)[0]!.n);
          expect(await count(subject!.id)).toBe(1);
          const ok = await replayLedgerAfterRestore({ databaseUrl: restoredUrl, storage: media, sink });
          expect(ok.writesMayOpen).toBe(true);
          expect(ok.report.records.filter((r) => r.siteId === siteId).map((r) => [r.objectId, r.outcome])).toEqual([[subject!.id, 'deleted_again']]);
          expect(await count(subject!.id)).toBe(0);
          expect(await count(kept!.id)).toBe(1);

          // A record that cannot be deleted again: the drill fails and names it; a restore keeps writes closed.
          await sink.append([{ id: `led_p13bk_${randomBytes(4).toString('hex')}`, siteId, requestId: 'req_p13bk', objectKind: 'item', objectScope: 'no_such_collection', objectId: kept!.id, action: 'hard_delete', erasedAt: new Date().toISOString() }]);
          const blocked = await replayLedgerAfterRestore({ databaseUrl: restoredUrl, storage: media, sink });
          expect(blocked.writesMayOpen).toBe(false);
          expect(blocked.report.failed).toBe(1);
          expect(await count(kept!.id)).toBe(1);
        } finally {
          await restored.end({ timeout: 2 });
        }
        const failed = await runRestoreDrill({ db, config: config(), productionDatabaseUrl: process.env.DATABASE_URL!, ledgerSink: sink }, { trigger: 'manual', backupId: backup.id });
        expect(failed.status).toBe('failed');
        expect(reportOf(failed).failures).toContainEqual(expect.objectContaining({ check: 'ledger_replay', object: `${siteId}/item/${kept!.id}` }));
        // Production is untouched by either drill.
        expect(await db.select().from(items).where(eq(items.id, kept!.id))).toHaveLength(1);
      } finally {
        await restoreAdmin.unsafe(`DROP DATABASE IF EXISTS "${restoredName}" WITH (FORCE)`).catch(() => undefined);
        await restoreAdmin.end({ timeout: 2 });
        for (const s of [fx.sites.a, fx.sites.b]) await db.delete(deletionLedger).where(eq(deletionLedger.siteId, s));
        await fx.teardown();
      }
    }, 300_000);
  });
});
