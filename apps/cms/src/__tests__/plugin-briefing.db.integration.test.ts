/**
 * Briefing sections (HeoPress v1.1, spec extensions/briefing-sections): a plugin that declares a section and registers it
 * is listed with its computed count and links; a registration the manifest does not declare is refused and recorded; a
 * section of another site never appears; and one plugin's failing or never-answering section leaves the others intact.
 *
 * The cells here back the `briefing-sections` rows of the extension-point matrix (`helpers/extension-matrix.ts`); the
 * contract-version cell lives in `extension-matrix.db.integration.test.ts` (`versionCell`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { auditLog, extensions, sites, type Database } from '@heopress/database';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { ExtensionSandbox } from '../extensions/sandbox';
import { PluginHost } from '../extensions/runtime/plugin-host';
import { PluginBriefing } from '../extensions/runtime/briefing-sections';

const A = 'site_v11_briefing_a';
const B = 'site_v11_briefing_b';
const ENV = { HEOPRESS_ENV: 'development', HEOPRESS_VERSION: '1.2.0' } as Record<string, unknown>;

/** One registered section: its id and the body of its `compute`. */
interface Registration {
  id: string;
  compute: string;
  title?: string;
  maxDurationMs?: number;
}

/** A bundle that registers `sections` on the briefing extension point and exports nothing else. */
function bundle(sections: Registration[]): string {
  const body = sections
    .map(
      (s) =>
        `ctx.extensionPoints.register('briefing-sections', { id: ${JSON.stringify(s.id)}, compute: ${s.compute}` +
        `${s.title ? `, title: ${JSON.stringify(s.title)}` : ''}` +
        `${s.maxDurationMs ? `, maxDurationMs: ${s.maxDurationMs}` : ''} });`,
    )
    .join('\n');
  return `data:text/javascript,${encodeURIComponent(`export default (ctx) => {\n${body}\nreturn {};\n}`)}`;
}

const SECTION_MANIFEST = {
  displayName: 'Stale drafts',
  briefingSections: [
    { id: 'stale-drafts', title: '待处理的过期草稿', description: '超过 14 天没有更新的草稿' },
    // Declared but never registered by the bundle: it simply does not appear.
    { id: 'never-registered', title: 'Never registered' },
  ],
};

