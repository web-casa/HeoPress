import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runAstroBuild, sandboxConfigFromEnv, sandboxRequired, type BuildRequest } from '../builder/runner';

/**
 * A build driven by the sandbox plan (HeoPress v1.5, spec rendering/astro-build-sandbox), with a fake runtime CLI so the
 * wiring — argv, path mapping, kill-by-name, fail-closed — is tested without a container engine.
 *
 * What matters here is that the build never runs as a child process when the sandbox is required, that the container sees
 * only mapped paths, and that an unavailable runtime is a reported failure rather than a fallback.
 */
let root: string;
const saved = { ...process.env };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'heopress-sandbox-run-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  process.env = { ...saved };
});

/** A fake runtime: records its argv, then behaves as `body` says. */
async function fakeRuntime(body: string): Promise<{ cli: string; calls: string }> {
  const cli = join(root, `runtime-${Math.random().toString(36).slice(2)}`);
  const calls = `${cli}.calls`;
  await writeFile(cli, `#!/bin/sh\necho "$@" >> "${calls}"\n${body}\n`, 'utf8');
  await chmod(cli, 0o755);
  return { cli, calls };
}

const template = () => join(root, 'template');
/** The build template is a mounted copy in a deployment; point it at the fixture so nothing is written into the repo. */
const useTemplate = () => {
  process.env.HEOPRESS_ASTRO_TEMPLATE_DIR = template();
};
let seq = 0;
const request = (over: Partial<BuildRequest> = {}): BuildRequest => ({
  pageData: { url: '', token: '', file: join(template(), '.page-data', '1.json') },
  themeDir: join(template(), 'themes', 'starter'),
  outDir: join(root, `out-${++seq}`),
  ...over,
});

/** The runtime body that succeeds: the output directory is the second `-v` mount's host side. */
const SUCCEEDS = `
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ]; then case "$a" in *:/out:rw*) out="\${a%%:/out:rw*}";; esac; fi
  prev="$a"
done
mkdir -p "$out/dist"
printf '<html>ok</html>' > "$out/dist/index.html"
exit 0
`;

