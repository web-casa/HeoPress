/** The deployment adapters of `heopress upgrade` (HeoPress P13 tasks 2.1, 2.3). */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@heopress/database';
import type { KeyProvider, StorageProvider } from '@heopress/runtime';
import { backupModuleProviderFromEnv, countDifferences } from '../adapters/backup-module';
import { ComposeAppRelease } from '../adapters/compose-app';
import { ConfigFiles } from '../adapters/config-files';
import { HttpSmoke } from '../adapters/http-smoke';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'heopress-upgrade-adapters-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('configuration snapshot', () => {
  it('restores every file exactly, keeps its mode, removes a file that did not exist, and reports differences', async () => {
    const env = path.join(dir, '.env');
    const caddy = path.join(dir, 'Caddyfile');
    const extra = path.join(dir, 'override.yml');
    writeFileSync(env, 'HEOPRESS_VERSION=1.0.0\nHEOPRESS_PUBLIC_URL=https://cms.example.com\n', { mode: 0o600 });
    writeFileSync(caddy, 'cms.example.com {\n}\n');
    const files = new ConfigFiles([env, caddy, extra], path.join(dir, 'store'));
    const snap = await files.snapshot('u1');
    expect(snap.files.map((f) => f.sha256 === null)).toEqual([false, false, true]);
    expect(statSync(path.join(dir, 'store', 'u1', 'config', '0')).mode & 0o777).toBe(0o600);
    expect(await files.differences(snap)).toEqual([]);

    writeFileSync(env, 'HEOPRESS_VERSION=1.1.0\nHEOPRESS_PUBLIC_URL=https://cms.example.com\n');
    rmSync(caddy);
    writeFileSync(extra, 'services: {}\n');
    expect(await files.differences(snap)).toEqual([env, caddy, extra]);
    await files.restore(snap);
    expect(await files.differences(snap)).toEqual([]);
    expect(readFileSync(env, 'utf8')).toBe('HEOPRESS_VERSION=1.0.0\nHEOPRESS_PUBLIC_URL=https://cms.example.com\n');
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(existsSync(extra)).toBe(false);
  });

  it('refuses to restore from a copy that changed', async () => {
    const env = path.join(dir, '.env');
    writeFileSync(env, 'A=1\n');
    const files = new ConfigFiles([env], path.join(dir, 'store'));
    const snap = await files.snapshot('u2');
    writeFileSync(path.join(dir, 'store', 'u2', 'config', '0'), 'A=2\n');
    await expect(files.restore(snap)).rejects.toThrow(/saved copy .* missing or changed/);
  });
});

