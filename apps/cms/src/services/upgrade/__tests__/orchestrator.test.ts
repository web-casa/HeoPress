/**
 * `heopress upgrade` orchestration against in-memory doubles (HeoPress P13 tasks 2.1, 2.3; spec ops/upgrades). The
 * database-backed run is `upgrade.db.integration.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpgradeJournal } from '../journal';
import { rollbackUpgrade, runUpgrade, type UpgradeDeps } from '../orchestrator';
import { registerUpgradeBackupProvider, upgradeBackupProvider, type ConfigSnapshot, type UpgradeBackupProvider, type UpgradeBackupRef } from '../ports';

interface World {
  /** The production "database": migrations applied and data. */
  db: { migrations: number; data: string };
  config: string;
  pinned: string;
  running: string;
  maintenance: { active: boolean; upgradeId: string | null; epoch: number };
  backups: Map<string, { migrations: number; data: string }>;
  calls: string[];
}

function setup(over: {
  rehearsalFails?: boolean;
  migrateFails?: boolean;
  smokeFails?: boolean;
  restoreFails?: boolean;
  drainFails?: boolean;
  noBackup?: boolean;
  current?: string;
} = {}) {
  const w: World = {
    db: { migrations: 2, data: 'v1' },
    config: 'HEOPRESS_VERSION=1.0.0',
    pinned: over.current ?? '1.0.0',
    running: over.current ?? '1.0.0',
    maintenance: { active: false, upgradeId: null, epoch: 0 },
    backups: new Map(),
    calls: [],
  };
  const flags = { ...over };
  let n = 0;
  const backup: UpgradeBackupProvider = {
    name: 'memory',
    async takeBackup({ purpose }) {
      w.calls.push(`backup:${purpose}`);
      const id = `b${++n}`;
      w.backups.set(id, { ...w.db });
      return { id, takenAt: new Date().toISOString() };
    },
    async restoreCopy(ref) {
      w.calls.push(`restore-copy:${ref.id}`);
    },
    async restoreProduction(ref: UpgradeBackupRef) {
      w.calls.push(`restore-production:${ref.id}`);
      if (flags.restoreFails) throw new Error('backup store unreachable');
      w.db = { ...w.backups.get(ref.id)! };
    },
    async verifyProduction(ref) {
      const b = w.backups.get(ref.id)!;
      const ok = b.data === w.db.data && b.migrations === w.db.migrations;
      return { ok, problems: ok ? [] : ['rows differ'] };
    },
  };
  const deps: UpgradeDeps = {
    journal: new UpgradeJournal(dir),
    backup: over.noBackup ? null : backup,
    app: {
      current: async () => ({ version: w.pinned }),
      activate: async ({ version }) => {
        w.calls.push(`activate:${version}`);
        w.pinned = version;
        w.config = `HEOPRESS_VERSION=${version}`;
        w.running = version;
      },
      running: async () => w.running,
    },
    config: {
      snapshot: async (upgradeId): Promise<ConfigSnapshot> => ({ upgradeId, files: [{ path: '.env', sha256: w.config }] }),
      restore: async (s) => {
        w.calls.push('restore-config');
        w.config = s.files[0]!.sha256!;
      },
      differences: async (s) => (s.files[0]!.sha256 === w.config ? [] : ['.env']),
    },
    migrations: {
      status: async () => ({
        applied: Array.from({ length: w.db.migrations }, (_, i) => ({ hash: `h${i}`, createdAt: i })),
        bundled: Array.from({ length: 3 }, (_, i) => ({ tag: `m${i}`, hash: `h${i}`, when: i })),
        postgresVersionNum: 180000,
      }),
      apply: async (url) => {
        if (url === 'copy') {
          w.calls.push('migrate:copy');
          if (flags.rehearsalFails) throw new Error('relation "x" does not exist');
          return;
        }
        w.calls.push('migrate:production');
        w.db.migrations = 3;
        w.db.data = 'v2';
        if (flags.migrateFails) throw new Error('column "y" contains null values');
      },
    },
    rehearsal: { create: async () => ({ databaseUrl: 'copy', drop: async () => void w.calls.push('drop-copy') }) },
    smoke: { run: async () => (flags.smokeFails ? { ok: false, failures: ['/health/ready answered 503'] } : { ok: true, failures: [] }) },
    maintenance: {
      enter: async ({ upgradeId }) => {
        w.calls.push('maintenance:on');
        w.maintenance = { active: true, upgradeId, epoch: w.maintenance.epoch + 1 };
        return w.maintenance.epoch;
      },
      step: async () => {},
      drain: async () => (flags.drainFails ? { ok: false, waitingFor: ['process p1 (worker) has 1 write(s) in flight'] } : { ok: true, waitingFor: [] }),
      exit: async (id) => {
        if (w.maintenance.upgradeId === id) {
          w.calls.push('maintenance:off');
          w.maintenance = { active: false, upgradeId: id, epoch: w.maintenance.epoch + 1 };
        }
      },
      state: async () => ({ active: w.maintenance.active, upgradeId: w.maintenance.upgradeId }),
    },
    listPlugins: async () => [],
    databaseUrl: 'production',
    targetVersion: '1.1.0',
  };
  return { w, deps, flags };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'heopress-upgrade-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('heopress upgrade — orchestration', () => {
  it('runs every step in order and opens writes on the new release', async () => {
    const { w, deps } = setup();
    const run = await runUpgrade(deps);
    expect(run.status).toBe('completed');
    expect(w.calls).toEqual([
      'backup:pre-upgrade',
      'restore-copy:b1',
      'migrate:copy',
      'drop-copy',
      'maintenance:on',
      'backup:final',
      'migrate:production',
      'activate:1.1.0',
      'maintenance:off',
    ]);
    expect(run.steps.map((s) => s.name)).toEqual(['compatibility', 'config-snapshot', 'backup', 'rehearsal', 'maintenance', 'drain', 'final-backup', 'migrate', 'activate', 'smoke', 'open-writes']);
    expect(run.writesOpenedAt).toBeDefined();
    expect(new UpgradeJournal(dir).load(run.id)?.status).toBe('completed');
  });

  it('a rehearsal failure never enters maintenance and leaves production unchanged', async () => {
    const { w, deps } = setup({ rehearsalFails: true });
    const run = await runUpgrade(deps);
    expect(run.status).toBe('aborted');
    expect(w.calls).not.toContain('maintenance:on');
    expect(w.calls).not.toContain('backup:final');
    expect(w.calls).toContain('drop-copy');
    expect(w.db).toEqual({ migrations: 2, data: 'v1' });
    expect(run.failures[0]).toMatch(/^rehearsal: relation "x" does not exist/);
  });

  it('a failed compatibility check takes no backup', async () => {
    const { w, deps } = setup({ current: '2.0.0' });
    const run = await runUpgrade(deps);
    expect(run.status).toBe('aborted');
    expect(w.calls).toEqual([]);
    expect(run.failures[0]).toMatch(/downgrades are not supported/);
    const none = setup({ noBackup: true });
    expect((await runUpgrade(none.deps)).failures[0]).toMatch(/no backup provider/);
  });

  it('a migration failing on production restores configuration, database and application, verifies, then opens writes', async () => {
    const { w, deps } = setup({ migrateFails: true });
    const run = await runUpgrade(deps);
    expect(run.status).toBe('rolled-back');
    expect(w.db).toEqual({ migrations: 2, data: 'v1' });
    expect(w.calls.slice(w.calls.indexOf('migrate:production'))).toEqual(['migrate:production', 'restore-production:b2', 'maintenance:off']);
    expect(w.maintenance.active).toBe(false);
    expect(run.failures).toEqual(['migrate: column "y" contains null values']);
    expect(run.steps.filter((s) => s.name.startsWith('restore') || s.name === 'verify-restore').map((s) => `${s.name}:${s.status}`)).toEqual([
      'restore-database:ok',
      'verify-restore:ok',
    ]);
  });

  it('a failed smoke test after the switch restores the previous application and configuration', async () => {
    const { w, deps } = setup({ smokeFails: true });
    const run = await runUpgrade(deps);
    expect(run.status).toBe('rolled-back');
    expect(w.calls.slice(w.calls.indexOf('activate:1.1.0'))).toEqual(['activate:1.1.0', 'restore-config', 'restore-production:b2', 'activate:1.0.0', 'maintenance:off']);
    expect({ pinned: w.pinned, running: w.running, config: w.config, db: w.db }).toEqual({
      pinned: '1.0.0',
      running: '1.0.0',
      config: 'HEOPRESS_VERSION=1.0.0',
      db: { migrations: 2, data: 'v1' },
    });
  });

  it('a restore that fails keeps maintenance on, reports both failures, and rollback retries it', async () => {
    const { w, deps, flags } = setup({ migrateFails: true, restoreFails: true });
    const run = await runUpgrade(deps);
    expect(run.status).toBe('failed-in-maintenance');
    expect(w.maintenance.active).toBe(true);
    expect(run.failures.map((f) => f.split(':')[0])).toEqual(['migrate', 'restore-database', 'verify-restore']);
    expect(w.calls).not.toContain('maintenance:off');

    flags.restoreFails = false;
    const retried = await rollbackUpgrade(run.id, deps);
    expect(retried.refused).toBeUndefined();
    expect(retried.run?.status).toBe('rolled-back');
    expect(w.maintenance.active).toBe(false);
    expect(w.db).toEqual({ migrations: 2, data: 'v1' });
  });

  it('a drain that times out turns maintenance off again without any change', async () => {
    const { w, deps } = setup({ drainFails: true });
    const run = await runUpgrade(deps);
    expect(run.status).toBe('aborted');
    expect(w.calls).not.toContain('backup:final');
    expect(w.calls).not.toContain('migrate:production');
    expect(w.maintenance.active).toBe(false);
    expect(run.failures[0]).toMatch(/writers did not drain in time: process p1/);
  });

  it('refuses to roll back once writes opened on the new release', async () => {
    const { w, deps } = setup();
    const run = await runUpgrade(deps);
    w.db.data = 'written after the upgrade';
    const out = await rollbackUpgrade(run.id, deps);
    expect(out.refused).toMatch(/writes have been open on 1\.1\.0 since .*data-retention plan/);
    expect(w.db.data).toBe('written after the upgrade');
    expect(w.calls.filter((c) => c.startsWith('restore'))).toEqual(['restore-copy:b1']);
    expect((await rollbackUpgrade('nope', deps)).refused).toMatch(/no upgrade nope/);
  });

  it('refuses to start while maintenance is already on', async () => {
    const { w, deps } = setup();
    w.maintenance = { active: true, upgradeId: 'other', epoch: 3 };
    const run = await runUpgrade(deps);
    expect(run.status).toBe('aborted');
    expect(run.failures[0]).toMatch(/maintenance is already on/);
    expect(w.calls).toEqual([]);
  });

  it('uses the backup provider the backup module registers, until it unregisters', () => {
    const { deps } = setup();
    expect(upgradeBackupProvider()).toBeNull();
    const unregister = registerUpgradeBackupProvider(deps.backup!);
    expect(upgradeBackupProvider()?.name).toBe('memory');
    unregister();
    expect(upgradeBackupProvider()).toBeNull();
  });

  // Regression (public CI run of 4b2eae86, reproduced locally 3 times in 26 runs): the final backup terminated every
  // session of the database, the upgrade's own included; the next statement, recording the step `migrate`, failed
  // with 57P01 outside any step, and the run ended `aborted` with no failure in its report.
  it('a lost session while recording the current step neither stops the upgrade nor goes unreported', async () => {
    const { w, deps } = setup();
    const lost = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    deps.maintenance.step = async () => {
      throw lost;
    };
    const run = await runUpgrade(deps);
    expect(run.status).toBe('completed');
    expect(w.calls).toContain('migrate:production');
  });

  it('an error outside any step after maintenance is still in the report', async () => {
    const { w, deps } = setup();
    deps.log = (line) => {
      if (line === '→ migrate') throw new Error('log sink closed');
    };
    const run = await runUpgrade(deps);
    expect(run.status).toBe('aborted');
    expect(run.failures).toEqual(['log sink closed']);
    expect(w.maintenance.active).toBe(false);
    expect(w.calls).not.toContain('migrate:production');
  });
});
