/**
 * What `heopress upgrade` needs from the rest of the system (HeoPress P13 tasks 2.1, 2.3). The orchestrator
 * (`orchestrator.ts`) only talks to these ports, so each one can be replaced by the deployment (and by test doubles).
 *
 * The backup port is the integration point with the backup and restore module (P13 tasks 1.x): the upgrade does not
 * back up or restore anything itself. Its implementation (`adapters/backup-module.ts`) is registered with
 * `registerUpgradeBackupProvider` by the command when a backup target is configured; until one is registered, the
 * upgrade refuses at the compatibility check and production is never touched.
 */

/** A backup the provider took, as the upgrade journal records it. */
export interface UpgradeBackupRef {
  id: string;
  /** ISO 8601. */
  takenAt: string;
  /** SHA-256 of the backup's manifest, when the provider has one. */
  manifestSha256?: string;
}

export interface UpgradeBackupProvider {
  /** Shown in the journal and the report, e.g. `local`, `s3`. */
  readonly name: string;
  /**
   * A full, consistent backup of the database, media and configuration. `pre-upgrade` is taken while the instance
   * still serves writes (it seeds the rehearsal copy); `final` is taken during maintenance, every writer frozen and
   * drained, so it holds every confirmed change.
   */
  takeBackup(request: { purpose: 'pre-upgrade' | 'final'; upgradeId: string }): Promise<UpgradeBackupRef>;
  /** Restore a backup's database into an empty scratch database (the rehearsal copy). Production is not touched. */
  restoreCopy(backup: UpgradeBackupRef, target: { databaseUrl: string }): Promise<void>;
  /** Restore production's database and media from a backup, in place. Only called during maintenance. */
  restoreProduction(backup: UpgradeBackupRef): Promise<void>;
  /** Check restored production against the backup's manifest (rows, object hashes). */
  verifyProduction(backup: UpgradeBackupRef): Promise<{ ok: boolean; problems: string[] }>;
}

let backupProvider: UpgradeBackupProvider | null = null;

/** Register the backup provider the upgrade uses (the backup module, at start). Returns the unregister function. */
export function registerUpgradeBackupProvider(provider: UpgradeBackupProvider): () => void {
  backupProvider = provider;
  return () => {
    if (backupProvider === provider) backupProvider = null;
  };
}

export function upgradeBackupProvider(): UpgradeBackupProvider | null {
  return backupProvider;
}

/** A deployable release of the application. */
export interface AppRelease {
  version: string;
}

/** Switches the running application between releases (Docker Compose: `adapters/compose-app.ts`). */
export interface AppReleasePort {
  /** The release the deployment is set to now. */
  current(): Promise<AppRelease>;
  /** Switch every HeoPress service to `release` and wait until it runs. */
  activate(release: AppRelease): Promise<void>;
  /** The version the running application reports, or null when it does not answer. */
  running(): Promise<string | null>;
}

export interface ConfigSnapshot {
  /** The upgrade the snapshot belongs to (its copies are kept under that id). */
  upgradeId: string;
  /** Per file: its path and the SHA-256 of its content, or null when it did not exist. */
  files: Array<{ path: string; sha256: string | null }>;
}

/** Snapshots and restores the deployment's configuration files (`adapters/config-files.ts`). */
export interface ConfigPort {
  snapshot(upgradeId: string): Promise<ConfigSnapshot>;
  restore(snapshot: ConfigSnapshot): Promise<void>;
  /** The files that differ from the snapshot (empty: identical). */
  differences(snapshot: ConfigSnapshot): Promise<string[]>;
}

export interface MigrationStatus {
  applied: Array<{ hash: string; createdAt: number }>;
  bundled: Array<{ tag: string; hash: string; when: number }>;
  postgresVersionNum: number;
}

/** Applies the target release's migrations (`migrations.ts`). */
export interface MigrationPort {
  status(databaseUrl: string): Promise<MigrationStatus>;
  apply(databaseUrl: string): Promise<void>;
}

/** A throwaway database for the rehearsal; `drop` removes it. */
export interface RehearsalDatabasePort {
  create(upgradeId: string): Promise<{ databaseUrl: string; drop(): Promise<void> }>;
}

/** Read-only checks of the upgraded application (`adapters/http-smoke.ts`). */
export interface SmokePort {
  run(expectedVersion: string): Promise<{ ok: boolean; failures: string[] }>;
}

/** The maintenance switch and the drain, as the table owner (`maintenance-control.ts`). */
export interface MaintenanceControlPort {
  /** Turn maintenance on for this upgrade; refused while another upgrade holds it. Returns the new epoch. */
  enter(info: { upgradeId: string; fromVersion: string; toVersion: string }): Promise<number>;
  step(step: string): Promise<void>;
  /** Wait until every live process acknowledged `epoch` frozen with nothing in flight and no write transaction is open. */
  drain(epoch: number, timeoutMs: number): Promise<{ ok: boolean; waitingFor: string[] }>;
  /** Turn maintenance off (writes open again). */
  exit(upgradeId: string): Promise<void>;
  /** Whether maintenance is on, and for which upgrade. */
  state(): Promise<{ active: boolean; upgradeId: string | null }>;
}