describe('Docker Compose release', () => {
  it('reads the pinned version, rewrites only that line and restarts the services without a shell', async () => {
    const env = path.join(dir, 'compose.env');
    writeFileSync(env, 'HEOPRESS_DB_IMAGE=heopress-postgres:18\nHEOPRESS_VERSION="1.0.0"\nOTHER=x\n', { mode: 0o640 });
    const calls: Array<[string, string[]]> = [];
    const app = new ComposeAppRelease({
      envFile: env,
      composeArgs: ['-f', 'docker/docker-compose.yml'],
      versionUrl: 'http://127.0.0.1:1989/api/v1/system/version',
      run: async (file, args) => void calls.push([file, args]),
      fetch: (async () => new Response(JSON.stringify({ version: '1.1.0' }))) as typeof fetch,
    });
    expect(await app.current()).toEqual({ version: '1.0.0' });
    await app.activate({ version: '1.1.0' });
    expect(readFileSync(env, 'utf8')).toBe('HEOPRESS_DB_IMAGE=heopress-postgres:18\nHEOPRESS_VERSION=1.1.0\nOTHER=x\n');
    expect(statSync(env).mode & 0o777).toBe(0o640);
    expect(calls).toEqual([['docker', ['compose', '-f', 'docker/docker-compose.yml', 'up', '-d', '--wait', 'cms', 'cms-worker', 'site-classic']]]);
    expect(await app.running()).toBe('1.1.0');
    await expect(app.activate({ version: '1.1.0; rm -rf /' })).rejects.toThrow(/invalid version/);
  });

  it('asks for a pinned version before upgrading and reports an unreachable CMS as not running', async () => {
    const env = path.join(dir, 'compose.env');
    writeFileSync(env, 'OTHER=x\n');
    const app = new ComposeAppRelease({
      envFile: env,
      composeArgs: [],
      versionUrl: 'http://127.0.0.1:1/api/v1/system/version',
      run: async () => {},
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(app.current()).rejects.toThrow(/pin the running release/);
    await app.activate({ version: '1.0.0' });
    expect(readFileSync(env, 'utf8')).toBe('OTHER=x\nHEOPRESS_VERSION=1.0.0\n');
    expect(await app.running()).toBeNull();
  });
});

describe('HTTP smoke test', () => {
  it('needs readiness, the expected version and every page answering 200, using GET only', async () => {
    const seen: string[] = [];
    const answers: Record<string, () => Response> = {
      'http://cms.example.com/health/ready': () => new Response('{}', { status: 200 }),
      'http://cms.example.com/api/v1/system/version': () => new Response(JSON.stringify({ version: '1.1.0' })),
      'https://www.example.com/': () => new Response('ok', { status: 200 }),
      'https://www.example.com/gone/': () => new Response('', { status: 500 }),
    };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      return answers[url]!();
    }) as unknown as typeof fetch;
    const ok = await new HttpSmoke({ cmsUrl: 'http://cms.example.com/', urls: ['https://www.example.com/'], fetch: fetchFn }).run('1.1.0');
    expect(ok).toEqual({ ok: true, failures: [] });
    expect(seen.every((s) => s.startsWith('GET '))).toBe(true);
    const bad = await new HttpSmoke({ cmsUrl: 'http://cms.example.com', urls: ['https://www.example.com/gone/'], fetch: fetchFn }).run('1.2.0');
    expect(bad.failures).toEqual(['CMS reports version 1.1.0, expected 1.2.0', 'https://www.example.com/gone/ answered 500']);
  });

  it('waits for readiness after the switch, then gives up', async () => {
    let calls = 0;
    const fetchFn = (async (url: string) => {
      if (url.endsWith('/health/ready')) return new Response('', { status: ++calls < 3 ? 503 : 200 });
      return new Response(JSON.stringify({ version: '1.1.0' }));
    }) as unknown as typeof fetch;
    const r = await new HttpSmoke({ cmsUrl: 'http://cms.example.com', fetch: fetchFn, sleep: async () => {} }).run('1.1.0');
    expect(r.ok).toBe(true);
    const never = (async (url: string) => (url.endsWith('/health/ready') ? new Response('', { status: 503 }) : new Response('{}'))) as unknown as typeof fetch;
    const r2 = await new HttpSmoke({ cmsUrl: 'http://cms.example.com', fetch: never, readyTimeoutMs: 0 }).run('1.1.0');
    expect(r2.failures[0]).toBe('/health/ready answered 503');
  });
});

describe('backup module provider', () => {
  it('checks a restored database table by table against the manifest: exact counts only for a dump', () => {
    const manifest = (exact: boolean) => ({ database: { rowCounts: { 'public.a': 2, 'public.b': 0, 'drizzle.__drizzle_migrations': 120 }, rowCountsExact: exact } });
    const same = { 'public.a': 2, 'public.b': 0, 'drizzle.__drizzle_migrations': 120 };
    expect(countDifferences(manifest(true) as never, same)).toEqual([]);
    expect(countDifferences(manifest(true) as never, { 'public.a': 3, 'drizzle.__drizzle_migrations': 120, 'public.c': 1 })).toEqual([
      'public.a has 3 rows, the backup 2',
      'public.b is missing',
      'public.c is not in the backup',
    ]);
    // A base backup's counts are estimates: only missing and extra tables count.
    expect(countDifferences(manifest(false) as never, { ...same, 'public.a': 3 })).toEqual([]);
  });

  it('is configured as the backup worker is, from HEOPRESS_BACKUP_*, without touching the database or the target', () => {
    const storage = {} as StorageProvider;
    const provider = backupModuleProviderFromEnv({
      env: { HEOPRESS_BACKUP_TARGET: path.join(dir, 'backups'), DATABASE_OWNER_URL: 'postgres://owner:fake@db.example.com:5432/heopress' },
      db: {} as Database,
      storage,
      keys: {} as KeyProvider,
      app: { version: '1.0.0', gitSha: 'test' },
      productionDatabaseUrl: 'postgres://owner:fake@db.example.com:5432/heopress',
    });
    expect(provider.name).toBe(`backup module (local:${path.join(dir, 'backups')})`);
    expect(existsSync(path.join(dir, 'backups'))).toBe(false);
  });
});
