import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activate, checkAstroTheme, discard, liveGeneration, officialThemeDir, parseThemeRef, prune, runAstroBuild, StaleGenerationError } from '../builder/index';

/**
 * The build sandbox's guarantees (HeoPress P11 task 3.5) and atomic activation (task 3.3): the build process cannot read
 * the CMS's secrets, a build past its time is killed, an older build that finishes late does not go live; v1 accepts
 * official and operator themes only, with approved integrations only and data from the page data contract only.
 */
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'heopress-astro-iso-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const request = (outDir: string, script: string, limits = {}) => ({
  pageData: { url: 'http://127.0.0.1:9/v1/page-data', token: 'tok-abc' },
  themeDir: officialThemeDir('starter')!,
  outDir,
  limits,
  command: { file: process.execPath, args: ['-e', script] },
});

describe('build process isolation', () => {
  it('the build process sees none of the CMS environment', async () => {
    // What the CMS process holds (fake values).
    process.env.DATABASE_URL = 'postgresql://cms:pw@db.example.com/cms';
    process.env.JWT_SECRET = 'fake-jwt';
    process.env.ENCRYPTION_KEY = 'fake-key';
    process.env.HEOPRESS_ADMIN_PASSWORD = 'fake-admin';
    const out = join(root, 'env', 'out');
    await mkdir(join(root, 'env'), { recursive: true });
    const r = await runAstroBuild(request(out, `require('fs').writeFileSync(${JSON.stringify(join(root, 'env', 'seen.json'))}, JSON.stringify(process.env))`));
    expect(r.ok).toBe(true);
    const seen = JSON.parse(await readFile(join(root, 'env', 'seen.json'), 'utf8')) as Record<string, string>;
    for (const k of ['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY', 'HEOPRESS_ADMIN_PASSWORD']) expect(seen[k]).toBeUndefined();
    expect(Object.values(seen).join('\n')).not.toContain('fake-');
    expect(Object.keys(seen).filter((k) => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'NODE_ENV', 'NODE_OPTIONS', 'ASTRO_TELEMETRY_DISABLED', 'CI'].includes(k) && !k.startsWith('HEOPRESS_ASTRO_') && !k.startsWith('HEOPRESS_PAGE_DATA_')).filter((k) => !/^(PWD|SHLVL|_|OLDPWD)$/.test(k))).toEqual([]);
    expect(seen.NODE_OPTIONS).toMatch(/--max-old-space-size=\d+/);
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.HEOPRESS_ADMIN_PASSWORD;
  });

  it('a build past its time is killed', async () => {
    const r = await runAstroBuild(request(join(root, 'slow', 'out'), 'setInterval(() => {}, 1000)', { timeoutMs: 500 }));
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it('the token never appears in the kept log', async () => {
    const r = await runAstroBuild(request(join(root, 'log', 'out'), 'console.error(process.env.HEOPRESS_PAGE_DATA_TOKEN); process.exit(3)'));
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.log).not.toContain('tok-abc');
  });
});

describe('atomic activation', () => {
  it('switches generations; an older build finishing late does not go live; rollback is explicit', async () => {
    for (const g of [1, 2, 3]) {
      await mkdir(join(root, 'site_a', 'builds', String(g)), { recursive: true });
      await writeFile(join(root, 'site_a', 'builds', String(g), 'index.html'), `v${g}`);
    }
    await activate(root, 'site_a', 1);
    await activate(root, 'site_a', 3);
    await expect(activate(root, 'site_a', 2)).rejects.toBeInstanceOf(StaleGenerationError);
    expect(await readFile(join(root, 'site_a', 'current', 'index.html'), 'utf8')).toBe('v3');
    await activate(root, 'site_a', 1, { rollback: true });
    expect(await liveGeneration(root, 'site_a')).toBe(1);
    await discard(root, 'site_a', 1); // the live one is kept
    expect(await readFile(join(root, 'site_a', 'current', 'index.html'), 'utf8')).toBe('v1');
    expect(await prune(root, 'site_a', 1)).toEqual([2]);
  });
});

describe('themes (v1: official and operator only)', () => {
  it('accepts official and operator references only', () => {
    expect(parseThemeRef('official:starter')).toEqual({ kind: 'official', name: 'starter' });
    expect(parseThemeRef('operator:my-theme').kind).toBe('operator');
    for (const bad of ['https://themes.example.com/x.tgz', 'npm:astro-theme-x', 'official:nope', 'operator:../x', 'marketplace:x']) expect(() => parseThemeRef(bad)).toThrow();
  });

  it('the official starter passes its checks', async () => {
    expect(await checkAstroTheme(officialThemeDir('starter')!)).toEqual([]);
  });

  it('refuses unapproved integrations and data not from the page data contract', async () => {
    const dir = join(root, 'bad-theme');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ heopress: { astroTheme: { entry: 'src/Page.astro', integrations: ['@astrojs/partytown'] } } }));
    await writeFile(
      join(dir, 'src', 'Page.astro'),
      `---\nimport SeoHead from '@heopress/astro-kit/SeoHead.astro';\nconst token = process.env.DATABASE_URL;\nconst r = await fetch('https://cms.example.com/api/items');\n---\n<script type="application/ld+json">{}</script>`,
    );
    const issues = (await checkAstroTheme(dir)).map((i) => i.message);
    expect(issues).toEqual(expect.arrayContaining(['integration not approved by the operator: @astrojs/partytown', 'reads the environment', 'makes network requests', 'names a CMS administration or API path', "writes JSON-LD (the system head carries the page's one graph)"]));
    expect((await checkAstroTheme(dir, { approvedIntegrations: ['@astrojs/partytown'] })).map((i) => i.message)).not.toContain('integration not approved by the operator: @astrojs/partytown');
  });
});
