/**
 * The application release of a Docker Compose deployment (HeoPress P13 tasks 2.1, 2.3): the release is the
 * `HEOPRESS_VERSION` pinned in the Compose env file (the image tag of `docker/docker-compose.prod.yml`). Activating a
 * release rewrites that one line and runs `docker compose up -d --wait` for the HeoPress services; the running release
 * is what `/api/v1/system/version` answers. Commands run without a shell, with fixed arguments.
 */
import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { AppRelease, AppReleasePort } from '../ports';

export type CommandRunner = (file: string, args: string[]) => Promise<void>;

const PIN = /^HEOPRESS_VERSION=(.*)$/m;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args.slice(0, 2).join(' ')} failed: ${String(stderr).trim().split('\n').slice(-3).join(' | ') || err.message}`));
      else resolve();
    });
  });

export interface ComposeAppOptions {
  /** The Compose env file holding `HEOPRESS_VERSION=<version>`. */
  envFile: string;
  /** Arguments before `up`, e.g. `['-f', 'docker/docker-compose.yml', '-f', 'docker/docker-compose.prod.yml']`. */
  composeArgs: string[];
  /** The HeoPress services to restart (default `cms`, `worker`, `site`). */
  services?: string[];
  /** `/api/v1/system/version` of the running CMS. */
  versionUrl: string;
  run?: CommandRunner;
  fetch?: typeof fetch;
}

export class ComposeAppRelease implements AppReleasePort {
  private readonly run: CommandRunner;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: ComposeAppOptions) {
    this.run = options.run ?? runCommand;
    this.fetchFn = options.fetch ?? fetch;
  }

  async current(): Promise<AppRelease> {
    const m = PIN.exec(readFileSync(this.options.envFile, 'utf8'));
    const version = m?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (!version || !VERSION.test(version)) {
      throw new Error(`pin the running release in ${this.options.envFile} (HEOPRESS_VERSION=<x.y.z>) before upgrading`);
    }
    return { version };
  }

  async activate(release: AppRelease): Promise<void> {
    if (!VERSION.test(release.version)) throw new Error(`invalid version ${JSON.stringify(release.version)}`);
    const file = this.options.envFile;
    const text = readFileSync(file, 'utf8');
    const line = `HEOPRESS_VERSION=${release.version}`;
    const next = PIN.test(text) ? text.replace(PIN, line) : `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}${line}\n`;
    if (next !== text) {
      const tmp = `${file}.heopress-upgrade.tmp`;
      writeFileSync(tmp, next, { mode: 0o600 });
      chmodSync(tmp, statSync(file).mode & 0o777);
      renameSync(tmp, file);
    }
    const services = this.options.services ?? ['cms', 'worker', 'site'];
    await this.run('docker', ['compose', ...this.options.composeArgs, 'up', '-d', '--wait', ...services]);
  }

  async running(): Promise<string | null> {
    try {
      const res = await this.fetchFn(this.options.versionUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      return typeof body.version === 'string' ? body.version : null;
    } catch {
      return null;
    }
  }
}
