import { describe, expect, it } from 'vitest';
import {
  extensionNamespace,
  parsePluginCollectionName,
  parseRoutePath,
  pluginCollectionName,
  routePathsOverlap,
  templateSourceProblems,
} from '@heopress/contracts/extensions';
import { ExtensionManifestSchema } from '@heopress/contracts/schemas';
import { checkTheme, BUILTIN_THEME, extensionStubs } from '@heopress/public-site';
import { contentManifestIssues } from '../../services/extensions/content-extensions';
import { GLOSSARY, GLOSSARY_CAPABILITIES, glossaryManifest } from '../../__tests__/helpers/glossary-plugin';

/**
 * Content extensions, statically (HeoPress P12 tasks 2.1–2.5; spec extensions/content-extensions): the namespace of a
 * plugin's collections, route paths and their overlaps, each extension point behind its capability, and the template
 * rules — a plugin writes no JSON-LD, script, canonical or robots tag, and its components place no head or body.
 */
const issues = (manifest: Record<string, unknown>, capabilities = GLOSSARY_CAPABILITIES, name = GLOSSARY) => contentManifestIssues(name, manifest, capabilities);

describe('plugin collection names (task 2.1)', () => {
  it('namespaces a plugin\'s collections; two plugins never share one', () => {
    expect(extensionNamespace('acme/glossary')).toBe('acme_glossary');
    expect(extensionNamespace('acme-glossary')).toBe('acme_glossary');
    expect(extensionNamespace('@acme/Glossary')).toBe('acme_glossary');
    expect(extensionNamespace('9lives')).toBeNull();
    expect(pluginCollectionName('acme_glossary', 'terms')).toBe('acme_glossary__terms');
    expect(pluginCollectionName('beta_glossary', 'terms')).not.toBe(pluginCollectionName('acme_glossary', 'terms'));
    expect(parsePluginCollectionName('acme_glossary__terms')).toEqual({ namespace: 'acme_glossary', collection: 'terms' });
    expect(parsePluginCollectionName('articles')).toBeNull();
  });
});

describe('route paths (task 2.2)', () => {
  it('parses literal segments, an item route ending in :slug', () => {
    expect(parseRoutePath('/glossary/:slug', 'item')).toMatchObject({ path: '/glossary/:slug' });
    expect(parseRoutePath('/glossary', 'list')).toMatchObject({ path: '/glossary' });
    expect(parseRoutePath('/glossary', 'item')).toHaveProperty('error');
    expect(parseRoutePath('/:slug/x', 'item')).toHaveProperty('error');
    expect(parseRoutePath('/Glossary', 'list')).toHaveProperty('error');
  });
  it('overlaps: the same list path, an item route over a literal path', () => {
    expect(routePathsOverlap({ path: '/glossary', kind: 'list' }, { path: '/glossary', kind: 'list' })).toBe(true);
    expect(routePathsOverlap({ path: '/glossary/:slug', kind: 'item' }, { path: '/glossary/a-z', kind: 'list' })).toBe(true);
    expect(routePathsOverlap({ path: '/glossary/:slug', kind: 'item' }, { path: '/glossary', kind: 'list' })).toBe(false);
    expect(routePathsOverlap({ path: '/glossary/:slug', kind: 'item' }, { path: '/terms/:slug', kind: 'item' })).toBe(false);
  });
});

