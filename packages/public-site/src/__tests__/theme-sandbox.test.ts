import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ThemeViewModel } from '@heopress/contracts/theme';
import { BUILTIN_THEME } from '../theme/builtin.ts';
import { checkTheme } from '../theme/check.ts';
import { createThemeEngine, renderTemplate } from '../theme/engine.ts';
import { RenderPool, type RenderJob } from '../theme/pool.ts';
import { sampleSystemContent, sampleViewModels } from '../theme/samples.ts';

/**
 * The template sandbox sample set (HeoPress P06 task 7.1; ADR-0017): each hostile template is refused
 * before publication (`checkTheme`) and again when rendered (the engine), or cut off by a limit — and a
 * failure reaches the caller as a one-line message, never a stack or a path.
 */

const vms = sampleViewModels();
const top = BUILTIN_THEME['partials/top']!;
const bottom = BUILTIN_THEME['partials/bottom']!;
const home = (body: string, extra: Record<string, string> = {}) => ({ ...BUILTIN_THEME, home: `${top}${body}${bottom}`, ...extra });
const render = async (templates: Record<string, string>, vm: ThemeViewModel = vms.home) => (await renderTemplate(createThemeEngine(templates), 'home', vm)).html;
const issues = (templates: Record<string, string>) => checkTheme(templates).map((i) => i.message).join('\n');

