/**
 * Version compatibility check of `heopress upgrade` (HeoPress P13 task 2.1; spec ops/upgrades "安全升级流程"). Pure: the
 * caller gathers the facts, this decides. Any problem stops the upgrade before it touches production.
 */
import { compareVersions, parseVersion } from '@heopress/contracts/extensions';
import { manifestSupportsVersion } from '@heopress/contracts/schemas';

/** Oldest PostgreSQL major HeoPress runs on (P03, ADR-0002). */
const MIN_POSTGRES_MAJOR = 18;

export interface CompatibilityFacts {
  /** The release serving now. */
  currentVersion: string;
  /** The release this command installs (its own version). */
  targetVersion: string;
  /** `server_version_num` of the production database. */
  postgresVersionNum: number;
  /** Migrations applied to production, oldest first (`hash` is the SHA-256 of the file as applied). */
  applied: Array<{ hash: string; createdAt: number }>;
  /** The target release's migrations, oldest first. */
  bundled: Array<{ tag: string; hash: string; when: number }>;
  /** The installed plugins and the HeoPress range each manifest declares. */
  plugins: Array<{ siteId: string | null; name: string; enabled: boolean; manifest: { heopress?: string; compatibleWith?: string } }>;
  /** Whether a backup provider is available (the upgrade never runs without its backups). */
  backupProvider: boolean;
}

export interface CompatibilityReport {
  ok: boolean;
  /** Nothing to do: same version and no pending migration. */
  upToDate: boolean;
  problems: string[];
  /** Pending migration tags, in order. */
  pending: string[];
}

export function checkCompatibility(f: CompatibilityFacts): CompatibilityReport {
  const problems: string[] = [];
  const current = parseVersion(f.currentVersion);
  const target = parseVersion(f.targetVersion);
  if (!current) problems.push(`current version "${f.currentVersion}" is not a release version`);
  if (!target) problems.push(`target version "${f.targetVersion}" is not a release version`);
  if (current && target) {
    const order = compareVersions(target, current);
    if (order < 0) problems.push(`target ${f.targetVersion} is older than the running ${f.currentVersion}: downgrades are not supported (restore a backup instead)`);
    if (target.major - current.major > 1) {
      problems.push(`${f.currentVersion} → ${f.targetVersion} skips a major release: upgrade to the latest ${current.major + 1}.x first`);
    }
  }
  const pgMajor = Math.floor(f.postgresVersionNum / 10000);
  if (pgMajor < MIN_POSTGRES_MAJOR) problems.push(`PostgreSQL ${pgMajor} is not supported: HeoPress needs ${MIN_POSTGRES_MAJOR} or newer`);

  // The applied history must be a prefix of the target's: same files, same order. A database ahead of the target, or
  // one migrated with a different history (e.g. before a squash), is refused.
  const pending: string[] = [];
  if (f.applied.length > f.bundled.length) {
    problems.push(`the database has ${f.applied.length} migrations applied but ${f.targetVersion} ships ${f.bundled.length}: it was migrated by a newer release`);
  } else {
    for (let i = 0; i < f.applied.length; i++) {
      const a = f.applied[i]!;
      const b = f.bundled[i]!;
      if (a.hash !== b.hash || a.createdAt !== b.when) {
        problems.push(`migration history differs from ${f.targetVersion} at #${i + 1} (${b.tag}): the database was migrated with another history`);
        break;
      }
    }
    for (const m of f.bundled.slice(f.applied.length)) pending.push(m.tag);
  }

  for (const p of f.plugins) {
    if (!manifestSupportsVersion(p.manifest, f.targetVersion)) {
      const where = p.siteId ? `site ${p.siteId}` : 'instance';
      problems.push(
        `plugin ${p.name} (${where}${p.enabled ? '' : ', disabled'}) declares HeoPress ${p.manifest.heopress ?? p.manifest.compatibleWith}, which excludes ${f.targetVersion}: upgrade or remove it first (plugin authors: \`heopress-ext codemod\`)`,
      );
    }
  }

  if (!f.backupProvider) problems.push('no backup provider is configured: the upgrade needs a backup before, and a final one during, maintenance');

  const upToDate = problems.length === 0 && current !== null && target !== null && compareVersions(target, current) === 0 && pending.length === 0;
  return { ok: problems.length === 0, upToDate, problems, pending };
}
