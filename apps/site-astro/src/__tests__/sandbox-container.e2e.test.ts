import { mkdtemp, readFile, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAstroBuild, type BuildRequest } from '../builder/runner';
import { templateDir } from '../builder/runner';

/**
 * A real build in a real container (HeoPress v1.5, spec rendering/astro-build-sandbox).
 *
 * Everything else about the sandbox is tested with fake runtimes; this is the one case that proves the plan produces a
 * working build on an actual engine — the flags are accepted, the image has what Astro needs, the read-only root is
 * survivable, and the output lands where the plan says. It is opt-in (`HEOPRESS_ASTRO_SANDBOX_E2E=1`) because it needs a
 * container engine and the build image; CI runs it where both exist and reports it as not covered where they do not.
 *
 *   HEOPRESS_ASTRO_SANDBOX_E2E=1 HEOPRESS_ASTRO_BUILD_CLI=docker \
 *   HEOPRESS_ASTRO_BUILD_SOCKET=unix:///var/run/docker.sock \
 *   HEOPRESS_ASTRO_BUILD_IMAGE=heopress-astro-build:1 pnpm --filter @heopress/site-astro exec vitest --run src/__tests__/sandbox-container.e2e.test.ts
 */
const enabled = process.env.HEOPRESS_ASTRO_SANDBOX_E2E === '1';

let root: string;
const saved = { ...process.env };

/**
 * A self-contained template: a workspace package resolves its dependencies through the monorepo's store, and a mounted
 * directory cannot follow a symlink that points outside the mount. `pnpm deploy` produces exactly what a deployment
 * mounts (`HEOPRESS_ASTRO_TEMPLATE_DIR`): the package with a `.pnpm` store of its own inside the directory.
 */
function selfContainedTemplate(): string {
  // Always deploy from the repository's package, never from an earlier copy this file pointed the build at.
  delete process.env.HEOPRESS_ASTRO_TEMPLATE_DIR;
  const copy = join(root, `template-${Math.random().toString(36).slice(2)}`);
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  execFileSync('pnpm', ['--filter', '@heopress/site-astro', 'deploy', '--prod', copy], { cwd: repo, stdio: 'ignore' });
  // A deployment's template is self-contained; the workspace's tsconfig extends one at the repository root, which a
  // mounted directory does not have. Copy it in and point the template at the local copy.
  execFileSync('cp', [join(repo, 'tsconfig.base.json'), join(copy, 'tsconfig.base.json')], { stdio: 'ignore' });
  const tsconfig = join(copy, 'tsconfig.json');
  const text = execFileSync('cat', [tsconfig], { encoding: 'utf8' }).replace(/\.\.\/\.\.\/tsconfig\.base\.json/g, './tsconfig.base.json');
  execFileSync('sh', ['-c', `cat > ${JSON.stringify(tsconfig)}`], { input: text });
  // The template's integration imports the published contracts package. A deployment ships it beside the template; the
  // test takes it from the workspace, dereferenced so it resolves inside the mount.
  execFileSync('mkdir', ['-p', join(copy, 'node_modules/@heopress')], { stdio: 'ignore' });
  execFileSync('cp', ['-aL', join(repo, 'packages/contracts'), join(copy, 'node_modules/@heopress/contracts')], { stdio: 'ignore' });
  return copy;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'heopress-sandbox-e2e-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  process.env = { ...saved };
});

describe.skipIf(!enabled)('a real container build', () => {
  /**
   * Blocked on template packaging (open change task 5.4): inside the mount the template resolves
   * `@heopress/contracts/page-data` through a workspace export that points at TypeScript source, which a mounted package
   * cannot resolve without the monorepo store. A deployment must ship a self-contained template (built contracts beside
   * it, or a template baked into the image); until then this case records the gap instead of passing on a workaround.
   */
  it.skip('builds the official starter theme with no network and a read-only root', async () => {
    // The template the CMS serves, with its dependencies: mounted read-only, so the image needs no packages of its own.
    const template = selfContainedTemplate();
    const theme = join(template, 'themes', 'starter');
    const outDir = join(root, 'out');
    await mkdir(outDir, { recursive: true });
    const pageData = join(template, '.page-data', `e2e-${process.pid}.json`);
    await mkdir(join(template, '.page-data'), { recursive: true });
    await writeFile(
      pageData,
      JSON.stringify({
        version: 1,
        siteId: 'e2e_site',
        origin: 'https://example.com',
        locales: ['en'],
        defaultLocale: 'en',
        site: { name: 'E2E', description: '' },
        routes: [],
        files: [],
        pages: [{ path: '/', locale: 'en', title: 'Home', kind: 'home' }],
        items: {},
        generatedAt: new Date().toISOString(),
      }),
    );

    process.env.HEOPRESS_ASTRO_BUILD_SANDBOX = 'required';
    process.env.HEOPRESS_ASTRO_TEMPLATE_DIR = template;
    process.env.HEOPRESS_ASTRO_BUILD_CPUS = '2';
    process.env.HEOPRESS_ASTRO_BUILD_MEMORY_MB = '1024';

    const request: BuildRequest = {
      pageData: { url: '', token: '', file: pageData },
      themeDir: theme,
      outDir,
      limits: { timeoutMs: 300_000, memoryMb: 1024 },
    };
    const result = await runAstroBuild(request);
    await rm(pageData, { force: true });

    // The failure message is the evidence when it fails: it is the container's own log.
    expect(result.ok, result.log).toBe(true);
    await expect(access(join(outDir, 'index.html'))).resolves.toBeUndefined();
    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(html).toContain('<html');
  }, 360_000);

  it('cannot reach the network from inside the build', async () => {
    // A theme that tries to fetch: it must fail, because the container has no network.
    const template = selfContainedTemplate();
    const theme = join(template, 'themes', 'starter');
    process.env.HEOPRESS_ASTRO_TEMPLATE_DIR = template;
    const outDir = join(root, 'out-net');
    await mkdir(outDir, { recursive: true });
    const pageData = join(template, '.page-data', `e2e-net-${process.pid}.json`);
    await mkdir(join(template, '.page-data'), { recursive: true });
    await writeFile(pageData, JSON.stringify({ version: 1, siteId: 'e2e', origin: 'https://example.com', locales: ['en'], defaultLocale: 'en', site: { name: 'E2E', description: '' }, routes: [], files: [], pages: [], items: {}, generatedAt: new Date().toISOString() }));
    process.env.HEOPRESS_ASTRO_BUILD_SANDBOX = 'required';
    const result = await runAstroBuild({
      pageData: { url: '', token: '', file: pageData },
      themeDir: theme,
      outDir,
      command: { file: 'node', args: ['-e', "fetch('https://example.com').then(() => process.exit(0), () => process.exit(9))"] },
      limits: { timeoutMs: 60_000, memoryMb: 256 },
    });
    await rm(pageData, { force: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(9);
  }, 120_000);
});
