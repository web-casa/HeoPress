/**
 * The briefing-section contribution point (HeoPress v1.1, spec extensions/briefing-sections): the manifest declaration
 * and its capability, the payload a section may answer, and the isolation of one section's failure from the others.
 *
 * The endpoint and the load path are exercised against a real database in
 * `apps/cms/src/__tests__/plugin-briefing.db.integration.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { BRIEFING_LIMITS, EXTENSION_POINT_VERSIONS, EXTENSION_POINTS, briefingDeclarationIssues, briefingSectionsOf, parseCapability, validateCapabilities } from '@heopress/contracts/extensions';
import { BriefingSectionPayloadSchema } from '@heopress/contracts/extensions';
import { ExtensionManifestSchema } from '@heopress/contracts/schemas';
import { PluginBriefing } from '../runtime/briefing-sections';
import type { LoadedPlugin, PluginHost } from '../runtime/plugin-host';

const base = {
  name: 'heopress-briefing-stale-drafts',
  version: '1.0.0',
  type: 'module',
  entry: './dist/index.js',
  heopress: '^1.0.0-0',
  security: { contact: 'security@example.com' },
};

/** A manifest declaring one section, with the capability and the ranges it needs. */
const manifest = (over: Record<string, unknown> = {}) => ({
  ...base,
  capabilities: ['ext:briefing-sections', 'items:read:articles'],
  extensionPoints: { 'briefing-sections': '^1.0.0', context: '^1.0.0' },
  briefingSections: [{ id: 'stale-drafts', title: 'Stale drafts' }],
  ...over,
});

describe('briefing sections: the contribution contract', () => {
  it('is an extension point of its own, with a contract version', () => {
    expect(EXTENSION_POINTS).toContain('briefing-sections');
    expect(EXTENSION_POINT_VERSIONS['briefing-sections']).toBe('1.0.0');
    expect(parseCapability('ext:briefing-sections')).toMatchObject({ category: 'extension-point', target: 'briefing-sections' });
    expect(validateCapabilities(['ext:briefing-sections']).errors).toEqual([]);
  });

  it('a manifest that declares a section and holds the capability is valid', () => {
    const parsed = ExtensionManifestSchema.parse(manifest());
    expect(parsed.briefingSections).toEqual([{ id: 'stale-drafts', title: 'Stale drafts' }]);
    expect(briefingSectionsOf(parsed)).toEqual([{ id: 'stale-drafts', title: 'Stale drafts' }]);
  });

  it('a declared section without ext:briefing-sections is refused', () => {
    const parsed = ExtensionManifestSchema.safeParse(manifest({ capabilities: ['items:read:articles'], extensionPoints: { context: '^1.0.0' } }));
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.some((i) => i.path.join('.') === 'briefingSections' && /ext:briefing-sections/.test(i.message))).toBe(true);
    expect(briefingDeclarationIssues({ briefingSections: [{ id: 'stale-drafts', title: 'Stale drafts' }] }, ['items:read:articles'])).toEqual([
      { path: 'briefingSections', message: 'briefing sections need the ext:briefing-sections capability' },
    ]);
  });

  it('refuses a repeated id, a malformed id, an over-long title and more sections than the limit', () => {
    const invalid = [
      // A repeated id: the bundle registers one section per id, so two declarations cannot be told apart.
      { briefingSections: [{ id: 'stale-drafts', title: 'A' }, { id: 'stale-drafts', title: 'B' }] },
      { briefingSections: [{ id: 'Stale Drafts', title: 'A' }] },
      { briefingSections: [{ id: 'ok', title: 'x'.repeat(BRIEFING_LIMITS.titleChars + 1) }] },
      { briefingSections: Array.from({ length: BRIEFING_LIMITS.sections.max + 1 }, (_, i) => ({ id: `section-${i}`, title: 'x' })) },
    ];
    for (const over of invalid) {
      const parsed = ExtensionManifestSchema.safeParse(manifest(over));
      expect(parsed.success, JSON.stringify(over).slice(0, 80)).toBe(false);
    }
  });

  it('the example plugin shipped with the repository declares its section', () => {
    // The example is the worked example of this page: if it stops being a valid declaration, the docs lie.
    const path = fileURLToPath(new URL('../../../../../examples/plugin-briefing-stale-drafts/heopress-extension.json', import.meta.url));
    const parsed = ExtensionManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(parsed.name).toBe('example-briefing-stale-drafts');
    expect(parsed.capabilities).toContain('ext:briefing-sections');
    expect(briefingSectionsOf(parsed)).toEqual([
      { id: 'stale-drafts', title: 'Stale drafts', description: 'Drafts not touched for 14 days' },
    ]);
  });

  it('a stored manifest with a malformed declaration contributes no section', () => {
    expect(briefingSectionsOf({ briefingSections: 'nope' })).toEqual([]);
    expect(briefingSectionsOf({ briefingSections: [{ id: 'X', title: '' }] })).toEqual([]);
    expect(briefingSectionsOf(null)).toEqual([]);
  });

  it('the payload is a count and at most ten site-relative links', () => {
    expect(BriefingSectionPayloadSchema.parse({ count: 3, items: [{ label: 'Draft', href: '/content/articles/a1' }] })).toEqual({
      count: 3,
      items: [{ label: 'Draft', href: '/content/articles/a1' }],
    });
    // A count alone is a valid answer: the Studio may show the number without links.
    expect(BriefingSectionPayloadSchema.parse({ count: 2 })).toEqual({ count: 2, items: [] });
    const refused = [
      {},
      { count: -1 },
      { count: 1.5 },
      { count: 1, items: [{ label: 'A', href: 'https://example.com/x' }] },
      { count: 1, items: [{ label: 'A', href: '//example.com/x' }] },
      { count: 1, items: [{ label: 'A', href: 'content/a' }] },
      { count: 1, items: [{ label: 'x'.repeat(BRIEFING_LIMITS.labelChars + 1), href: '/a' }] },
      { count: 1, items: Array.from({ length: BRIEFING_LIMITS.items.max + 1 }, () => ({ label: 'A', href: '/a' })) },
    ];
    for (const payload of refused) expect(BriefingSectionPayloadSchema.safeParse(payload).success, JSON.stringify(payload).slice(0, 80)).toBe(false);
  });
});

