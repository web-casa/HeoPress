/** `heopress upgrade` command line (HeoPress P13 task 2.1): status, usage and refusals that need no database. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUpgradeCli } from '../../../scripts/upgrade-cli';
import { UpgradeJournal } from '../../services/upgrade/journal';

let dir: string;
let out: string[];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'heopress-upgrade-cli-'));
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('heopress upgrade (CLI)', () => {
  it('prints the latest run, and how to retry one stuck in maintenance', async () => {
    const env = { HEOPRESS_UPGRADE_DIR: dir };
    expect(await runUpgradeCli(['status'], env)).toBe(0);
    expect(out).toEqual(['no upgrade has run yet']);
    new UpgradeJournal(dir).save({
      id: '01900000-0000-7000-8000-000000000001',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      status: 'failed-in-maintenance',
      startedAt: '2026-10-29T00:00:00.000Z',
      steps: [
        { name: 'migrate', status: 'failed', startedAt: 'a', finishedAt: 'b', detail: 'column "x" contains null values' },
        { name: 'restore-database', status: 'failed', startedAt: 'a', finishedAt: 'b', detail: 'backup storage unreachable' },
      ],
      backups: {},
      changed: { database: true, app: false, config: false },
      failures: [],
    });
    out = [];
    expect(await runUpgradeCli(['status'], env)).toBe(0);
    expect(out.join('\n')).toMatch(/1\.0\.0 → 1\.1\.0 — failed-in-maintenance\n {2}✖ migrate: column "x" contains null values\n {2}✖ restore-database: backup storage unreachable\n {2}Maintenance stays on/);
    expect(out.join('\n')).toContain('heopress upgrade rollback --id 01900000-0000-7000-8000-000000000001');
    expect(await runUpgradeCli(['status', '--id', 'missing'], env)).toBe(1);
  });

  it('refuses unknown commands and a missing owner connection', async () => {
    expect(await runUpgradeCli(['explode'], { HEOPRESS_UPGRADE_DIR: dir })).toBe(1);
    expect(await runUpgradeCli(['run'], { HEOPRESS_UPGRADE_DIR: dir })).toBe(1);
    expect(out.join('\n')).toMatch(/DATABASE_OWNER_URL .* is required/);
  });
});
