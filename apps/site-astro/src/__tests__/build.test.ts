import { mkdtemp, readFile, rm, mkdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { servePageData } from '@heopress/site-classic/page-data';
import { activate, buildSiteGeneration, liveGeneration, templateDir, verifyBuild } from '../builder/index';
import { sampleSnapshot } from './fixtures';

/**
 * The Astro engine end to end without a database (HeoPress P11 tasks 3.1, 3.3, 3.6): the official starter theme and a
 * ported Astro blog build the sample site from the read-only page data interface; the output passes the checks; a build
 * that fails leaves the live version in place.
 */
const EXAMPLES = resolve(templateDir(), '..', '..', 'examples', 'astro-themes');
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'heopress-astro-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(join(templateDir(), 'themes', '.operator'), { recursive: true, force: true });
});

describe('Astro engine build', () => {
  it('builds the sample site with the official starter theme (task 3.1)', async () => {
    const snapshot = sampleSnapshot();
    const out = await buildSiteGeneration({ root, generation: 1, theme: 'official:starter', snapshot, serve: servePageData });
    expect(out.ok, out.ok ? '' : out.error).toBe(true);
    if (!out.ok) return;
    const item = await readFile(join(out.outDir, 'garden-tools', 'index.html'), 'utf8');
    expect(item).toContain(snapshot.pages[1]!.headHtml);
    expect(item).toContain('<aside class="heopress-disclosure" role="note">Sponsored by Acme</aside>');
    expect(item).toContain('rel="sponsored"');
    expect(item).toContain('class="theme-minimal"');
    expect(await readFile(join(out.outDir, 'robots.txt'), 'utf8')).toBe(snapshot.files[0]!.body);
    expect(await readFile(join(out.outDir, 'garden-tools.md'), 'utf8')).toBe('# Garden tools\n');
    await activate(root, snapshot.siteId, 1);
    expect(await liveGeneration(root, snapshot.siteId)).toBe(1);
  });

  it('a failing build keeps the previous version live (task 3.3)', async () => {
    const snapshot = sampleSnapshot({ revision: 8 });
    // An operator theme whose component throws while rendering.
    const themes = await mkdtemp(join(tmpdir(), 'heopress-themes-'));
    await cp(join(templateDir(), 'themes', 'starter'), join(themes, 'broken'), { recursive: true });
    const entry = join(themes, 'broken', 'src', 'Page.astro');
    await writeFile(entry, (await readFile(entry, 'utf8')).replace('const { vm } = page;', 'const { vm } = page;\nif (vm.page.type === "item") throw new Error("template error");'));
    const out = await buildSiteGeneration({ root, generation: 2, theme: 'operator:broken', snapshot, serve: servePageData, operatorThemesDir: themes });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe('build');
    expect(await liveGeneration(root, snapshot.siteId)).toBe(1);
    expect(await readFile(join(root, snapshot.siteId, 'current', 'index.html'), 'utf8')).toContain('Example Blog');
    await rm(themes, { recursive: true, force: true });
  });

  it('ports an existing Astro blog as an operator theme and builds it (task 3.6)', async () => {
    const snapshot = sampleSnapshot();
    const out = await buildSiteGeneration({ root, generation: 3, theme: 'operator:blog-port', snapshot, serve: servePageData, operatorThemesDir: EXAMPLES });
    expect(out.ok, out.ok ? '' : out.error).toBe(true);
    if (!out.ok) return;
    const home = await readFile(join(out.outDir, 'index.html'), 'utf8');
    expect(home).toContain('data-heopress-card="a1"');
    expect(await verifyBuild(out.outDir, snapshot)).toEqual([]);
  });

  it('refuses a theme without the disclosure the site requires (slot check on switch)', async () => {
    const snapshot = sampleSnapshot();
    const themes = await mkdtemp(join(tmpdir(), 'heopress-themes-'));
    await cp(join(templateDir(), 'themes', 'starter'), join(themes, 'nodisclosure'), { recursive: true });
    const entry = join(themes, 'nodisclosure', 'src', 'Page.astro');
    await writeFile(entry, (await readFile(entry, 'utf8')).replace('<SponsorDisclosure page={page} id={item.id} />', '<span />'));
    const out = await buildSiteGeneration({ root, generation: 4, theme: 'operator:nodisclosure', snapshot, serve: servePageData, operatorThemesDir: themes });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe('verify');
      expect(out.error).toContain('its disclosure is missing');
    }
    await rm(themes, { recursive: true, force: true });
  });

  it('rollback re-checks the old output against the current policy', async () => {
    // Generation 1 was built with disclosure on; with disclosure now off its disclosures are no longer allowed.
    const issues = await verifyBuild(join(root, 'site_astro_fixture', 'builds', '1'), sampleSnapshot({ disclosure: false }));
    expect(issues.some((i) => i.message.includes('disclosure off'))).toBe(true);
    expect(await verifyBuild(join(root, 'site_astro_fixture', 'builds', '1'), sampleSnapshot())).toEqual([]);
  });

  it('an empty theme directory is not a theme', async () => {
    const themes = await mkdtemp(join(tmpdir(), 'heopress-themes-'));
    await mkdir(join(themes, 'empty'));
    const out = await buildSiteGeneration({ root, generation: 5, theme: 'operator:empty', snapshot: sampleSnapshot(), serve: servePageData, operatorThemesDir: themes });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe('theme');
    await rm(themes, { recursive: true, force: true });
  });
});