describe('briefing sections: one section cannot take the others down', () => {
  const section = (id: string, compute: LoadedPlugin['briefingSections'][number]['compute'], over: Partial<LoadedPlugin['briefingSections'][number]> = {}) => ({
    id,
    title: id,
    description: null,
    durationMs: 200,
    maxRequests: 5,
    compute,
    ...over,
  });
  const plugin = (name: string, sections: LoadedPlugin['briefingSections'], displayName?: string): LoadedPlugin =>
    ({
      row: { name, manifest: displayName ? { displayName } : {} },
      siteId: 'site-a',
      name,
      capabilities: ['ext:briefing-sections'],
      module: {},
      briefingSections: sections,
    }) as unknown as LoadedPlugin;
  const briefing = (plugins: LoadedPlugin[]) =>
    new PluginBriefing({ loadAll: async () => plugins } as unknown as PluginHost);

  it('returns the sections of the site with their computed payload', async () => {
    const sections = await briefing([
      plugin('stale-drafts', [section('stale-drafts', async () => ({ count: 2, items: [{ label: 'Draft', href: '/content/articles/a1' }] }))], 'Stale drafts'),
      plugin('review', [section('due', () => ({ count: 0 }))]),
    ]).list('site-a');
    expect(sections).toEqual([
      { plugin: 'stale-drafts', pluginName: 'Stale drafts', id: 'stale-drafts', title: 'stale-drafts', description: null, count: 2, items: [{ label: 'Draft', href: '/content/articles/a1' }] },
      { plugin: 'review', pluginName: 'review', id: 'due', title: 'due', description: null, count: 0, items: [] },
    ]);
  });

  it('leaves out a section that throws, answers outside the contract or never answers, keeping the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sections = await briefing([
        plugin('broken', [
          section('throws', () => {
            throw new Error('boom');
          }),
          section('invalid', () => ({ count: 1, items: [{ label: 'A', href: 'https://example.com/evil' }] })),
          section('hangs', () => new Promise(() => undefined)),
          section('fine', () => ({ count: 1 })),
        ]),
        plugin('other', [section('also-fine', async () => ({ count: 7 }))]),
      ]).list('site-a');
      expect(sections.map((s) => `${s.plugin}/${s.id}`)).toEqual(['broken/fine', 'other/also-fine']);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
