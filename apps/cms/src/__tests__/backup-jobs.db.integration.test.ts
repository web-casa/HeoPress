import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { backupDrills, backups, notifications, publicHosts, siteExports, users, type Database } from '@heopress/database';
import { LocalFileStorageProvider } from '@heopress/runtime/docker';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { __resetSetupCompleteCache } from '../middleware/setup-required';
import { runRestoreDrill, type DrillReport } from '../services/backup/drill';
import { pgToolsAvailable } from '../services/backup/pg-tools';
import { renderSmoke } from '../services/backup/render-smoke';
import { createBackupWorker } from '../services/backup/worker';
import { runSiteTransaction } from '../services/rls-transaction';
import { listSiteExports, processSiteExports, requestSiteExport, siteExportDir } from '../services/site-export/export-jobs';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Backups and single-site exports as the instance runs them (HeoPress P13 tasks 1.1–1.3, 1.6): the Studio routes —
 * who may see and ask for what, backups not configured or misconfigured — the worker taking up what was asked for and
 * its scheduled runs, and the export worker writing a site's bundle, or failing for someone who does not administer it.
 */

const JWT_SECRET = 'fake-short';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const BIN = process.env.HEOPRESS_TEST_PG_BIN_DIR?.trim() || (existsSync('/usr/lib/postgresql/18/bin') ? '/usr/lib/postgresql/18/bin' : null);
const toolsRequired = process.env.HEOPRESS_TEST_BACKUP_TOOLS === 'required';
const toolsPresent = hasDbIntegrationUrl ? await pgToolsAvailable(['pg_dump', 'pg_restore'], BIN) : false;
// Without the programs the worker part is skipped — unless CI requires them, where their absence fails it.
const withTools = toolsPresent || toolsRequired;

const BACKUP_ENV = ['HEOPRESS_BACKUP_TARGET', 'HEOPRESS_BACKUP_DATABASE_URL', 'HEOPRESS_BACKUP_METHOD', 'HEOPRESS_PG_BIN_DIR'] as const;