describe('sandbox-required builds', () => {
  it('is off unless asked, so an existing deployment keeps building', () => {
    expect(sandboxRequired({} as NodeJS.ProcessEnv)).toBe(false);
    expect(sandboxRequired({ HEOPRESS_ASTRO_BUILD_SANDBOX: 'required' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('maps the build into the container and never hands it a host path', async () => {
    await mkdir(join(template(), '.page-data'), { recursive: true });
    await writeFile(join(template(), '.page-data', '1.json'), '{}');
    const { cli, calls } = await fakeRuntime(SUCCEEDS);
    useTemplate();
    process.env.HEOPRESS_ASTRO_BUILD_SANDBOX = 'required';
    process.env.HEOPRESS_ASTRO_BUILD_CLI = cli;
    process.env.HEOPRESS_ASTRO_BUILD_IMAGE = 'heopress-astro-build:test';

    const req = request();
    const result = await runAstroBuild(req);
    expect(result.ok).toBe(true);
    expect(await readFile(join(req.outDir, 'dist', 'index.html'), 'utf8')).toBe('<html>ok</html>');

    const argv = (await readFile(calls, 'utf8')).split('\n').filter(Boolean).join(' ');
    expect(argv).toContain('--network none');
    expect(argv).toContain('--read-only');
    // The container's environment names container paths, not the host's.
    expect(argv).toContain('HEOPRESS_ASTRO_OUT_DIR=/out');
    expect(argv).toContain('HEOPRESS_ASTRO_THEME_DIR=/in/themes/starter');
    expect(argv).toContain('HEOPRESS_PAGE_DATA_FILE=/in/.page-data/1.json');
    // A host path may appear only as the host side of the two mounts.
    const tokens = argv.split(' ').filter((token) => token.includes(root));
    expect(tokens).toEqual([`${template()}:/in:ro,z`, `${req.outDir}:/out:rw,z`]);
  });

  it('fails with SANDBOX_UNAVAILABLE instead of falling back to a child process', async () => {
    useTemplate();
    process.env.HEOPRESS_ASTRO_BUILD_SANDBOX = 'required';
    process.env.HEOPRESS_ASTRO_BUILD_CLI = join(root, 'no-such-runtime');
    const req = request();
    const result = await runAstroBuild(req);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('SANDBOX_UNAVAILABLE');
    expect(result.log).toContain('cli_missing');
    // Nothing was produced and nothing ran on the host.
    await expect(stat(join(req.outDir, 'dist'))).rejects.toThrow();
  });

  it('reports a failing build from the container', async () => {
    await mkdir(join(template(), '.page-data'), { recursive: true });
    await writeFile(join(template(), '.page-data', '1.json'), '{}');
    const { cli } = await fakeRuntime('case "$1" in run) echo "astro: build failed" 1>&2; exit 2;; esac; exit 0');
    useTemplate();
    process.env.HEOPRESS_ASTRO_BUILD_SANDBOX = 'required';
    process.env.HEOPRESS_ASTRO_BUILD_CLI = cli;
    const req = request();
    const result = await runAstroBuild(req);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
    expect(result.log).toContain('build failed');
    expect(result.failure).toBeUndefined();
  });

  it('refuses a theme outside the mounted input, and says why', async () => {
    const { cli } = await fakeRuntime(SUCCEEDS);
    useTemplate();
    process.env.HEOPRESS_ASTRO_BUILD_SANDBOX = 'required';
    process.env.HEOPRESS_ASTRO_BUILD_CLI = cli;
    const result = await runAstroBuild(request({ themeDir: join(root, 'elsewhere', 'theme') }));
    expect(result.failure).toBe('SANDBOX_PLAN');
    expect(result.log).toContain('OUTSIDE_ROOT');
  });

  it('kills the container by name when the deadline passes', async () => {
    await mkdir(join(template(), '.page-data'), { recursive: true });
    await writeFile(join(template(), '.page-data', '1.json'), '{}');
    const { cli, calls } = await fakeRuntime('case "$1" in run) sleep 30;; esac; exit 0');
    useTemplate();
    process.env.HEOPRESS_ASTRO_BUILD_SANDBOX = 'required';
    process.env.HEOPRESS_ASTRO_BUILD_CLI = cli;
    const result = await runAstroBuild(request({ limits: { timeoutMs: 300, memoryMb: 256 } }));
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    const argv = (await readFile(calls, 'utf8')).split('\n').filter(Boolean).join(' ');
    expect(argv).toMatch(/kill --signal KILL heopress-astro-/);
    expect(argv).toMatch(/rm -f heopress-astro-/);
  });

  it('runs as container root under a rootless runtime, so the output stays writable', async () => {
    await mkdir(join(template(), '.page-data'), { recursive: true });
    await writeFile(join(template(), '.page-data', '1.json'), '{}');
    const { cli, calls } = await fakeRuntime('case "$1" in info) echo true;; *) exit 0;; esac');
    useTemplate();
    process.env.HEOPRESS_ASTRO_BUILD_SANDBOX = 'required';
    process.env.HEOPRESS_ASTRO_BUILD_CLI = cli;
    await runAstroBuild(request());
    const argv = (await readFile(calls, 'utf8')).split('\n').filter(Boolean).join(' ');
    // Container root is the invoking host user under a rootless runtime; any other uid lands on a subordinate id.
    expect(argv).toContain('--user 0:0');
  });

  it('bounds what an operator can configure', () => {
    const config = sandboxConfigFromEnv({} as NodeJS.ProcessEnv, { memoryMb: 321 });
    expect(config.image).toBe('heopress-astro-build:1');
    expect(config.limits).toEqual({ cpus: 2, memoryMb: 321, pids: 512 });
    const negative = sandboxConfigFromEnv({ HEOPRESS_ASTRO_BUILD_CPUS: '-1', HEOPRESS_ASTRO_BUILD_PIDS: 'x' } as NodeJS.ProcessEnv);
    expect(negative.limits.cpus).toBe(2);
    expect(negative.limits.pids).toBe(512);
  });
});