describe('manifest declarations', () => {
  it('the glossary plugin passes', () => {
    expect(issues(glossaryManifest())).toEqual([]);
    expect(ExtensionManifestSchema.safeParse({ name: GLOSSARY, version: '1.0.0', type: 'hook', entry: 'dist/index.js', capabilities: GLOSSARY_CAPABILITIES, ...glossaryManifest() }).success).toBe(true);
  });

  it('each extension point needs its capability', () => {
    expect(issues(glossaryManifest(), ['ext:routes'])).toContainEqual(expect.stringMatching(/collections need the ext:collections capability/));
    expect(issues(glossaryManifest(), ['ext:collections'])).toContainEqual(expect.stringMatching(/need the ext:routes capability/));
    const componentsOnly = { components: glossaryManifest().components };
    expect(issues(componentsOnly, [])).toContainEqual(expect.stringMatching(/components: .*ext:routes/));
    expect(issues(componentsOnly, ['ext:routes'])).toEqual([]);
    const parsed = ExtensionManifestSchema.safeParse({ name: GLOSSARY, version: '1.0.0', type: 'hook', entry: 'dist/index.js', capabilities: ['ext:routes'], ...glossaryManifest() });
    expect(parsed.success).toBe(false);
  });

  it('a route names one of the plugin\'s own collections and a template both engines have', () => {
    const m = glossaryManifest();
    const routes = [{ id: 'x', kind: 'list', path: '/x', collection: 'articles', template: 'index' }];
    expect(issues({ ...m, routes })).toContainEqual(expect.stringMatching(/"articles" is not one of the plugin's collections/));
    const templates = { classic: (m.templates as { classic: object }).classic, astro: {} };
    expect(issues({ ...m, templates })).toContainEqual(expect.stringMatching(/no Astro template "term"/));
    const overlapping = [...(m.routes as object[]), { id: 'again', kind: 'list', path: '/glossary', collection: 'terms', template: 'index' }];
    expect(issues({ ...m, routes: overlapping })).toContainEqual(expect.stringMatching(/overlaps route index/));
  });

  it('task 9.1: an item route\'s Classic template places {% item_body %} exactly once, like the theme\'s item page (else every page of it would fail to render)', () => {
    const m = glossaryManifest() as { templates: { classic: Record<string, string>; astro: Record<string, string> } };
    const without = { ...m.templates.classic, term: m.templates.classic.term!.replace('{% item_body %}', '') };
    expect(issues({ ...m, templates: { ...m.templates, classic: without } })).toContainEqual(expect.stringMatching(/ext\/acme_glossary\/term: must output \{% item_body %\} exactly once/));
    const twice = { ...m.templates.classic, term: m.templates.classic.term!.replace('{% item_body %}', '{% item_body %}{% item_body %}') };
    expect(issues({ ...m, templates: { ...m.templates, classic: twice } })).toContainEqual(expect.stringMatching(/must output \{% item_body %\} exactly once/));
    // A list route's template renders no single item.
    expect(issues(m)).toEqual([]);
  });

  it('task 2.5: a plugin writing its own JSON-LD, a script, a canonical or robots tag is refused (both engines)', () => {
    const m = glossaryManifest() as { templates: { classic: Record<string, string>; astro: Record<string, string> } };
    const ld = '<script type="application/ld+json">{"@type":"Thing"}</script>';
    const classic = { ...m.templates.classic, term: m.templates.classic.term!.replace('</body>', `${ld}</body>`) };
    expect(issues({ ...m, templates: { ...m.templates, classic } }).join('\n')).toMatch(/JSON-LD/);
    const astro = { ...m.templates.astro, term: m.templates.astro.term!.replace('</body>', `${ld}</body>`) };
    expect(issues({ ...m, templates: { ...m.templates, astro } }).join('\n')).toMatch(/JSON-LD/);
    for (const bad of ['<link rel="canonical" href="https://example.com/">', '<meta name="robots" content="noindex">', '<script>alert(1)</script>', '<a href="#" onclick="x()">x</a>']) {
      expect(templateSourceProblems(`<p>${bad}</p>`, 'classic', true).length, bad).toBeGreaterThan(0);
    }
    expect(templateSourceProblems('<p set:html={x}></p>', 'astro', true).length).toBeGreaterThan(0);
  });

  it('task 2.4: a component is a fragment: no head, no body; it reads the page data contract only', () => {
    const m = glossaryManifest();
    const head = { badge: { classic: '{% seo_head %}', astro: '<span />' } };
    expect(issues({ ...m, components: head }).join('\n')).toMatch(/places the page head or body|places neither/);
    const outside = { badge: { classic: '{{ secrets.key }}', astro: '<span />' } };
    expect(issues({ ...m, components: outside }).join('\n')).toMatch(/not in the page data contract/);
    const page = { badge: { classic: '<span />', astro: '<html><body></body></html>' } };
    expect(issues({ ...m, components: page }).length).toBeGreaterThan(0);
  });

  it('task 2.3/2.4: an Astro source may import the kit and plugin components only; no environment, network or hydration', () => {
    const src = (body: string, imports = '') => `---\n${imports}\n---\n${body}`;
    expect(templateSourceProblems(src('<span />', "import fs from 'node:fs';"), 'astro', true)).toContainEqual(expect.stringMatching(/imports something other/));
    expect(templateSourceProblems(src('<span />', "import B from 'heopress:ext/acme_glossary/badge';"), 'astro', true)).toEqual([]);
    expect(templateSourceProblems(src('{process.env.SECRET}'), 'astro', true)).toContainEqual(expect.stringMatching(/environment/));
    expect(templateSourceProblems(src('{await fetch("https://example.com")}'), 'astro', true)).toContainEqual(expect.stringMatching(/network/));
    expect(templateSourceProblems(src('<B client:load />'), 'astro', true)).toContainEqual(expect.stringMatching(/hydrates/));
    expect(templateSourceProblems(src('<html><body /></html>', "import B from '@heopress/astro-kit/Card.astro';"), 'astro', false)).toContainEqual(expect.stringMatching(/system head/));
  });
});

describe('themes and plugin templates (tasks 2.3, 2.4)', () => {
  const top = BUILTIN_THEME['partials/top']!;
  const bottom = BUILTIN_THEME['partials/bottom']!;
  it('a theme placing a plugin component passes without it: the missing component is an empty template', () => {
    const theme = { ...BUILTIN_THEME, item: `${top}{% item_body %}{% include 'ext/acme_glossary/components/badge' %}${bottom}` };
    expect(checkTheme(theme)).toEqual([]);
    expect(extensionStubs(theme)).toEqual({ 'ext/acme_glossary/components/badge': '' });
    expect(extensionStubs(theme, { 'ext/acme_glossary/components/badge': '<span></span>' })).toEqual({});
  });
  it('a theme\'s override of a plugin route template is checked as a page', () => {
    expect(checkTheme({ ...BUILTIN_THEME, 'ext/acme_glossary/term': `${top}<h1>{{ item.title }}</h1>${bottom}` })).toEqual([]);
    const noHead = checkTheme({ ...BUILTIN_THEME, 'ext/acme_glossary/term': '<p>{{ item.title }}</p>' });
    expect(noHead.map((i) => `${i.template}: ${i.message}`)).toContainEqual(expect.stringMatching(/ext\/acme_glossary\/term: must output \{% seo_head %\}/));
  });
});
