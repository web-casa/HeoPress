import { describe, expect, it } from 'vitest';
import { adapterReaches, declaredGateChecks, isOperatorTrusted, participates, pluginBuildSteps, type ExtensionRow } from '../extensions/pipeline/declarations';
import { PluginAiRequestError, pluginAiAccess } from '../extensions/pipeline/host';
import type { ChatCallInput, ChatCallResult } from '../services/llm/gateway';
import type { SiteTransaction } from '../services/rls-transaction';

/**
 * What the pipeline reads from a site's installed plugins (HeoPress P12 tasks 4.2–4.4), without a database: which
 * plugins take part, which build steps may run (operator-trusted plugins only), the declared gate checks, and the
 * plugin model access's request rules. The DB suites (`pipeline-extensions`, `quality-gate`, `astro-engine`) cover the
 * same through the real data path.
 */

const row = (over: Partial<ExtensionRow> & Record<string, unknown>): ExtensionRow =>
  ({ siteId: 's1', name: 'acme-x', enabled: true, permissionsStatus: 'approved', capabilities: [], manifest: {}, marketplaceSlug: null, ...over }) as ExtensionRow;

/** A transaction whose select returns `rows` (what `participatingRows` reads). */
const txOf = (rows: ExtensionRow[]) =>
  ({ select: () => ({ from: () => ({ where: () => ({ orderBy: async () => rows }) }) }) }) as unknown as SiteTransaction;

const STEP = { id: 'pdf', source: 'export {}' };

describe('pipeline declarations', () => {
  it('a plugin takes part when enabled, approved and holding the point capability', () => {
    const caps = ['ext:build-steps'];
    expect(participates(row({ capabilities: caps }), 'build-steps')).toBe(true);
    expect(participates(row({ capabilities: caps, enabled: false }), 'build-steps')).toBe(false);
    expect(participates(row({ capabilities: caps, permissionsStatus: 'pending' }), 'build-steps')).toBe(false);
    expect(participates(row({ capabilities: ['ext:gate-checks'] }), 'build-steps')).toBe(false);
  });

  it('build steps run only for plugins the operator marked as trusted; a marketplace plugin is told why', async () => {
    expect(isOperatorTrusted(row({}))).toBe(false);
    expect(isOperatorTrusted(row({ trusted: false }))).toBe(false);
    expect(isOperatorTrusted(row({ trusted: true }))).toBe(true);
    const plan = await pluginBuildSteps(
      txOf([
        row({ name: 'acme-pdf', marketplaceSlug: 'acme-pdf', capabilities: ['ext:build-steps'], manifest: { buildSteps: [STEP] } }),
        row({ name: 'local-og', capabilities: ['ext:build-steps'], manifest: { buildSteps: [{ ...STEP, id: 'og', timeoutMs: 5000 }] }, trusted: true }),
        row({ name: 'no-cap', capabilities: [], manifest: { buildSteps: [STEP] }, trusted: true }),
      ]),
      's1',
    );
    expect(plan.run).toEqual([{ plugin: 'local-og', namespace: 'local_og', step: { id: 'og', source: 'export {}', timeoutMs: 5000 } }]);
    expect(plan.skipped).toEqual([{ plugin: 'acme-pdf', step: 'pdf', reason: expect.stringContaining("a marketplace plugin's build steps run only once the operator marks it as trusted") }]);
  });

  it('gate checks carry their rule, default limit and collections', async () => {
    const checks = await declaredGateChecks(
      txOf([row({ name: 'acme-tone', capabilities: ['ext:gate-checks'], manifest: { gateChecks: [{ id: 'tone', label: 'Tone' }, { id: 'pages', label: 'Pages', collections: ['pages'], timeoutMs: 200 }] } })]),
      's1',
    );
    expect(checks).toEqual([
      { rule: 'ext:acme_tone:pages', plugin: 'acme-tone', checkId: 'pages', label: 'Pages', collections: ['pages'], timeoutMs: 200 },
      { rule: 'ext:acme_tone:tone', plugin: 'acme-tone', checkId: 'tone', label: 'Tone', collections: null, timeoutMs: 5000 },
    ]);
  });

  it("a source's address must be one of the adapter plugin's hosts", () => {
    const adapter = { ref: 'acme#a', plugin: 'acme', adapterId: 'a', label: 'A', description: null, hosts: ['jobs.example.com'] };
    expect(adapterReaches(adapter, 'https://jobs.example.com/board')).toBe(true);
    expect(adapterReaches(adapter, 'https://other.example.com/board')).toBe(false);
    expect(adapterReaches(adapter, 'not a url')).toBe(false);
  });
});

describe('plugin model access', () => {
  const calls: ChatCallInput[] = [];
  const gateway = {
    chat: async (req: ChatCallInput): Promise<ChatCallResult> => {
      calls.push(req);
      return { response: { content: 'ok', toolCalls: [], usage: { inputTokens: 3, outputTokens: 1 } }, provider: 'mock', model: 'm', callId: 'call_1', attemptIds: [] };
    },
  };
  const access = pluginAiAccess(gateway, 's1');

  it('goes through the gateway with the plugin capability, the site providers only, no tools; the answer is text', async () => {
    calls.length = 0;
    const out = await access('acme-ai', { messages: [{ role: 'user', content: 'Hi' }], key: 'run:1', maxOutputTokens: 1_000_000 });
    expect(out).toEqual({ content: 'ok', usage: { inputTokens: 3, outputTokens: 1 }, callId: 'call_1' });
    expect(calls[0]).toMatchObject({
      siteId: 's1',
      taskType: 'generation',
      capability: 'plugin',
      origin: { kind: 'extension', id: 'acme-ai' },
      callKey: 'ext:acme-ai:run:1',
      tools: false,
      siteProvidersOnly: true,
      maxOutputTokens: 4000,
    });
  });

  it('refuses malformed requests before calling the gateway', async () => {
    calls.length = 0;
    for (const bad of [{}, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] }, { messages: [{ role: 'user', content: 1 }] }, { messages: [{ role: 'user', content: 'x'.repeat(200_001) }] }]) {
      await expect(access('acme-ai', bad as never)).rejects.toBeInstanceOf(PluginAiRequestError);
    }
    // A key outside the allowed characters is not used (no replay identity), the call still goes.
    await access('acme-ai', { messages: [{ role: 'user', content: 'x' }], key: 'bad key!' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.callKey).toBeUndefined();
  });
});
