import { describe, expect, it } from 'vitest';
import { prePublishDeclarationIssues, prePublishHookCovers, prePublishHooksOf } from '@heopress/contracts/extensions';
import { ExtensionManifestSchema, ManifestDeclarationsSchema } from '@heopress/contracts/schemas';

/**
 * Pre-publish hook declarations, statically (HeoPress P12 task 3.4, narrowed 2026-10-28): a plugin names the hooks it
 * registers in `prePublishHooks` (with `ext:events`); names are runtime names and unique; the collections narrow what a
 * failed load blocks.
 */
const manifest = (over: Record<string, unknown>) => ({ name: 'acme-guard', version: '1.0.0', type: 'hook', entry: 'dist/index.js', ...over });

describe('prePublishHooks in the manifest', () => {
  it('needs ext:events and unique names', () => {
    const decl = { prePublishHooks: [{ name: 'require-summary' }] };
    expect(prePublishDeclarationIssues(decl, [])).toEqual([{ path: 'prePublishHooks', message: 'prePublishHooks need the ext:events capability' }]);
    expect(prePublishDeclarationIssues(decl, ['ext:events'])).toEqual([]);
    expect(prePublishDeclarationIssues({ prePublishHooks: [{ name: 'a' }, { name: 'a' }] }, ['ext:events'])).toEqual([{ path: 'prePublishHooks', message: 'hook names repeat' }]);
    expect(prePublishDeclarationIssues({}, [])).toEqual([]);
  });

  it('the manifest schema validates the declaration', () => {
    expect(ExtensionManifestSchema.safeParse(manifest({ capabilities: ['ext:events'], prePublishHooks: [{ name: 'require-summary', collections: ['articles'] }] })).success).toBe(true);
    const missing = ExtensionManifestSchema.safeParse(manifest({ capabilities: [], prePublishHooks: [{ name: 'require-summary' }] }));
    expect(missing.success).toBe(false);
    expect(JSON.stringify(missing.error?.issues)).toContain('ext:events');
    // Names are runtime names; collections are machine names, at least one when given.
    expect(ExtensionManifestSchema.safeParse(manifest({ capabilities: ['ext:events'], prePublishHooks: [{ name: 'Require Summary' }] })).success).toBe(false);
    expect(ExtensionManifestSchema.safeParse(manifest({ capabilities: ['ext:events'], prePublishHooks: [{ name: 'x', collections: [] }] })).success).toBe(false);
    expect(ExtensionManifestSchema.safeParse(manifest({ capabilities: ['ext:events'], prePublishHooks: [{ name: 'x', collections: ['Articles'] }] })).success).toBe(false);
    // An install or upgrade request may carry it next to the capabilities.
    expect(ManifestDeclarationsSchema.safeParse({ prePublishHooks: [{ name: 'x' }] }).success).toBe(true);
  });

  it('reads stored manifests defensively and covers collections', () => {
    expect(prePublishHooksOf({ prePublishHooks: 'nope' })).toEqual([]);
    expect(prePublishHooksOf(null)).toEqual([]);
    expect(prePublishHooksOf({})).toEqual([]);
    const [all, some] = prePublishHooksOf({ prePublishHooks: [{ name: 'all' }, { name: 'some', collections: ['pages'] }] });
    expect(prePublishHookCovers(all!, 'articles')).toBe(true);
    expect(prePublishHookCovers(some!, 'articles')).toBe(false);
    expect(prePublishHookCovers(some!, 'pages')).toBe(true);
  });
});
