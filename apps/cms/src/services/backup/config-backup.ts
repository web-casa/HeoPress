import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isCredentialKey } from '@heopress/contracts/schemas';

/**
 * The configuration part of a backup (HeoPress P13 task 1.1; spec ops/backup-restore "一致备份与隔离恢复").
 *
 * `config/instance.json` records the instance's settings — the `HEOPRESS_*` values that are not secrets — and the
 * *names* of the secrets that were set (never their values, nor a hash of them): a restore knows what must be handed
 * over separately (the encryption key, `JWT_SECRET`, `ENCRYPTION_KEY`, database passwords), and the operator keeps
 * them in a separate, safe place. Configuration files (`HEOPRESS_BACKUP_CONFIG_FILES`: the env file, the Caddyfile)
 * may hold secrets, so they are only included in an encrypted backup.
 */

const SECRET_NAMES = /(^|_)(SECRET|PASSWORD|PASSWD|TOKEN|KEY|KEYS|CREDENTIALS?|PRIVATE|DSN|COOKIE|SALT|PEPPER)(_|$)/i;
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
/** Names that hold secrets or point at databases, whatever their prefix. */
const ALWAYS_SECRET = new Set(['DATABASE_URL', 'DATABASE_OWNER_URL', 'JWT_SECRET', 'ENCRYPTION_KEY']);

/** Whether an environment variable's value must not be written to a backup. */
export function isSecretSetting(name: string, value: string): boolean {
  return ALWAYS_SECRET.has(name) || SECRET_NAMES.test(name) || isCredentialKey(name) || URL_WITH_PASSWORD.test(value) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) || /(^|[?&])password=/i.test(value);
}

export interface InstanceConfigSnapshot {
  settings: Record<string, string>;
  secretsSet: string[];
  files: string[];
  filesSkipped: string[];
}

/** The instance configuration to record, and the configuration files to include (read when encrypted). */
export async function instanceConfig(env: Record<string, string | undefined>, configFiles: string[], encrypted: boolean): Promise<{ snapshot: InstanceConfigSnapshot; files: Array<{ name: string; bytes: Buffer }> }> {
  const settings: Record<string, string> = {};
  const secretsSet: string[] = [];
  for (const [name, value] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (value === undefined || value === '') continue;
    const relevant = name.startsWith('HEOPRESS_') || ALWAYS_SECRET.has(name) || ['NODE_ENV', 'PORT', 'FILE_UPLOAD_VIDEO_MAX_BYTES'].includes(name);
    if (!relevant) continue;
    if (isSecretSetting(name, value)) secretsSet.push(name);
    else settings[name] = value;
  }
  const files: Array<{ name: string; bytes: Buffer }> = [];
  const filesSkipped: string[] = [];
  for (const [i, f] of configFiles.entries()) {
    if (!encrypted) {
      filesSkipped.push(f);
      continue;
    }
    files.push({ name: `${String(i + 1).padStart(2, '0')}-${path.basename(f).replace(/[^A-Za-z0-9._-]/g, '_') || 'file'}`, bytes: await readFile(f) });
  }
  return { snapshot: { settings, secretsSet, files: files.map((f) => f.name), filesSkipped }, files };
}
