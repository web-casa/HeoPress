/**
 * The upgrade journal (HeoPress P13 tasks 2.1, 2.3): one JSON file per run, written after every step, outside the
 * database — a database restore must not roll back the record of what the upgrade did. `heopress upgrade status`
 * reads it; `heopress upgrade rollback` decides from it whether a restore is still allowed.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ConfigSnapshot, UpgradeBackupRef } from './ports';

type UpgradeStatus =
  /** Running now. */
  | 'running'
  /** Nothing to do. */
  | 'up-to-date'
  /** Stopped before production changed; writes were never refused or are open again. */
  | 'aborted'
  /** Upgraded; writes open on the new release. */
  | 'completed'
  /** Failed during maintenance, restored to the previous release and verified; writes open again. */
  | 'rolled-back'
  /** Failed during maintenance and the restore did not verify: still in maintenance, writes refused. */
  | 'failed-in-maintenance';

interface UpgradeStepRecord {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string;
  detail?: string;
}

export interface UpgradeRun {
  id: string;
  fromVersion: string;
  toVersion: string;
  status: UpgradeStatus;
  startedAt: string;
  finishedAt?: string;
  steps: UpgradeStepRecord[];
  backups: { preUpgrade?: UpgradeBackupRef; final?: UpgradeBackupRef };
  config?: ConfigSnapshot;
  /** Migration history length before the upgrade: what a verified restore must show again. */
  appliedBefore?: number;
  /** What changed in production, so a restore knows what to undo. */
  changed: { database: boolean; app: boolean; config: boolean };
  /** When writes opened on the new release. From then on a restore would discard data and is refused. */
  writesOpenedAt?: string;
  /** Steps that failed, in order (the report). */
  failures: string[];
}

export class UpgradeJournal {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`invalid upgrade id ${JSON.stringify(id)}`);
    return path.join(this.dir, `${id}.json`);
  }

  save(run: UpgradeRun): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(run.id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
  }

  load(id: string): UpgradeRun | null {
    try {
      return JSON.parse(readFileSync(this.file(id), 'utf8')) as UpgradeRun;
    } catch {
      return null;
    }
  }

  /** The most recent run (ids sort by start time). */
  latest(): UpgradeRun | null {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return null;
    }
    const last = names.at(-1);
    return last ? this.load(last.slice(0, -5)) : null;
  }
}
