import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Astro build process (HeoPress P11 tasks 3.2, 3.5; spec rendering/astro-engine "构建隔离与版本一致"): one build
 * runs as a child process
 *
 *   - with an environment built from nothing: the page data interface's address and this build's one-time token, the
 *     theme, the output directory, the approved integrations, a throw-away HOME, PATH and the package registry — never
 *     the CMS's environment (database URLs, secrets, provider tokens, administrator credentials);
 *   - not as root: when the CMS runs as root, a build runs as the configured unprivileged uid/gid, or not at all;
 *   - under limits: heap (`--max-old-space-size`), CPU seconds (`prlimit`, when the system has it) and wall time
 *     (the whole process group is killed on the deadline).
 *
 * A child process is not a security sandbox: v1 builds only the operator's own and official themes. Third-party themes
 * need the container sandbox first (`docs/backlog/astro-build-sandbox.md`).
 */

/**
 * The build template's directory: `HEOPRESS_ASTRO_TEMPLATE_DIR`, or this package's own. Read when asked, never at module
 * load (bundled into the CMS's CommonJS build, `import.meta.url` is undefined).
 */
export function templateDir(): string {
  const configured = process.env.HEOPRESS_ASTRO_TEMPLATE_DIR?.trim();
  return configured ? resolve(configured) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export interface BuildLimits {
  /** Wall time, ms (default 10 min). */
  timeoutMs?: number;
  /** V8 heap, MB (default 1024). */
  memoryMb?: number;
  /** CPU seconds (default 600; applied with `prlimit` when available). */
  cpuSeconds?: number;
}

export interface BuildRequest {
  /** The page data interface (loopback) and this build's one-time token. */
  pageData: { url: string; token: string };
  /** The theme's directory (under the template's `themes/`). */
  themeDir: string;
  /** The site's plugins' staged Astro sources (`stageExtensions`; P12), if it has any. */
  extensionsDir?: string | null;
  /** A new, empty directory for this build's output. */
  outDir: string;
  /** Integrations the operator approved. */
  integrations?: string[];
  limits?: BuildLimits;
  /** Run as this user when the CMS itself is root (required then). */
  user?: { uid: number; gid: number };
  /** The package registry the build may use (`npm_config_registry`). */
  registry?: string;
  /** Tests: another command in place of `astro build` (same environment and limits). */
  command?: { file: string; args: string[] };
}

export interface BuildResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** The output's last lines, the token removed. */
  log: string;
  durationMs: number;
}

const LOG_BYTES = 16 * 1024;

let prlimitPath: string | null | undefined;
function prlimit(): string | null {
  if (prlimitPath === undefined) {
    const r = spawnSync('prlimit', ['--version'], { stdio: 'ignore' });
    prlimitPath = r.status === 0 ? 'prlimit' : null;
  }
  return prlimitPath;
}

/** The build's whole environment (nothing inherited). Exported for the isolation test. */
export function buildEnv(req: BuildRequest, home: string): Record<string, string> {
  const memoryMb = req.limits?.memoryMb ?? 1024;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: home,
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
    NODE_OPTIONS: `--max-old-space-size=${memoryMb}`,
    ASTRO_TELEMETRY_DISABLED: '1',
    CI: '1',
    HEOPRESS_PAGE_DATA_URL: req.pageData.url,
    HEOPRESS_PAGE_DATA_TOKEN: req.pageData.token,
    HEOPRESS_ASTRO_THEME_DIR: req.themeDir,
    HEOPRESS_ASTRO_OUT_DIR: req.outDir,
    HEOPRESS_ASTRO_INTEGRATIONS: (req.integrations ?? []).join(','),
  };
  if (req.extensionsDir) env.HEOPRESS_ASTRO_EXT_DIR = req.extensionsDir;
  if (req.registry) env.npm_config_registry = req.registry;
  return env;
}

export async function runAstroBuild(req: BuildRequest): Promise<BuildResult> {
  const started = Date.now();
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (runningAsRoot && (!req.user || req.user.uid === 0)) {
    return { ok: false, code: null, signal: null, timedOut: false, log: 'refused: a build never runs as root (set HEOPRESS_ASTRO_BUILD_UID/GID)', durationMs: 0 };
  }
  const home = `${req.outDir}.home`;
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(dirname(req.outDir), { recursive: true });
  const env = buildEnv(req, home);
  const base = req.command ?? { file: process.execPath, args: [join(templateDir(), 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', '--silent'] };
  const cpu = req.limits?.cpuSeconds ?? 600;
  const limiter = prlimit();
  const [file, args] = limiter ? [limiter, [`--cpu=${cpu}`, '--', base.file, ...base.args]] : [base.file, base.args];
  const timeoutMs = req.limits?.timeoutMs ?? 10 * 60_000;
  return new Promise<BuildResult>((done) => {
    const child = spawn(file, args, {
      cwd: templateDir(),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(req.user && runningAsRoot ? { uid: req.user.uid, gid: req.user.gid } : {}),
    });
    let log = '';
    const take = (chunk: Buffer) => {
      log = (log + chunk.toString('utf8')).slice(-LOG_BYTES);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // The whole group: the build and anything it started.
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void rm(home, { recursive: true, force: true }).catch(() => undefined);
      void rm(`${req.outDir}.cache`, { recursive: true, force: true }).catch(() => undefined);
      const clean = log.split(req.pageData.token).join('[token]');
      done({ ok: code === 0 && !timedOut, code, signal, timedOut, log: clean, durationMs: Date.now() - started });
    };
    child.on('error', (err) => {
      log += `\n${err.message}`;
      finish(null, null);
    });
    child.on('close', finish);
  });
}
