/**
 * Configuration snapshot for `heopress upgrade` (HeoPress P13 tasks 2.1, 2.3): copies of the deployment's
 * configuration files (the Compose `.env` with the pinned version, a Compose override, the Caddyfile, …) kept under
 * the upgrade directory, owner-only, with each file's SHA-256. A restore puts every file back exactly (and removes one
 * that did not exist before); `differences` is the verification. File contents are never printed.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ConfigPort, ConfigSnapshot } from '../ports';

function sha256(file: string): string | null {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
}

export class ConfigFiles implements ConfigPort {
  /**
   * @param files absolute paths of the configuration files
   * @param storeDir where the copies go (`<storeDir>/<upgradeId>/config/<n>`)
   */
  constructor(
    private readonly files: string[],
    private readonly storeDir: string,
  ) {}

  private copyOf(upgradeId: string, index: number): string {
    return path.join(this.storeDir, upgradeId, 'config', String(index));
  }

  async snapshot(upgradeId: string): Promise<ConfigSnapshot> {
    const out: ConfigSnapshot = { upgradeId, files: [] };
    mkdirSync(path.join(this.storeDir, upgradeId, 'config'), { recursive: true, mode: 0o700 });
    this.files.forEach((file, i) => {
      const hash = sha256(file);
      if (hash !== null) {
        const copy = this.copyOf(upgradeId, i);
        copyFileSync(file, copy);
        chmodSync(copy, 0o600);
        if (sha256(copy) !== hash) throw new Error(`copy of ${file} does not match it`);
      }
      out.files.push({ path: file, sha256: hash });
    });
    return out;
  }

  async restore(snapshot: ConfigSnapshot): Promise<void> {
    snapshot.files.forEach((f, i) => {
      if (f.sha256 === null) {
        rmSync(f.path, { force: true });
        return;
      }
      const copy = this.copyOf(snapshot.upgradeId, i);
      if (sha256(copy) !== f.sha256) throw new Error(`the saved copy of ${f.path} is missing or changed`);
      // Keep the file's mode (an env file stays 0600); write next to it and rename, so a crash leaves old or new.
      const mode = existsSync(f.path) ? statSync(f.path).mode & 0o777 : 0o600;
      const tmp = `${f.path}.heopress-upgrade.tmp`;
      copyFileSync(copy, tmp);
      chmodSync(tmp, mode);
      renameSync(tmp, f.path);
    });
  }

  async differences(snapshot: ConfigSnapshot): Promise<string[]> {
    return snapshot.files.filter((f) => sha256(f.path) !== f.sha256).map((f) => f.path);
  }
}
