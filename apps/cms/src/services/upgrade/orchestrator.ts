/**
 * `heopress upgrade` (HeoPress P13 tasks 2.1, 2.3; spec ops/upgrades "安全升级流程", "升级写入冻结与数据不丢失").
 *
 *   compatibility → config snapshot → backup → rehearsal (migrations on a restored copy) → maintenance (freeze, drain)
 *   → final backup → migrate production → switch the application → smoke test → writes open
 *
 * - Anything failing up to and including the rehearsal leaves production as it was: no maintenance, no change.
 * - Once maintenance is on, a failure restores what changed — configuration, then database and media from the final
 *   backup, then the previous application — and verifies all three (configuration files identical to the snapshot,
 *   migration history back to its length before, the backup's own checks, the previous version answering). Only a
 *   verified restore turns maintenance off; otherwise maintenance stays on, writes stay refused, and the report lists
 *   the failed steps (`failed-in-maintenance`; `rollback` retries the restore).
 * - The final backup is taken with every writer frozen and drained, so changes confirmed before maintenance — also
 *   during the rehearsal — survive a restore.
 * - Once writes open on the new release, a restore would discard what was written since: `rollback` refuses it.
 */
import { v7 as uuidv7 } from 'uuid';
import { checkCompatibility, type CompatibilityFacts } from './compat';
import type { UpgradeJournal, UpgradeRun } from './journal';
import type {
  AppReleasePort,
  ConfigPort,
  MaintenanceControlPort,
  MigrationPort,
  RehearsalDatabasePort,
  SmokePort,
  UpgradeBackupProvider,
} from './ports';

export interface UpgradeDeps {
  journal: UpgradeJournal;
  backup: UpgradeBackupProvider | null;
  app: AppReleasePort;
  config: ConfigPort;
  migrations: MigrationPort;
  rehearsal: RehearsalDatabasePort;
  smoke: SmokePort;
  maintenance: MaintenanceControlPort;
  listPlugins: () => Promise<CompatibilityFacts['plugins']>;
  /** Owner URL of production. */
  databaseUrl: string;
  /** This release. */
  targetVersion: string;
  /** How long the drain may take before the upgrade gives up (production unchanged). Default 120 s. */
  drainTimeoutMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

class StepFailed extends Error {}

/** One line for the report: a driver error's cause (the database's message) rather than the wrapped query. */
function describeError(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
  const text = cause ? cause.message : err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 1000);
}

export async function runUpgrade(deps: UpgradeDeps): Promise<UpgradeRun> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const fromVersion = (await deps.app.current()).version;
  const run: UpgradeRun = {
    id: uuidv7(),
    fromVersion,
    toVersion: deps.targetVersion,
    status: 'running',
    startedAt: now().toISOString(),
    steps: [],
    backups: {},
    changed: { database: false, app: false, config: false },
    failures: [],
  };
  deps.journal.save(run);

  const step = stepRunner(run, deps);
  const finish = (status: UpgradeRun['status']): UpgradeRun => {
    run.status = status;
    run.finishedAt = now().toISOString();
    deps.journal.save(run);
    return run;
  };

  // ── Before maintenance: any failure leaves production as it was. ────────────────────────────────────────────
  let backup: UpgradeBackupProvider;
  try {
    const report = await step('compatibility', async () => {
      const status = await deps.migrations.status(deps.databaseUrl);
      const r = checkCompatibility({
        currentVersion: fromVersion,
        targetVersion: deps.targetVersion,
        postgresVersionNum: status.postgresVersionNum,
        applied: status.applied,
        bundled: status.bundled,
        plugins: await deps.listPlugins(),
        backupProvider: deps.backup !== null,
      });
      run.appliedBefore = status.applied.length;
      if (!r.ok) throw new Error(r.problems.join('; '));
      if ((await deps.maintenance.state()).active) throw new Error('maintenance is already on (another upgrade, or one that failed): see `heopress upgrade status`');
      return r;
    });
    if (report.upToDate) {
      log(`already on ${deps.targetVersion} with no pending migration`);
      return finish('up-to-date');
    }
    backup = deps.backup!;
    run.config = await step('config-snapshot', () => deps.config.snapshot(run.id));
    run.backups.preUpgrade = await step('backup', () => backup.takeBackup({ purpose: 'pre-upgrade', upgradeId: run.id }));
    await step('rehearsal', async () => {
      const copy = await deps.rehearsal.create(run.id);
      try {
        await backup.restoreCopy(run.backups.preUpgrade!, { databaseUrl: copy.databaseUrl });
        await deps.migrations.apply(copy.databaseUrl);
      } finally {
        await copy.drop().catch((err: unknown) => log(`! could not drop the rehearsal database: ${describeError(err)}`));
      }
    });
  } catch (err) {
    if (!(err instanceof StepFailed)) run.failures.push(describeError(err));
    return finish('aborted');
  }

  // ── Maintenance: from here a failure restores and verifies before writes open again. ────────────────────────
  // The current step shown to the processes and Studio is informational: failing to record it is no reason to stop.
  const progress = (name: string): Promise<void> =>
    deps.maintenance.step(name).catch((err: unknown) => log(`! could not record the step ${name}: ${describeError(err)}`));
  let epoch: number;
  try {
    epoch = await step('maintenance', () => deps.maintenance.enter({ upgradeId: run.id, fromVersion, toVersion: deps.targetVersion }));
  } catch {
    return finish('aborted');
  }
  try {
    await step('drain', async () => {
      const drained = await deps.maintenance.drain(epoch, deps.drainTimeoutMs ?? 120_000);
      if (!drained.ok) throw new Error(`writers did not drain in time: ${drained.waitingFor.join('; ')}`);
    });
    await progress('final-backup');
    run.backups.final = await step('final-backup', () => backup.takeBackup({ purpose: 'final', upgradeId: run.id }));
    await progress('migrate');
    await step('migrate', async () => {
      run.changed.database = true;
      deps.journal.save(run);
      await deps.migrations.apply(deps.databaseUrl);
    });
    await progress('activate');
    await step('activate', async () => {
      run.changed.app = true;
      run.changed.config = true;
      deps.journal.save(run);
      await deps.app.activate({ version: deps.targetVersion });
    });
    await progress('smoke');
    await step('smoke', async () => {
      const r = await deps.smoke.run(deps.targetVersion);
      if (!r.ok) throw new Error(r.failures.join('; '));
    });
    await step('open-writes', () => deps.maintenance.exit(run.id));
    run.writesOpenedAt = now().toISOString();
    return finish('completed');
  } catch (err) {
    // Every failure is in the report: a step records its own, anything else is recorded here.
    if (!(err instanceof StepFailed)) run.failures.push(describeError(err));
    log('restoring the previous release');
    return finish(await restore(run, deps, step));
  }
}

