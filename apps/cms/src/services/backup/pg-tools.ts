import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

/**
 * PostgreSQL client programs for backups (HeoPress P13 tasks 1.1, 1.3): pg_basebackup, pg_combinebackup,
 * pg_verifybackup, pg_dump, pg_restore, and pg_ctl / postgres for a drill's temporary server. Version 18, like the
 * server (`HEOPRESS_PG_BIN_DIR`, else `/usr/lib/postgresql/18/bin`, else `PATH`).
 *
 * Connection settings go to the programs as libpq environment variables, never as arguments: a password is never on
 * a command line (visible in the process list) nor in an error message.
 */

const accessAsync = promisify(access);

class PgToolError extends Error {
  constructor(
    readonly code: 'TOOL_MISSING' | 'TOOL_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'PgToolError';
  }
}

export interface PgConn {
  host: string;
  port: number;
  user: string;
  password: string | null;
  database: string;
  sslmode: string | null;
}

/** Split a `postgres://` URL into its parts. */
export function parsePgUrl(url: string): PgConn {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('Not a PostgreSQL URL.');
  return {
    host: decodeURIComponent(u.hostname) || 'localhost',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : null,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    sslmode: u.searchParams.get('sslmode'),
  };
}

/** A URL for the same server and credentials with another database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

/** Where a connection points, without credentials (for reports and the "never production" check). */
export function describeConn(c: PgConn): string {
  return `${c.host}:${c.port}/${c.database}`;
}

export function pgEnv(c: PgConn): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    PGHOST: c.host,
    PGPORT: String(c.port),
    PGUSER: c.user,
    PGDATABASE: c.database,
    PGCONNECT_TIMEOUT: '15',
  };
  if (c.password !== null) env.PGPASSWORD = c.password;
  if (c.sslmode) env.PGSSLMODE = c.sslmode;
  return env;
}

const candidates = (binDir: string | null | undefined): string[] => [
  ...(binDir ? [binDir] : []),
  '/usr/lib/postgresql/18/bin',
  ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
];

/** The path of a PostgreSQL program, or `TOOL_MISSING`. */
export async function findPgTool(name: string, binDir?: string | null): Promise<string> {
  for (const dir of candidates(binDir)) {
    const p = path.join(dir, name);
    try {
      await accessAsync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  throw new PgToolError('TOOL_MISSING', `${name} (PostgreSQL 18) was not found: install the PostgreSQL 18 client programs or set HEOPRESS_PG_BIN_DIR.`);
}

/** Whether the programs a backup method needs are all there. */
export async function pgToolsAvailable(names: string[], binDir?: string | null): Promise<boolean> {
  try {
    for (const n of names) await findPgTool(n, binDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a program; resolve with its standard output, reject with `TOOL_FAILED` and the end of its standard error.
 * `env` replaces the environment (the caller adds `pgEnv`), so nothing of this process's secrets leaks to it.
 */
export function runTool(file: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : null;
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 1_000_000) out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString('utf8')).slice(-4000);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new PgToolError('TOOL_FAILED', `${path.basename(file)} could not start: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new PgToolError('TOOL_FAILED', `${path.basename(file)} failed (${signal ?? `exit ${code}`}): ${redactConn(err.trim()).slice(-1500)}`));
    });
  });
}

/** Remove anything that looks like a connection URL with a password from tool output. */
export function redactConn(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+@/gi, '$1***@').replace(/password=\S+/gi, 'password=***');
}
