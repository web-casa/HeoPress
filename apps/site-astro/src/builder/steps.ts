import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { templateDir } from './runner';

/**
 * Build steps (HeoPress P12 task 4.3; spec extensions/pipeline-extensions "主题构建步骤"): programs an Astro theme or an
 * operator-trusted plugin declares to run with the static build — a PDF or social-image generator. They run after
 * `astro build` and before the output checks, each as its own child process under the theme build's constraints:
 *
 *   - an environment built from nothing: no CMS secret or administrator credential — only the page data interface's
 *     address and this build's one-time token, the step's output directory and a throw-away HOME;
 *   - the network: the package registry and the CMS read-only (page data) interface only. Every other connection is
 *     refused by the step guard (`step-guard.mjs`, preloaded) and fails the build with the host named;
 *   - Node's permission model: reads of the build template, the built output and the step's own files; writes of its
 *     output directory and HOME only; no child processes, worker threads or native addons;
 *   - wall time (the process group is killed on the deadline), heap, and CPU seconds (`prlimit`, when available).
 *
 * A step's assets are published with the build under `/_build/<owner>/<step>/`. A failing or timed-out step fails the
 * build (the caller removes the output; the live version stays). This is trusted build code, not a sandbox: it is not
 * isolated from the host's files until the build container sandbox exists, which is why a plugin's steps run only when
 * the operator marked the plugin as trusted (the CMS decides; marketplace plugins are not trusted by default).
 */

export interface BuildStep {
  /** `theme`: declared by the theme's package.json; `plugin`: by an operator-trusted plugin's manifest. */
  owner: 'theme' | 'plugin';
  /** The theme reference or the plugin name (for the log). */
  source: string;
  /** Where the step's assets go: `/_build/<scope>/<id>/` (the theme: `theme`; a plugin: its namespace). */
  scope: string;
  id: string;
  /** A theme step: its script file (inside the theme). */
  scriptFile?: string;
  /** A plugin step: its ES module source. */
  scriptSource?: string;
  timeoutMs: number;
}

export interface BuildStepResult {
  owner: BuildStep['owner'];
  source: string;
  step: string;
  status: 'ran' | 'failed';
  reason?: string;
  durationMs: number;
  log: string;
}

export interface BuildStepRun {
  outDir: string;
  pageData: { url: string; token: string };
  registry?: string;
  memoryMb?: number;
  cpuSeconds?: number;
  user?: { uid: number; gid: number };
}

const SCOPE = /^[a-z][a-z0-9_-]{0,39}$/;
const LOG_BYTES = 8 * 1024;
/** The exit code the step guard sets when the step tried to reach a host it may not. */
const REFUSED_EXIT = 97;

/**
 * The scratch space of a build's steps: a sibling of the output directory, never a path the output directory's name is a
 * prefix of — Node's permission model mis-handles two granted paths where one is a string prefix of the other
 * (`/b/1` and `/b/1.steps/…`: reading the directory `/b/1` itself is then refused).
 */
function stepsDir(outDir: string): string {
  return join(dirname(outDir), `.steps-${basename(outDir)}`);
}

/** The guard preloaded into every step (shipped with the build template). */
export function stepGuardFile(): string {
  return join(templateDir(), 'src', 'builder', 'step-guard.mjs');
}

/** The hosts a step may connect to: the page data interface and the package registry (`host:port`). */
export function stepAllowedHosts(run: Pick<BuildStepRun, 'pageData' | 'registry'>): string[] {
  const out = new Set<string>();
  for (const raw of [run.pageData.url, run.registry]) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      const port = u.port || (u.protocol === 'https:' ? '443' : '80');
      out.add(`${u.hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${port}`);
    } catch {
      /* not a URL: nothing allowed for it */
    }
  }
  return [...out];
}

/** A step's whole environment (nothing inherited). Exported for the isolation test. */
export function stepEnv(run: BuildStepRun, step: BuildStep, dirs: { home: string; out: string }): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: dirs.home,
    TMPDIR: dirs.home,
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
    NODE_OPTIONS: '',
    CI: '1',
    HEOPRESS_PAGE_DATA_URL: run.pageData.url,
    HEOPRESS_PAGE_DATA_TOKEN: run.pageData.token,
    HEOPRESS_BUILD_OUT_DIR: run.outDir,
    HEOPRESS_BUILD_STEP_OUT_DIR: dirs.out,
    HEOPRESS_BUILD_STEP_ID: `${step.scope}/${step.id}`,
    HEOPRESS_BUILD_STEP_HOSTS: stepAllowedHosts(run).join(','),
  };
  if (run.registry) env.npm_config_registry = run.registry;
  return env;
}