type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** Runs one step: journals it, and on failure records it in the report and throws `StepFailed`. */
function stepRunner(run: UpgradeRun, deps: Pick<UpgradeDeps, 'journal' | 'log' | 'now'>): Step {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  return async (name, fn) => {
    const startedAt = now().toISOString();
    log(`→ ${name}`);
    try {
      const out = await fn();
      run.steps.push({ name, status: 'ok', startedAt, finishedAt: now().toISOString() });
      deps.journal.save(run);
      return out;
    } catch (err) {
      const detail = describeError(err);
      run.steps.push({ name, status: 'failed', startedAt, finishedAt: now().toISOString(), detail });
      run.failures.push(`${name}: ${detail}`);
      deps.journal.save(run);
      log(`✖ ${name}: ${detail}`);
      throw new StepFailed(detail);
    }
  };
}

/**
 * Restore what the run changed, verify, and open writes only when everything verified. Every restore step is
 * attempted even when an earlier one failed; the report lists each failure.
 */
async function restore(run: UpgradeRun, deps: UpgradeDeps, step: Step): Promise<'aborted' | 'rolled-back' | 'failed-in-maintenance'> {
  const backup = deps.backup;
  const attempt = async (name: string, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await step(name, fn);
      return true;
    } catch {
      return false;
    }
  };
  await deps.maintenance.step('restore').catch(() => {});
  let ok = true;
  if (run.changed.config) {
    ok = (await attempt('restore-config', async () => {
      if (!run.config) throw new Error('no configuration snapshot');
      await deps.config.restore(run.config);
    })) && ok;
  }
  if (run.changed.database) {
    ok = (await attempt('restore-database', async () => {
      if (!backup || !run.backups.final) throw new Error('no final backup');
      await backup.restoreProduction(run.backups.final);
    })) && ok;
  }
  if (run.changed.app) {
    ok = (await attempt('restore-app', () => deps.app.activate({ version: run.fromVersion }))) && ok;
  }
  ok = (await attempt('verify-restore', async () => {
    const problems: string[] = [];
    if (run.config) for (const f of await deps.config.differences(run.config)) problems.push(`configuration file ${f} differs from the snapshot`);
    const status = await deps.migrations.status(deps.databaseUrl);
    if (run.appliedBefore !== undefined && status.applied.length !== run.appliedBefore) {
      problems.push(`database has ${status.applied.length} migrations applied, expected ${run.appliedBefore}`);
    }
    if (run.changed.database && backup && run.backups.final) {
      const v = await backup.verifyProduction(run.backups.final);
      if (!v.ok) problems.push(...v.problems.map((p) => `database: ${p}`));
    }
    const running = await deps.app.running();
    if (running !== run.fromVersion) problems.push(`application reports ${running ?? 'nothing'}, expected ${run.fromVersion}`);
    if (problems.length > 0) throw new Error(problems.join('; '));
  })) && ok;
  if (!ok) return 'failed-in-maintenance';
  if (!(await attempt('open-writes', () => deps.maintenance.exit(run.id)))) return 'failed-in-maintenance';
  // Nothing had changed (e.g. the drain timed out): production is as it was.
  return run.changed.database || run.changed.app || run.changed.config ? 'rolled-back' : 'aborted';
}

/**
 * `heopress upgrade rollback`: retry the restore of a run that failed in maintenance. Refused once writes opened on the
 * new release (restoring would discard what was written since: make a data-retention plan first) and for runs that
 * changed nothing.
 */
export async function rollbackUpgrade(
  id: string,
  deps: Omit<UpgradeDeps, 'targetVersion'>,
): Promise<{ refused?: string; run?: UpgradeRun }> {
  const run = deps.journal.load(id);
  if (!run) return { refused: `no upgrade ${id} in the journal` };
  if (run.status === 'completed' || run.writesOpenedAt) {
    return {
      refused:
        `upgrade ${id} completed and writes have been open on ${run.toVersion} since ${run.writesOpenedAt ?? run.finishedAt}: ` +
        'restoring its backup would discard everything written since. Fix forward, or make a data-retention plan ' +
        '(export what changed since, restore manually, re-apply) as described in the upgrade runbook.',
    };
  }
  if (run.status !== 'failed-in-maintenance') return { refused: `upgrade ${id} is ${run.status}: there is nothing to roll back` };
  const now = deps.now ?? (() => new Date());
  const step = stepRunner(run, deps);
  run.status = await restore(run, { ...deps, targetVersion: run.toVersion }, step);
  run.finishedAt = now().toISOString();
  deps.journal.save(run);
  return { run };
}
