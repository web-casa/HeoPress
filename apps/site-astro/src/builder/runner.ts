import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSandbox, sandboxPlan, SandboxPlanError, socketArgs, type SandboxConfig } from './sandbox';

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
  /**
   * The page data interface (loopback) and this build's one-time token; or, for a sandboxed build, the snapshot file the
   * hosting side wrote into the build's read-only input (`file`). A sandbox has no network, so it must use the file.
   */
  pageData: { url: string; token: string; file?: string };
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
  /** A machine-readable reason when the build could not even start (`SANDBOX_UNAVAILABLE`, …). */
  failure?: 'SANDBOX_UNAVAILABLE' | 'SANDBOX_PLAN';
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
    ...(req.pageData.file
      ? { HEOPRESS_PAGE_DATA_FILE: req.pageData.file }
      : { HEOPRESS_PAGE_DATA_URL: req.pageData.url, HEOPRESS_PAGE_DATA_TOKEN: req.pageData.token }),
    HEOPRESS_ASTRO_THEME_DIR: req.themeDir,
    HEOPRESS_ASTRO_OUT_DIR: req.outDir,
    HEOPRESS_ASTRO_INTEGRATIONS: (req.integrations ?? []).join(','),
  };
  if (req.extensionsDir) env.HEOPRESS_ASTRO_EXT_DIR = req.extensionsDir;
  if (req.registry) env.npm_config_registry = req.registry;
  return env;
}


/** Whether builds must run in the sandbox (`HEOPRESS_ASTRO_BUILD_SANDBOX=required`); unset keeps the child process. */
export function sandboxRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HEOPRESS_ASTRO_BUILD_SANDBOX?.trim() === 'required';
}

const positive = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** The sandbox configuration this process was given; the image is the only part without a useful default. */
export function sandboxConfigFromEnv(env: NodeJS.ProcessEnv = process.env, limits?: BuildLimits): SandboxConfig {
  return {
    cli: env.HEOPRESS_ASTRO_BUILD_CLI?.trim() || 'podman',
    ...(env.HEOPRESS_ASTRO_BUILD_SOCKET?.trim() ? { socket: env.HEOPRESS_ASTRO_BUILD_SOCKET.trim() } : {}),
    image: env.HEOPRESS_ASTRO_BUILD_IMAGE?.trim() || 'heopress-astro-build:1',
    ...(env.HEOPRESS_ASTRO_BUILD_RUNTIME?.trim() ? { runtime: env.HEOPRESS_ASTRO_BUILD_RUNTIME.trim() } : {}),
    limits: {
      cpus: positive(env.HEOPRESS_ASTRO_BUILD_CPUS, 2),
      memoryMb: limits?.memoryMb ?? positive(env.HEOPRESS_ASTRO_BUILD_MEMORY_MB, 1024),
      pids: positive(env.HEOPRESS_ASTRO_BUILD_PIDS, 512),
    },
    ...(env.HEOPRESS_ASTRO_ROOT?.trim() ? { roots: [env.HEOPRESS_ASTRO_ROOT.trim()] } : {}),
  };
}

/** A container name that is unique per build and shaped for `sandboxPlan`. */
function sandboxContainerName(req: BuildRequest): string {
  const id = createHash('sha256').update(`${req.outDir}\u0000${req.pageData.file ?? ''}`).digest('hex').slice(0, 24);
  return `heopress-astro-${id}`;
}

/** A host path, expressed under the container path it is mounted at. */
function insideContainer(root: string, mounted: string, value: string, label: string): string {
  const rel = relative(root, resolve(value));
  if (rel.startsWith('..') || (rel !== '' && rel.startsWith(`..${sep}`))) {
    throw new SandboxPlanError('OUTSIDE_ROOT', `${label} is outside the build input (${root}) and cannot be mounted read-only`);
  }
  return rel === '' ? mounted : `${mounted}/${rel.split(sep).join('/')}`;
}

/**
 * Run one build in a throw-away container (HeoPress v1.5, spec rendering/astro-build-sandbox). The plan is built by
 * `sandboxPlan` — every flag that matters lives there and is asserted by its own tests — and this function only starts it,
 * streams its log under the same truncation and token redaction as the child process, and kills it by name when the
 * deadline passes.
 */