let prlimitPath: string | null | undefined;
async function prlimit(): Promise<string | null> {
  if (prlimitPath === undefined) {
    prlimitPath = await new Promise<string | null>((done) => {
      const p = spawn('prlimit', ['--version'], { stdio: 'ignore' });
      p.on('error', () => done(null));
      p.on('close', (code) => done(code === 0 ? 'prlimit' : null));
    });
  }
  return prlimitPath;
}

/** Run one step. Never throws: a failure is a result with its reason. */
export async function runBuildStep(run: BuildStepRun, step: BuildStep): Promise<BuildStepResult> {
  const started = Date.now();
  const base = { owner: step.owner, source: step.source, step: step.id };
  const fail = (reason: string, log = ''): BuildStepResult => ({ ...base, status: 'failed', reason, durationMs: Date.now() - started, log });
  if (!SCOPE.test(step.scope) || !SCOPE.test(step.id)) return fail('not a step name');
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (runningAsRoot && (!run.user || run.user.uid === 0)) return fail('refused: a build step never runs as root (set HEOPRESS_ASTRO_BUILD_UID/GID)');
  const out = resolve(run.outDir, '_build', step.scope, step.id);
  if (!out.startsWith(resolve(run.outDir) + sep)) return fail('output outside the build');
  const work = join(stepsDir(run.outDir), step.scope, step.id);
  const home = join(work, 'home');
  await rm(work, { recursive: true, force: true });
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(out, { recursive: true });
  let script: string;
  if (step.scriptSource !== undefined) {
    script = join(work, 'step.mjs');
    await writeFile(script, step.scriptSource, { mode: 0o600 });
  } else if (step.scriptFile) {
    script = step.scriptFile;
  } else {
    return fail('the step has no program');
  }
  const reads = [templateDir(), run.outDir, work, script];
  const nodeArgs = [
    '--permission',
    ...reads.map((p) => `--allow-fs-read=${p}`),
    `--allow-fs-write=${out}`,
    `--allow-fs-write=${home}`,
    `--max-old-space-size=${run.memoryMb ?? 512}`,
    `--import=${stepGuardFile()}`,
    script,
  ];
  const limiter = await prlimit();
  const [file, args] = limiter ? [limiter, [`--cpu=${run.cpuSeconds ?? 300}`, '--', process.execPath, ...nodeArgs]] : [process.execPath, nodeArgs];
  return new Promise<BuildStepResult>((done) => {
    const child = spawn(file, args, {
      cwd: work,
      env: stepEnv(run, step, { home, out }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(run.user && runningAsRoot ? { uid: run.user.uid, gid: run.user.gid } : {}),
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
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, step.timeoutMs);
    let finished = false;
    const finish = async (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
      const clean = run.pageData.token ? log.split(run.pageData.token).join('[token]') : log;
      const refused = /\[heopress-build-step\] refused connection to (\S+)/.exec(clean)?.[1];
      if (timedOut) return done(fail(`timed out after ${step.timeoutMs} ms`, clean));
      if (refused || code === REFUSED_EXIT) {
        return done(fail(`requested ${refused ?? 'a host'}: a build step may reach only the package registry and the CMS read-only interface`, clean));
      }
      if (code !== 0) return done(fail(`exited with ${code ?? 'a signal'}`, clean));
      done({ ...base, status: 'ran', durationMs: Date.now() - started, log: clean });
    };
    child.on('error', (err) => {
      log += `\n${err.message}`;
      void finish(null);
    });
    child.on('close', (code) => void finish(code));
  });
}

/** Run the steps in order; the first failure stops the rest (the build fails). */
export async function runBuildSteps(run: BuildStepRun, steps: BuildStep[]): Promise<{ ok: boolean; results: BuildStepResult[] }> {
  const results: BuildStepResult[] = [];
  try {
    for (const step of steps) {
      const r = await runBuildStep(run, step);
      results.push(r);
      if (r.status === 'failed') return { ok: false, results };
    }
    return { ok: true, results };
  } finally {
    await rm(stepsDir(run.outDir), { recursive: true, force: true }).catch(() => undefined);
  }
}
