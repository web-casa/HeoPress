import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { bundle, manifestIsCurrent } from '../../scripts/build.mjs';

type Manifest = {
  name: string;
  version: string;
  collections: Array<{ name: string; label?: string; fields: Array<{ name: string; hidden?: boolean }> }>;
  routes: Array<{ id: string; kind: string; path: string; collection: string }>;
  templates: { classic: Record<string, string>; astro: Record<string, string> };
  structuredData: Array<{ key: string; scope: string; collections: string[]; node: Record<string, unknown> }>;
  gateChecks: Array<{ id: string; collections: string[] }>;
  storage: Record<string, { indexes: string[][] }>;
  admin?: { pages: Array<{ id: string; type: string }>; settings: Array<{ key: string }> };
  capabilities: string[];
  prePublishHooks?: unknown;
};

const manifest = async (): Promise<Manifest> => JSON.parse(await readFile(new URL('../../heopress-extension.json', import.meta.url), 'utf8')) as Manifest;

describe('the corrections plugin package', () => {
  it('heopress-extension.json carries the sources of templates/ (run node scripts/build.mjs)', async () => {
    expect(await manifestIsCurrent()).toBe(true);
  });

  it('the bundle is one ES module with no import at run time', async () => {
    const code = await bundle();
    expect(code).toMatch(/export\s*\{[^}]*\bas default\b/);
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it('the sources import nothing but the Extension SDK and themselves', async () => {
    for (const file of ['index.ts', 'report.ts', 'marker.ts', 'notice.ts', 'gate.ts']) {
      const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) expect(m[1], file).toMatch(/^(@heopress\/extension-sdk|\.\/[a-z-]+)$/);
    }
  });

  it('declares two namespaced collections: the private queue and the public notices', async () => {
    const m = await manifest();
    expect(m.name).toBe('heopress-corrections');
    expect(m.collections.map((c) => c.name)).toEqual(['reports', 'notices']);
    const reports = m.collections[0]!;
    for (const field of ['comment', 'reporter_name', 'reporter_email']) {
      expect(reports.fields.find((f) => f.name === field)?.hidden, field).toBe(true);
    }
    // No route ever publishes a report: the queue is not content.
    expect(m.routes.some((r) => r.collection === 'reports')).toBe(false);
    expect(m.routes.map((r) => `${r.kind} ${r.path}`)).toEqual(['item /corrections/:slug', 'list /corrections']);
    for (const engine of ['classic', 'astro'] as const) {
      expect(Object.keys(m.templates[engine]).sort()).toEqual(['index', 'notice']);
    }
  });

  it('declares the correction-node structured data, the gate check and the body-writing setting', async () => {
    const m = await manifest();
    expect(m.structuredData).toEqual([
      expect.objectContaining({
        key: 'notice',
        scope: 'item',
        collections: ['heopress_corrections__notices'],
        node: expect.objectContaining({ '@type': 'CorrectionComment', text: { $field: 'correction' } }),
      }),
    ]);
    expect(m.gateChecks).toEqual([expect.objectContaining({ id: 'notice-links', collections: ['articles'] })]);
    expect(m.admin?.settings.map((s) => s.key)).toEqual(['write_body', 'marker_label']);
    expect(m.admin?.pages.map((p) => `${p.type}:${p.id}`)).toEqual(['table:decisions', 'settings:settings']);
    expect(m.storage['decisions']?.indexes).toEqual([['report'], ['notice']]);
  });

  it('declares no pre-publish hook: a bundle that fails to load never blocks article publishing', async () => {
    const m = await manifest();
    expect(m.prePublishHooks).toBeUndefined();
    const src = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('definePrePublishHook');
  });

  it('asks for the capabilities each extension point needs, and publishes the notices only', async () => {
    const m = await manifest();
    for (const capability of [
      'ext:collections',
      'ext:routes',
      'ext:endpoints',
      'ext:events',
      'ext:gate-checks',
      'ext:admin-panels',
      'items:read:articles',
      'items:write:articles',
      'items:publish:articles',
      'items:read:heopress_corrections__notices',
      'items:write:heopress_corrections__notices',
      'cdc:subscribe:heopress_corrections__reports',
      'cdc:subscribe:heopress_corrections__notices',
      'seo:structured-data',
    ]) {
      expect(m.capabilities, capability).toContain(capability);
    }
    // The report collection is written and read, never published by the plugin.
    expect(m.capabilities).not.toContain('items:publish:heopress_corrections__reports');
    expect(m.capabilities).not.toContain('items:publish:heopress_corrections__notices');
  });
});