describe.skipIf(!hasDbIntegrationUrl)('backup and export jobs — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let root = '';
  let env: Record<string, unknown> = {};
  let previousBootstrap: string | null = null;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('backup-jobs');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
    fx = await createCrossSiteFixture(db, { prefix: 'p13jobs', jwtSecret: JWT_SECRET });
    root = await mkdtemp(path.join(tmpdir().length > 60 ? '/tmp' : tmpdir(), 'hpjb-'));
    for (const k of BACKUP_ENV) saved[k] = process.env[k];
    for (const k of BACKUP_ENV) delete process.env[k];
    await db.delete(backupDrills);
    await db.delete(backups);
  }, 60_000);

  afterAll(async () => {
    for (const k of BACKUP_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (db) {
      await db.delete(backupDrills);
      await db.delete(backups);
      if (fx) {
        await db.update(users).set({ isBootstrap: false }).where(eq(users.id, fx.users.adminA.id));
        if (previousBootstrap) await db.update(users).set({ isBootstrap: true }).where(eq(users.id, previousBootstrap));
        __resetSetupCompleteCache();
      }
    }
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const call = async (method: 'GET' | 'POST', route: string, who: 'adminA' | 'onlyA') => {
    const res = await app.request(`/api/v1/studio${route}`, { method, headers: { ...fx.headers('a', await fx.session(who, 'a')), 'x-heopress-client': 'studio' } }, env);
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> & { backups?: unknown[] }; errors?: Array<{ code: string; message: string }> } };
  };

  it('backups are for the instance administrator; exports for the site administrator', async () => {
    expect((await call('GET', '/backups', 'onlyA')).status).toBe(403);
    const notInstance = await call('GET', '/backups', 'adminA');
    expect(notInstance.status).toBe(403);
    expect(notInstance.body.errors?.[0]?.message).toMatch(/instance administrator/);
    expect((await call('POST', '/backups', 'adminA')).status).toBe(403);
    expect((await call('POST', '/backups/drills', 'adminA')).status).toBe(403);
    expect((await call('GET', '/site-exports', 'onlyA')).status).toBe(403);
    expect((await call('POST', '/site-exports', 'onlyA')).status).toBe(403);
  });

  it('the instance administrator sees backups unconfigured, misconfigured and configured, and asks for a backup and a drill', async () => {
    // adminA becomes the instance (bootstrap) administrator for this test.
    const [boot] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
    previousBootstrap = boot && boot.id !== fx.users.adminA.id ? boot.id : null;
    if (previousBootstrap) await db.update(users).set({ isBootstrap: false }).where(eq(users.id, previousBootstrap));
    await db.update(users).set({ isBootstrap: true }).where(eq(users.id, fx.users.adminA.id));
    __resetSetupCompleteCache();

    const off = await call('GET', '/backups', 'adminA');
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ configured: false, backups: [], drills: [] });
    expect((await call('POST', '/backups', 'adminA')).body.errors?.[0]?.code).toBe('BACKUPS_NOT_CONFIGURED');
    expect((await call('POST', '/backups/drills', 'adminA')).status).toBe(409);

    process.env.HEOPRESS_BACKUP_TARGET = 'relative/dir';
    const bad = await call('GET', '/backups', 'adminA');
    expect(bad.body.data).toMatchObject({ configured: false, configError: expect.stringMatching(/absolute path/) });

    process.env.HEOPRESS_BACKUP_TARGET = `local:${path.join(root, 'target')}`;
    process.env.HEOPRESS_BACKUP_DATABASE_URL = OWNER_URL ?? process.env.DATABASE_URL!;
    process.env.HEOPRESS_BACKUP_METHOD = 'dump';
    const on = await call('GET', '/backups', 'adminA');
    expect(on.body.data).toMatchObject({ configured: true, method: 'dump', encrypted: false, retention: { daily: 14, weekly: 8 }, target: `local:${path.join(root, 'target')}` });
    const asked = await call('POST', '/backups', 'adminA');
    expect(asked.status).toBe(202);
    expect(asked.body.data).toMatchObject({ status: 'queued', trigger: 'manual', requestedBy: fx.users.adminA.id });
    expect((await call('POST', '/backups/drills', 'adminA')).body.data).toMatchObject({ status: 'queued', requestedBy: fx.users.adminA.id });
    expect((await call('GET', '/backups', 'adminA')).body.data?.backups).toHaveLength(1);
  });

  describe.skipIf(!withTools)('the backup worker (PostgreSQL 18 programs)', () => {
    it('takes up what was asked for, then runs its scheduled backup and drill', async () => {
      const storage = new LocalFileStorageProvider(path.join(root, 'media'));
      await storage.put('sites/site_p13jobs_a/media/a.txt', Buffer.from('a'), { contentType: 'text/plain' });
      const runtime = createRuntime(env);
      const worker = createBackupWorker({
        db,
        env: {
          HEOPRESS_BACKUP_TARGET: `local:${path.join(root, 'target')}`,
          HEOPRESS_BACKUP_DATABASE_URL: OWNER_URL ?? process.env.DATABASE_URL!,
          HEOPRESS_BACKUP_METHOD: 'dump',
          HEOPRESS_DELETION_LEDGER_DIR: path.join(root, 'ledger'),
          ...(BIN ? { HEOPRESS_PG_BIN_DIR: BIN } : {}),
        },
        storage,
        keys: runtime.keys,
        app: { version: 'test', gitSha: 'test' },
        productionDatabaseUrl: process.env.DATABASE_URL!,
      });
      expect(worker.config.method).toBe('dump');
      const reportOf = (row: { report: unknown }) => row.report as DrillReport;
      const drillWith = (over: Partial<Parameters<typeof runRestoreDrill>[0]>, backupId?: string) =>
        runRestoreDrill({ db, config: worker.config, productionDatabaseUrl: process.env.DATABASE_URL!, ...over }, { trigger: 'manual', ...(backupId ? { backupId } : {}) });

      // Nothing has succeeded yet: the drill fails at once, and the instance administrator is told in their site.
      const none = await drillWith({});
      expect(none.status).toBe('failed');
      expect(reportOf(none).failures).toEqual([{ check: 'manifest', message: 'There is no successful backup to restore.' }]);
      const told = await runSiteTransaction(db, fx.sites.a, (tx) => tx.select().from(notifications).where(eq(notifications.recipient, fx.users.adminA.id)));
      expect(told.some((n) => /Restore drill failed for backup \(none\)/.test(n.subject))).toBe(true);
      await db.delete(backupDrills).where(eq(backupDrills.id, none.id));

      // The queued backup first, then the queued drill on it.
      expect(await worker.tick()).toEqual({ backups: 1, drills: 1 });
      const [asked] = await db.select().from(backups).where(eq(backups.trigger, 'manual'));
      expect(asked).toMatchObject({ status: 'succeeded', requestedBy: fx.users.adminA.id });
      const [drilled] = await db.select().from(backupDrills);
      expect(drilled).toMatchObject({ status: 'passed', trigger: 'manual', backupId: asked!.id });
      expect(await worker.tick()).toEqual({ backups: 0, drills: 0 });

      const scheduled = await worker.scheduled('auto');
      expect(scheduled.backup).toMatchObject({ status: 'succeeded', trigger: 'schedule', kind: 'full' });
      // Retention after it: one backup per day is kept, so the earlier one of today goes.
      expect(scheduled.prune).toMatchObject({ removed: [asked!.id] });
      const weekly = await worker.drill();
      expect(weekly).toMatchObject({ status: 'passed', trigger: 'schedule', backupId: scheduled.backup.id });

      // An unknown backup; an unreadable deletion ledger; a smoke test that throws, or finds a page failing.
      expect(reportOf(await drillWith({}, 'bk_missing')).failures[0]).toMatchObject({ check: 'manifest' });
      const unreadable = await drillWith({
        ledgerSink: {
          name: 'broken',
          append: async () => undefined,
          readAll: async () => {
            throw new Error('ledger offline');
          },
        },
        smoke: async () => {
          throw new Error('renderer down');
        },
      });
      expect(unreadable.status).toBe('failed');
      expect(reportOf(unreadable).failures).toEqual(
        expect.arrayContaining([
          { check: 'ledger_replay', message: 'The deletion ledger could not be read: ledger offline' },
          { check: 'render_smoke', message: 'renderer down' },
        ]),
      );
      const broken = await drillWith({ smoke: async () => ({ ok: false, pages: [{ host: 'a.example.com', path: '/', status: 500 }] }) });
      expect(reportOf(broken).failures).toEqual([{ check: 'render_smoke', message: 'Pages failed to render: a.example.com/ 500' }]);
      expect(reportOf(broken).checks).toContainEqual({ name: 'render_smoke', status: 'failed', detail: '1 page(s)' });
    }, 300_000);
  });

  it('the rendering smoke test asks a public site home page; no public site is nothing to render', async () => {
    const host = '0-p13jobs-smoke.example.com';
    await db.insert(publicHosts).values({ hostname: host, siteId: fx.sites.a, isPrimary: true });
    try {
      const smoke = await renderSmoke(db, 1);
      expect(smoke.pages[0]).toMatchObject({ host, path: '/' });
      expect(smoke.ok).toBe(smoke.pages.every((p) => (p.path === '/' ? p.status < 400 : p.status < 500)));
    } finally {
      await db.delete(publicHosts).where(eq(publicHosts.hostname, host));
    }
    expect(await renderSmoke(db, 0)).toEqual({ ok: true, pages: [], note: 'The backup has no public site to render.' });
  });

  it('the export worker writes the bundle the site administrator asked for; it fails for anyone else', async () => {
    const asked = await call('POST', '/site-exports', 'adminA');
    expect(asked.status).toBe(202);
    const outsider = await requestSiteExport(db, fx.sites.a, fx.users.onlyA.id);
    const runtime = createRuntime(env);
    const exportDir = siteExportDir({ HEOPRESS_SITE_EXPORT_DIR: path.join(root, 'exports') });
    expect(siteExportDir({})).toBe(path.resolve('./data/exports'));
    expect(await processSiteExports({ db, keys: runtime.keys, defaultStorage: runtime.storage, exportDir })).toBeGreaterThanOrEqual(2);
    const rows = await listSiteExports(db, fx.sites.a);
    const mine = rows.find((r) => r.id === (asked.body.data as { id: string }).id)!;
    expect(mine).toMatchObject({ status: 'succeeded', location: path.join(exportDir, fx.sites.a, mine.id) });
    expect(existsSync(path.join(mine.location!, 'bundle.ndjson'))).toBe(true);
    expect(rows.find((r) => r.id === outsider.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/administrator/i) });
    const listed = await call('GET', '/site-exports', 'adminA');
    expect((listed.body.data as unknown as Array<{ id: string }>).map((r) => r.id)).toEqual(expect.arrayContaining([mine.id, outsider.id]));
    // Nothing is left to take up.
    expect(await processSiteExports({ db, keys: runtime.keys, defaultStorage: runtime.storage, exportDir })).toBe(0);
    await db.delete(siteExports).where(eq(siteExports.siteId, fx.sites.a));
  }, 120_000);
});
