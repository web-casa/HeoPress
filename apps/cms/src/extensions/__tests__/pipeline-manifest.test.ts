import { describe, expect, it } from 'vitest';
import {
  isPluginGateRule,
  parseCapability,
  parseSourceAdapterRef,
  pipelineDeclarationIssues,
  pipelineDeclarationsOf,
  pluginGateRule,
  sourceAdapterRef,
} from '@heopress/contracts/extensions';
import { ExtensionManifestSchema, IngestSourceCreateSchema } from '@heopress/contracts/schemas';

/**
 * Pipeline extensions, statically (HeoPress P12 tasks 4.1–4.4; spec extensions/pipeline-extensions): each declaration
 * kind needs its extension point's capability, ids are unique, adapter references and plugin gate rules have one form,
 * `ai:generate` is a capability of its own, and a `plugin` source names its adapter.
 */
const manifest = (over: Record<string, unknown>) => ({ name: 'acme-jobs', version: '1.0.0', type: 'hook', entry: 'dist/index.js', ...over });

describe('pipeline declarations in the manifest', () => {
  it('each kind needs its extension point capability', () => {
    const decl = {
      sourceAdapters: [{ id: 'board', label: 'Job board' }],
      gateChecks: [{ id: 'tone', label: 'Tone' }],
      buildSteps: [{ id: 'pdf', source: 'export {}' }],
    };
    expect(pipelineDeclarationIssues(decl, [])).toEqual([
      { path: 'sourceAdapters', message: 'sourceAdapters need the ext:source-adapters capability' },
      { path: 'gateChecks', message: 'gateChecks need the ext:gate-checks capability' },
      { path: 'buildSteps', message: 'buildSteps need the ext:build-steps capability' },
    ]);
    expect(pipelineDeclarationIssues(decl, ['ext:source-adapters', 'ext:gate-checks', 'ext:build-steps'])).toEqual([]);
    expect(pipelineDeclarationIssues({ gateChecks: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, ['ext:gate-checks'])).toEqual([{ path: 'gateChecks', message: 'ids repeat' }]);
  });

  it('the manifest schema refuses a declaration without its capability and malformed entries', () => {
    expect(ExtensionManifestSchema.safeParse(manifest({ capabilities: ['ext:gate-checks'], gateChecks: [{ id: 'tone', label: 'Tone' }] })).success).toBe(true);
    const missing = ExtensionManifestSchema.safeParse(manifest({ capabilities: [], gateChecks: [{ id: 'tone', label: 'Tone' }] }));
    expect(missing.success).toBe(false);
    expect(JSON.stringify(missing.error?.issues)).toContain('ext:gate-checks');
    // A gate check's time limit is 100 ms to 30 s; a build step's at most 10 minutes; ids are lowercase words.
    expect(ExtensionManifestSchema.safeParse(manifest({ capabilities: ['ext:gate-checks'], gateChecks: [{ id: 'tone', label: 'Tone', timeoutMs: 60_000 }] })).success).toBe(false);
    expect(ExtensionManifestSchema.safeParse(manifest({ capabilities: ['ext:build-steps'], buildSteps: [{ id: 'pdf', source: 'x', timeoutMs: 3_600_000 }] })).success).toBe(false);
    expect(ExtensionManifestSchema.safeParse(manifest({ capabilities: ['ext:source-adapters'], sourceAdapters: [{ id: 'Board', label: 'B' }] })).success).toBe(false);
    // What the CMS reads from a stored manifest: malformed → nothing.
    expect(pipelineDeclarationsOf({ gateChecks: 'nope' })).toEqual({});
    expect(pipelineDeclarationsOf(null)).toEqual({});
  });

  it('adapter references and plugin gate rules', () => {
    expect(sourceAdapterRef('acme/jobs', 'board')).toBe('acme/jobs#board');
    expect(parseSourceAdapterRef('acme/jobs#board')).toEqual({ plugin: 'acme/jobs', adapter: 'board' });
    expect(parseSourceAdapterRef('#board')).toBeNull();
    expect(parseSourceAdapterRef('acme#Board')).toBeNull();
    expect(pluginGateRule('acme_tone', 'tone')).toBe('ext:acme_tone:tone');
    expect(isPluginGateRule('ext:acme_tone:tone')).toBe(true);
    // A plugin's rule can never be a core rule's name.
    expect(isPluginGateRule('literal_integrity')).toBe(false);
  });

  it('ai:generate is a capability of its own category', () => {
    expect(parseCapability('ai:generate')).toMatchObject({ category: 'ai' });
    expect(parseCapability('ai:anything')).toHaveProperty('error');
  });
});

describe('plugin sources', () => {
  const base = { name: 'Board', url: 'https://jobs.example.com/board', scheduleTimes: ['08:00'], timezone: 'UTC' };
  it('a plugin source names its adapter; terms are not accepted at creation (they start at their defaults)', () => {
    expect(IngestSourceCreateSchema.safeParse({ ...base, type: 'plugin', adapter: 'acme-jobs#board' }).success).toBe(true);
    expect(IngestSourceCreateSchema.safeParse({ ...base, type: 'plugin' }).success).toBe(false);
    expect(IngestSourceCreateSchema.safeParse({ ...base, type: 'plugin', adapter: 'acme-jobs' }).success).toBe(false);
    expect(IngestSourceCreateSchema.safeParse({ ...base, type: 'plugin', adapter: 'acme-jobs#board', licenceStatus: 'licensed' }).success).toBe(false);
  });
});