async function runSandboxed(req: BuildRequest, home: string): Promise<BuildResult> {
  const started = Date.now();
  const config = sandboxConfigFromEnv(process.env, req.limits);
  const probe = probeSandbox(config);
  if (!probe.available) {
    return {
      ok: false,
      failure: 'SANDBOX_UNAVAILABLE',
      code: null,
      signal: null,
      timedOut: false,
      log: `sandboxed builds are required but unavailable (${probe.reason}): ${probe.repair ?? 'see the deployment guide'}`,
      durationMs: 0,
    };
  }
  const template = templateDir();
  let plan;
  try {
    const env: Record<string, string> = {
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
      NODE_OPTIONS: `--max-old-space-size=${req.limits?.memoryMb ?? 1024}`,
      ASTRO_TELEMETRY_DISABLED: '1',
      TMPDIR: '/tmp',
      HEOPRESS_ASTRO_THEME_DIR: insideContainer(template, '/in', req.themeDir, 'the theme'),
      HEOPRESS_ASTRO_OUT_DIR: '/out',
      HEOPRESS_ASTRO_INTEGRATIONS: (req.integrations ?? []).join(','),
    };
    if (req.extensionsDir) env.HEOPRESS_ASTRO_EXT_DIR = insideContainer(template, '/in', req.extensionsDir, 'the extensions');
    if (req.pageData.file) env.HEOPRESS_PAGE_DATA_FILE = insideContainer(template, '/in', req.pageData.file, 'the page data');
    plan = sandboxPlan(
      config,
      { inputDir: template, outputDir: req.outDir },
      {
        containerName: sandboxContainerName(req),
        ...(req.user ? { uid: req.user.uid, gid: req.user.gid } : {}),
      },
      {
        env,
        // Tests: another command in place of the build, inside the same sandbox (same environment and limits).
        ...(req.command ? { command: [req.command.file, ...req.command.args] } : {}),
      },
    );
  } catch (err) {
    const code = err instanceof SandboxPlanError ? err.code : 'INVALID_PATH';
    return {
      ok: false,
      failure: 'SANDBOX_PLAN',
      code: null,
      signal: null,
      timedOut: false,
      log: `the build cannot be sandboxed (${code}): ${err instanceof Error ? err.message : String(err)}`,
      durationMs: 0,
    };
  }

  const timeoutMs = req.limits?.timeoutMs ?? 10 * 60_000;
  const name = plan.containerName;
  const stop = (signal: 'TERM' | 'KILL') => {
    // Kill by name (never by pid: the CLI's pid is not the container's), then make sure nothing is left behind.
    spawnSync(config.cli, [...socketArgs(config), 'kill', '--signal', signal, name], { stdio: 'ignore', timeout: 15_000 });
    spawnSync(config.cli, [...socketArgs(config), 'rm', '-f', name], { stdio: 'ignore', timeout: 15_000 });
  };

  return new Promise<BuildResult>((done) => {
    // The CLI's own environment is deliberately small: it needs its socket and PATH, nothing from the CMS.
    const child = spawn(plan.argv[0]!, plan.argv.slice(1), {
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let log = '';
    const take = (chunk: Buffer) => {
      log = (log + chunk.toString('utf8')).slice(-LOG_BYTES);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop('KILL');
      try {
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
      if (!timedOut) stop('TERM');
      void rm(home, { recursive: true, force: true }).catch(() => undefined);
      void rm(`${req.outDir}.cache`, { recursive: true, force: true }).catch(() => undefined);
      // Redact this build's one-time token; a sandboxed build has none (''), and splitting on '' would shred the log.
      const clean = req.pageData.token ? log.split(req.pageData.token).join('[token]') : log;
      done({ ok: code === 0 && !timedOut, code, signal, timedOut, log: clean, durationMs: Date.now() - started });
    };
    child.on('error', (err) => {
      log += `\n${err.message}`;
      finish(null, null);
    });
    child.on('close', finish);
  });
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
  if (sandboxRequired()) return runSandboxed(req, home);
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
      // Redact this build's one-time token; a sandboxed build has none (''), and splitting on '' would shred the log.
      const clean = req.pageData.token ? log.split(req.pageData.token).join('[token]') : log;
      done({ ok: code === 0 && !timedOut, code, signal, timedOut, log: clean, durationMs: Date.now() - started });
    };
    child.on('error', (err) => {
      log += `\n${err.message}`;
      finish(null, null);
    });
    child.on('close', finish);
  });
}