const dir = mkdtempSync(join(tmpdir(), 'heopress-sandbox-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let pool: RenderPool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});
const job = (siteId: string, versionId: string, templates: Record<string, string>): RenderJob => ({
  siteId,
  versionId,
  templates,
  entry: 'home',
  vm: vms.home,
  system: sampleSystemContent(true),
});

describe('template sandbox samples (task 7.1)', () => {
  it('cross-directory and absolute includes: refused before publication, not found when rendered', async () => {
    for (const name of ['../home', 'partials/../home', '/etc/passwd', '../../../../etc/passwd', 'partials/top.liquid']) {
      const t = home(`{% include '${name}' %}`);
      expect(issues(t), name).toMatch(/no such template/);
      await expect(render(t), name).rejects.toThrow(/Failed to lookup/);
    }
    // From inside a directory too: a name is never normalised against the including template's place.
    for (const name of ['../home', '../../home', '../partials/top', './top', 'partials/./top']) {
      const t = home(`{% include 'partials/x' %}`, { 'partials/x': `{% include '${name}' %}` });
      expect(issues(t), name).toMatch(/no such template/);
      await expect(render(t), name).rejects.toThrow(/Failed to lookup/);
    }
    // A template stored under such a name is refused by the checks and by the engine itself.
    const smuggled = home(`{% include '../evil' %}`, { '../evil': 'EVIL' });
    expect(issues(smuggled)).toMatch(/template names are lowercase paths/);
    expect(() => createThemeEngine(smuggled)).toThrow(/template names are lowercase paths/);
  });

  it('symbolic links and real files: templates are an in-memory map, the file system is never read', async () => {
    const secret = join(dir, 'secret.liquid');
    writeFileSync(secret, 'FILE-SYSTEM-SECRET');
    symlinkSync(secret, join(dir, 'link.liquid'));
    for (const target of [secret.slice(0, -'.liquid'.length), join(dir, 'link'), `${dir}/../${dir.split('/').pop()}/link`]) {
      const t = home(`{% include '${target}' %}`);
      expect(issues(t), target).toMatch(/no such template/);
      const out = await render(t).catch((e: unknown) => String(e));
      expect(out, target).not.toContain('FILE-SYSTEM-SECRET');
      expect(out, target).toMatch(/Failed to lookup/);
    }
  });

  it('prototype chain: no path into JavaScript internals, by name, by string key or by variable key', async () => {
    for (const expr of ['site.constructor', 'site.__proto__', "site['__proto__']", 'list.first.constructor.name', 'page.path.valueOf', "site['constructor']['prototype']"]) {
      const t = home(`{{ ${expr} }}`);
      expect(issues(t), expr).toMatch(/property path not allowed/);
      await expect(render(t), expr).rejects.toThrow(/property path not allowed/);
    }
    const dynamic = home(`{% assign k = 'constructor' %}{{ site[k] }}`);
    expect(issues(dynamic)).toMatch(/property path not allowed/);
    // Own properties only: what the data inherits does not exist (strict variables: an error, not a value).
    await expect(render(home('{{ site.toString }}'))).rejects.toThrow(/undefined variable/);
    await expect(render(home('{{ site.name.toUpperCase }}'))).rejects.toThrow(/undefined variable/);
  });

  it('runaway loops and recursion: stopped by the render limit; a recursive include is refused before publication', async () => {
    // A range too large to hold: the memory limit, before any iteration.
    await expect(render(home('{% for i in (1..100000000) %}{% endfor %}'))).rejects.toThrow(/memory alloc limit exceeded/);
    // Ten billion iterations allocating nothing: the engine's render-time limit.
    await expect(render(home('{% for i in (1..100000) %}{% for j in (1..100000) %}{% endfor %}{% endfor %}'))).rejects.toThrow(/template render limit exceeded/);
    const recursive = home(`{% include 'partials/loop' %}`, { 'partials/loop': `x{% include 'partials/loop' %}` });
    expect(issues(recursive)).toMatch(/partial cycle/);
    await expect(render(recursive)).rejects.toThrow(/template render limit exceeded/);
    const mutual = home(`{% render 'partials/a' %}`, { 'partials/a': `{% render 'partials/b' %}`, 'partials/b': `{% render 'partials/a' %}` });
    expect(issues(mutual)).toMatch(/partial cycle/);
    await expect(render(mutual)).rejects.toThrow(/template render limit exceeded/);
    // And in the pool, with the engine's own limit out of the way: the worker is stopped at the wall-clock timeout.
    pool = new RenderPool({ workers: 1, timeoutMs: 300, renderLimitMs: 600_000 });
    const busy = home('{% for i in (1..1000) %}{% for j in (1..1000) %}{% for k in (1..1000) %}{% endfor %}{% endfor %}{% endfor %}');
    await expect(pool.render(job('a', 'busy:1', busy))).rejects.toMatchObject({ code: 'RENDER_TIMEOUT' });
  }, 15_000);

  it('output inflation: doubling strings, nested loops and captures are cut off as they are written', async () => {
    // A doubling string: each filter result is bounded.
    await expect(render(home(`{% assign s = 'aaaaaaaaaa' %}{% for i in (1..40) %}{% assign s = s | append: s %}{% endfor %}{{ s }}`))).rejects.toThrow(/filter "append": string too long/);
    // Fast output: a 64 KB string written 100 times is cut off by the character budget, as it is written.
    await expect(render(home(`{% assign s = 'aaaaaaaa' %}{% for i in (1..13) %}{% assign s = s | append: s %}{% endfor %}{% for i in (1..100) %}{{ s }}{% endfor %}`))).rejects.toThrow(/render output limit exceeded/);
    // A capture of four 64 KB writes: over its own bound at once (few writes, so not the time limit first).
    await expect(render(home(`{% assign s = 'aaaaaaaa' %}{% for i in (1..13) %}{% assign s = s | append: s %}{% endfor %}{% capture c %}{{ s }}{{ s }}{{ s }}{{ s }}{% endcapture %}ok`))).rejects.toThrow(/capture too large/);
    // Split and join widening a string: each array result is bounded too.
    await expect(render(home(`{{ site.name | split: '' | join: 'xxxxxxxxxxxxxxxxxxxx' | split: '' | join: 'xxxxxxxxxxxxxxxxxxxx' | split: '' | join: 'xxxxxxxxxxxxxxxxxxxx' | split: '' | join: 'xxxxxxxxxxxxxxxxxxxx' }}`))).rejects.toThrow(/filter "split": array too long/);
  });

  it('failing filters: refused filters, a missing asset, a wrong argument — a one-line message out of the worker, no stack', async () => {
    await expect(render(home('{{ site.name | raw }}'))).rejects.toThrow(/not allowed/);
    await expect(render(home('{{ site.name | inspect }}'))).rejects.toThrow(/not allowed/);
    await expect(render(home(`{{ 'css/none.css' | asset_url }}`))).rejects.toThrow(/no asset/);
    await expect(render(home('<a href="{{ list | url }}">x</a>'))).rejects.toThrow(/expects a string/);
    pool = new RenderPool({ workers: 1 });
    const err = (await pool.render(job('a', 'bad-filter:1', home(`{{ 'css/none.css' | asset_url }}`))).catch((e: unknown) => e)) as { code: string; message: string };
    expect(err.message).toMatch(/no asset/);
    // A missing template, named with a path: the message names the template, not a file of the machine.
    const missing = (await pool.render(job('a', 'missing:1', home(`{% include '${dir}/secret' %}`))).catch((e: unknown) => e)) as { message: string };
    for (const m of [err.message, missing.message]) {
      expect(m).not.toMatch(/\n|\.ts:\d+|\.mjs:\d+|node_modules|\bat /);
      expect(m).not.toContain(process.cwd());
      expect(m).not.toContain('FILE-SYSTEM-SECRET');
    }
  });

  it('the template context is the filtered View Model only: no runtime objects, no request, no secrets', async () => {
    for (const name of ['process', 'globalThis', 'global', 'require', 'request', 'env', 'db', 'settings', 'secrets', 'this']) {
      await expect(render(home(`{{ ${name} }}`)), name).rejects.toThrow(/undefined variable/);
    }
    // Whatever a caller attaches beyond the theme contract is refused before rendering, at any depth.
    const extra = (over: object) => ({ ...structuredClone(vms.home), ...over }) as ThemeViewModel;
    for (const vm of [
      extra({ request: { cookie: 'session=SECRET' } }),
      extra({ secrets: { key: 'SECRET' } }),
      extra({ db: { url: 'postgres://SECRET' } }),
      extra({ site: { ...vms.home.site, databaseUrl: 'postgres://SECRET' } }),
    ]) {
      await expect(render(home('{{ site.name }}'), vm)).rejects.toThrow(/does not match the theme contract/);
    }
    // A function is not data: the copy drops it, so it never reaches the template.
    await expect(render(home('{{ site.fn }}'), extra({ site: { ...vms.home.site, fn: () => 'SECRET' } }))).rejects.toThrow(/undefined variable/);
    // The check is on the copy the template gets: a toJSON adding a root after the check is refused.
    const sneaky = { ...structuredClone(vms.home), toJSON() { return { ...structuredClone(vms.home), secrets: { key: 'SECRET' } }; } };
    await expect(render(home('{{ site.name }}'), sneaky as unknown as ThemeViewModel)).rejects.toThrow(/does not match the theme contract/);
    // What the contract has but JSON does not carry (a non-enumerable property) never reaches the template.
    const hidden = structuredClone(vms.home);
    Object.defineProperty(hidden.site, 'name', { value: 'NON-ENUMERABLE', enumerable: false });
    await expect(render(home('{{ site.name }}'), hidden)).rejects.toThrow(/does not match the theme contract/);
  });

  it('template cache: versions with the same template names never share an engine — across sites, and across asset bases', async () => {
    pool = new RenderPool({ workers: 1 });
    const alpha = home('<p>ALPHA-THEME</p>');
    const beta = home('<p>BETA-THEME</p>');
    // One worker, so one engine cache: interleaved renders of the two sites' versions.
    const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => pool!.render(job(i % 2 ? 'site-a' : 'site-b', i % 2 ? 'version-a' : 'version-b', i % 2 ? alpha : beta))));
    outs.forEach((html, i) => {
      expect(html).toContain(i % 2 ? 'ALPHA-THEME' : 'BETA-THEME');
      expect(html).not.toContain(i % 2 ? 'BETA-THEME' : 'ALPHA-THEME');
    });
    // A version rendered on the public site and in a preview: each with its own asset URLs.
    const asset = { path: 'css/site.css', sha256: 'a'.repeat(64), contentType: 'text/css', size: 1 };
    const styled = home(`<link rel="stylesheet" href="{{ 'css/site.css' | asset_url }}">`);
    const pub = await pool.render({ ...job('site-a', 'version-s', styled), assets: [asset] });
    const pre = await pool.render({ ...job('site-a', 'version-s', styled), assets: [asset], assetBase: '/site-a/_theme/' });
    expect(pub).toContain(`href="/_theme/version-s/${'a'.repeat(64)}.css"`);
    expect(pre).toContain(`href="/site-a/_theme/version-s/${'a'.repeat(64)}.css"`);
  });
});