describe.skipIf(!hasDbIntegrationUrl)('v1.1 briefing sections — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  beforeAll(async () => {
    db = await connectDbIntegration('v11-briefing');
    fixtures = await connectDbFixtures('v11-briefing');
    // Data URLs are the tests' bundles; production loads only the trusted bundle origins.
    vi.spyOn(ExtensionSandbox.prototype as unknown as { isTrustedBundleUrl(url: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (fixtures) {
      await fixtures.delete(auditLog).where(inArray(auditLog.siteId, [A, B]));
      await fixtures.delete(extensions).where(inArray(extensions.siteId, [A, B]));
      await fixtures.delete(sites).where(inArray(sites.id, [A, B]));
    }
  });
  beforeEach(async () => {
    await fixtures.delete(auditLog).where(inArray(auditLog.siteId, [A, B]));
    await fixtures.delete(extensions).where(inArray(extensions.siteId, [A, B]));
    await fixtures.delete(sites).where(inArray(sites.id, [A, B]));
    for (const id of [A, B]) await fixtures.insert(sites).values({ id, name: id });
  });

  /** A plugin row as installed and approved (the install path is exercised by the P12 suites). */
  async function install(
    siteId: string,
    name: string,
    options: {
      bundleUrl: string;
      manifest?: Record<string, unknown>;
      capabilities?: string[];
      enabled?: boolean;
      permissionsStatus?: string;
    },
  ) {
    const capabilities = options.capabilities ?? ['ext:briefing-sections'];
    const [row] = await fixtures
      .insert(extensions)
      .values({
        siteId,
        name,
        key: name.replace(/[^a-z0-9]+/g, '_'),
        version: '1.0.0',
        type: 'module',
        enabled: options.enabled ?? true,
        bundleUrl: options.bundleUrl,
        manifest: options.manifest ?? {},
        capabilities,
        requestedCapabilities: capabilities,
        permissionsStatus: options.permissionsStatus ?? 'approved',
      })
      .returning();
    return row!;
  }

  /** The briefing of `site`, as the endpoint computes it. */
  const briefing = (site: string) => new PluginBriefing(new PluginHost({ db, env: ENV })).list(site);
  const denials = async (site: string) =>
    (await fixtures.select().from(auditLog).where(and(eq(auditLog.siteId, site), eq(auditLog.event, 'extension_capability_denied')))).map(
      (r) => r.metadata as Record<string, unknown>,
    );

  it('9.1 briefing-sections × declared: a declared, registered section is listed with its computed count and links', async () => {
    await install(A, 'stale-drafts', {
      manifest: SECTION_MANIFEST,
      bundleUrl: bundle([
        { id: 'stale-drafts', compute: `async () => ({ count: 2, items: [{ label: 'Draft one', href: '/content/articles/a1' }] })` },
        // Registering the same id twice keeps the first; the second is a problem, not a second section.
        { id: 'stale-drafts', compute: `() => ({ count: 99 })` },
      ]),
    });

    const sections = await briefing(A);
    expect(sections).toEqual([
      {
        plugin: 'stale-drafts',
        pluginName: 'Stale drafts',
        id: 'stale-drafts',
        title: '待处理的过期草稿',
        description: '超过 14 天没有更新的草稿',
        count: 2,
        items: [{ label: 'Draft one', href: '/content/articles/a1' }],
      },
    ]);
    // A declared section the bundle did not register is not invented.
    expect(sections.map((s) => s.id)).not.toContain('never-registered');
  });

  it('9.1 briefing-sections × undeclared: a section without the capability is not listed, and one the manifest does not declare is refused and recorded', async () => {
    // No ext:briefing-sections: the section is registered in the bundle, and still never loaded.
    await install(A, 'no-point', {
      capabilities: ['items:read:articles'],
      manifest: { briefingSections: [{ id: 'stale-drafts', title: 'Stale drafts' }] },
      bundleUrl: bundle([{ id: 'stale-drafts', compute: `() => ({ count: 5 })` }]),
    });
    // The capability, but a registration under an id the admin never approved.
    await install(A, 'extra-section', {
      manifest: { briefingSections: [{ id: 'declared', title: 'Declared' }] },
      bundleUrl: bundle([
        // The registration may override the declared title; the section still appears once, under this instance.
        { id: 'declared', title: 'Declared (registered)', compute: `() => ({ count: 1 })` },
        { id: 'sneaky', compute: `() => ({ count: 9 })` },
      ]),
    });

    const sections = await briefing(A);
    expect(sections.map((s) => `${s.plugin}/${s.id}`)).toEqual(['extra-section/declared']);
    expect(sections[0]!.title).toBe('Declared (registered)');
    expect(await denials(A)).toContainEqual(
      expect.objectContaining({ extensionName: 'extra-section', capability: 'briefingSections:sneaky', operation: 'register:briefing-sections' }),
    );
  });

  it("9.1 briefing-sections × cross-site: a plugin's sections are its own site's; another site's are never asked", async () => {
    await install(A, 'stale-drafts', {
      manifest: SECTION_MANIFEST,
      bundleUrl: bundle([{ id: 'stale-drafts', compute: `() => ({ count: 3, items: [{ label: 'A draft', href: '/content/articles/a1' }] })` }]),
    });
    await install(B, 'stale-drafts', {
      manifest: SECTION_MANIFEST,
      bundleUrl: bundle([{ id: 'stale-drafts', compute: `() => ({ count: 1, items: [{ label: 'B draft', href: '/content/articles/b1' }] })` }]),
    });
    await install(B, 'only-b', {
      manifest: { briefingSections: [{ id: 'only-b', title: 'Only B' }] },
      bundleUrl: bundle([{ id: 'only-b', compute: `() => ({ count: 42 })` }]),
    });

    const pairs = async (site: string) => (await briefing(site)).map((s) => [s.plugin, s.count]).sort();
    expect(await pairs(A)).toEqual([['stale-drafts', 3]]);
    expect(await pairs(B)).toEqual([
      ['only-b', 42],
      ['stale-drafts', 1],
    ]);
  });

  it('9.1 briefing-sections × isolation: a throwing, invalid or never-answering section is left out; the others are returned', async () => {
    await install(A, 'flaky', {
      manifest: {
        briefingSections: [
          { id: 'throws', title: 'Throws' },
          { id: 'invalid', title: 'Invalid' },
          { id: 'hangs', title: 'Hangs' },
          { id: 'fine', title: 'Fine' },
        ],
      },
      bundleUrl: bundle([
        { id: 'throws', compute: `() => { throw new Error('boom'); }` },
        { id: 'invalid', compute: `() => ({ count: 1, items: [{ label: 'A', href: 'https://example.com/evil' }] })` },
        // Runs out of its 100 ms budget; the request does not wait for it.
        { id: 'hangs', compute: `() => new Promise(() => {})`, maxDurationMs: 100 },
        { id: 'fine', compute: `async () => ({ count: 4, items: [{ label: 'Fine', href: '/content/articles/a1' }] })` },
      ]),
    });
    await install(A, 'steady', {
      manifest: { briefingSections: [{ id: 'steady', title: 'Steady' }] },
      bundleUrl: bundle([{ id: 'steady', compute: `() => ({ count: 1 })` }]),
    });
    // Neither a disabled nor a plugin awaiting re-confirmation contributes.
    await install(A, 'disabled', {
      manifest: { briefingSections: [{ id: 'disabled', title: 'Disabled' }] },
      enabled: false,
      bundleUrl: bundle([{ id: 'disabled', compute: `() => ({ count: 8 })` }]),
    });
    await install(A, 'reconfirm', {
      manifest: { briefingSections: [{ id: 'reconfirm', title: 'Reconfirm' }] },
      permissionsStatus: 'reconfirm',
      bundleUrl: bundle([{ id: 'reconfirm', compute: `() => ({ count: 8 })` }]),
    });

    const started = Date.now();
    const sections = await briefing(A);
    expect(sections.map((s) => `${s.plugin}/${s.id}`)).toEqual(['flaky/fine', 'steady/steady']);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("9.1 briefing-sections × isolation: a plugin whose bundle does not load does not take the other plugins' sections down", async () => {
    await install(A, 'unloadable', {
      manifest: { briefingSections: [{ id: 'broken', title: 'Broken' }] },
      bundleUrl: 'data:text/javascript,export%20default%20(%20%3D%3E%20%7B',
    });
    await install(A, 'steady', {
      manifest: { briefingSections: [{ id: 'steady', title: 'Steady' }] },
      bundleUrl: bundle([{ id: 'steady', compute: `() => ({ count: 2 })` }]),
    });

    expect((await briefing(A)).map((s) => `${s.plugin}/${s.id}`)).toEqual(['steady/steady']);
  });
});
