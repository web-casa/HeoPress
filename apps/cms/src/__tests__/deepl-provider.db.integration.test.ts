/**
 * The official DeepL translation provider through the host (HeoPress v1.2, spec extensions/translation-services
 * "选中后的端到端行为与计费"): the real `heopress-deepl` manifest and source are installed, approved, enabled and selected
 * for a site; a translation is then answered by the plugin (terminology included), recorded as one call priced by
 * characters under `plugin:heopress-deepl`, and never handed to the language-model path.
 *
 * The HTTP transport is a stub — no test talks to DeepL. `outboundFetch` is replaced for this file only, and the plugin's
 * key comes from a `secrets` resolver injected through the host's documented `createSandbox` seam (the host-side secret
 * store is not part of this change; see the change's design.md).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { build } from 'esbuild';
import { auditLog, extensions, llmAttempts, llmCalls, llmSiteSettings, sites, scopedDatabase, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { ExtensionSandbox } from '../extensions/sandbox';
import { PluginHost } from '../extensions/runtime/plugin-host';
import { PluginTranslationServices } from '../extensions/runtime/translation-services';
import { ExtensionVerifierService } from '../services/extension-verifier';
import { LlmGateway } from '../services/llm/gateway';
import { LlmUsageService } from '../services/llm/usage-service';
import { TranslationServiceRouter } from '../services/llm/translation-router';

const SITE = 'site_v12_deepl_a';
const KEK = Buffer.alloc(32, 7).toString('base64');
const ENV = { HEOPRESS_ENV: 'development', HEOPRESS_VERSION: '1.2.0', LLM_PRICE_CURRENCY: 'USD' } as Record<string, unknown>;
const PLUGIN = 'heopress-deepl';
/** A DeepL API Free-shaped key: the plugin must then use api-free.deepl.com. */
const KEY = 'test-deepl-key:fx';
const GLOSSARY_ID = 'glossary-v12-1';

const PLUGIN_ROOT = new URL('../../../../examples/plugin-translation-deepl/', import.meta.url);
const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('heopress-extension.json', PLUGIN_ROOT)), 'utf8')) as Record<string, unknown>;
const PLUGIN_ENTRY = fileURLToPath(new URL('src/index.ts', PLUGIN_ROOT));

/** One intercepted outbound request (no test sends a real one). */
interface TransportCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  authorization: string | null;
}

const transport = vi.hoisted(() => ({
  calls: [] as TransportCall[],
  answer: null as null | ((call: TransportCall) => { status?: number; body?: unknown }),
}));

// The sandbox imports `outboundFetch` from this module; replacing it here keeps every other export real.
vi.mock('@heopress/runtime/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heopress/runtime/node')>();
  return {
    ...actual,
    outboundFetch: async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const headers = { ...(init.headers as Record<string, string> | undefined) };
      const call: TransportCall = {
        url: String(input),
        method: init.method ?? 'GET',
        body: init.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>),
        authorization: headers.authorization ?? null,
      };
      transport.calls.push(call);
      const reply = transport.answer?.(call) ?? { status: 404, body: { message: 'no stub for this request' } };
      return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
});

const SEGMENTS = [
  { id: 's1', text: 'Hello, ' },
  { id: 's2', text: 'world!' },
];
const GLOSSARY = [{ source: 'HeoPress', target: '和欧' }];

/** The plugin's source as the host would load it: one ES module, types erased. */
async function pluginBundle(): Promise<string> {
  const result = await build({
    entryPoints: [PLUGIN_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output) throw new Error('esbuild produced no bundle for the DeepL plugin');
  return `data:text/javascript,${encodeURIComponent(output)}`;
}

/** The DeepL answers this suite expects: an empty glossary list, a created glossary, translated segments. */
function stubDeepL(): void {
  transport.answer = (call) => {
    if (call.method === 'GET' && call.url.endsWith('/v3/glossaries')) return { body: { glossaries: [] } };
    if (call.method === 'POST' && call.url.endsWith('/v3/glossaries')) return { body: { glossary_id: GLOSSARY_ID, ready: true } };
    if (call.method === 'POST' && call.url.endsWith('/v2/translate')) {
      const texts = (call.body?.text as string[] | undefined) ?? [];
      return { body: { translations: texts.map((text) => ({ detected_source_language: 'EN', text: `译:${text}` })) } };
    }
    return { status: 404, body: { message: 'no stub for this request' } };
  };
}

describe.skipIf(!hasDbIntegrationUrl)('v1.2 DeepL provider — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  let bundleUrl: string;

  beforeAll(async () => {
    db = await connectDbIntegration('v12-deepl');
    fixtures = await connectDbFixtures('v12-deepl');
    bundleUrl = await pluginBundle();
    // The official namespace needs a signature on a real install; signing is exercised by the P12/P14 suites.
    vi.spyOn(ExtensionVerifierService, 'isReservedName').mockReturnValue(false);
    // Data URLs are the tests' bundles; production loads only the trusted bundle origins.
    vi.spyOn(ExtensionSandbox.prototype as unknown as { isTrustedBundleUrl(url: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (!fixtures) return;
    await fixtures.delete(auditLog).where(inArray(auditLog.siteId, [SITE]));
    await fixtures.delete(llmAttempts).where(inArray(llmAttempts.siteId, [SITE]));
    await fixtures.delete(llmCalls).where(inArray(llmCalls.siteId, [SITE]));
    await fixtures.delete(llmSiteSettings).where(inArray(llmSiteSettings.siteId, [SITE]));
    await fixtures.delete(extensions).where(inArray(extensions.siteId, [SITE]));
    await fixtures.delete(sites).where(inArray(sites.id, [SITE]));
  });

  beforeEach(async () => {
    transport.calls.length = 0;
    stubDeepL();
    await fixtures.delete(auditLog).where(inArray(auditLog.siteId, [SITE]));
    await fixtures.delete(llmAttempts).where(inArray(llmAttempts.siteId, [SITE]));
    await fixtures.delete(llmCalls).where(inArray(llmCalls.siteId, [SITE]));
    await fixtures.delete(llmSiteSettings).where(inArray(llmSiteSettings.siteId, [SITE]));
    await fixtures.delete(extensions).where(inArray(extensions.siteId, [SITE]));
    await fixtures.delete(sites).where(inArray(sites.id, [SITE]));
    await fixtures.insert(sites).values({ id: SITE, name: SITE });
  });

  /** The plugin row as installed (manifest and capabilities from the shipped file), approved and enabled. */
  async function install(options: { enabled?: boolean; permissionsStatus?: string } = {}) {
    const [row] = await fixtures
      .insert(extensions)
      .values({
        siteId: SITE,
        name: PLUGIN,
        key: PLUGIN.replace(/[^a-z0-9]+/g, '_'),
        version: '1.0.0',
        type: 'module',
        enabled: options.enabled ?? true,
        bundleUrl,
        manifest: MANIFEST,
        capabilities: MANIFEST.capabilities as string[],
        requestedCapabilities: MANIFEST.capabilities as string[],
        permissionsStatus: options.permissionsStatus ?? 'approved',
      })
      .returning();
    return row!;
  }

  /** The site's model settings: USD, the plugin's service selected. */
  async function select(monthlyBudgetMicros: number | null = null) {
    await fixtures.insert(llmSiteSettings).values({
      siteId: SITE,
      currency: 'USD',
      monthlyBudgetMicros,
      budgetTimezone: 'UTC',
      translationService: `${PLUGIN}:deepl`,
    });
  }

  /** The gateway reads the instance currency from `LLM_PRICE_CURRENCY`; the key provider only seals provider secrets. */
  const keys = () => createRuntime({ ...process.env, ENCRYPTION_KEY: KEK, HEOPRESS_ENV: 'development' }).keys;

  /** A host whose secret resolver hands the plugin its DeepL key (the deployment's job in production). */
  const host = (key: string | null = KEY) =>
    new PluginHost({
      db,
      env: ENV,
      createSandbox: (sandboxEnv, deps) =>
        new ExtensionSandbox(sandboxEnv as never, {
          ...deps,
          secrets: async (extensionName, name) => (extensionName === PLUGIN && name === 'deepl_api_key' ? key : null),
        }),
    });

  const router = (key: string | null = KEY) =>
    new TranslationServiceRouter({
      db: scopedDatabase(db, { site: SITE }),
      gateway: new LlmGateway({ db, keys: keys(), env: ENV }),
      env: ENV,
      plugins: new PluginTranslationServices(host(key)),
    });

  const translate = (over: Record<string, unknown> = {}, key: string | null = KEY) =>
    router(key).translate({ siteId: SITE, sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS, ...over });

  const attempts = () => fixtures.select().from(llmAttempts).where(eq(llmAttempts.siteId, SITE)).orderBy(llmAttempts.seq);
  const calls = () => fixtures.select().from(llmCalls).where(eq(llmCalls.siteId, SITE));

  it('answers through the official plugin, applies the glossary, and records one call priced by characters', async () => {
    await install();
    await select();

    const out = await translate({ glossary: GLOSSARY });

    // The requested segments came back in order with their ids; the host filled in the rest.
    expect(out).toEqual({
      segments: [
        { id: 's1', text: '译:Hello, ' },
        { id: 's2', text: '译:world!' },
      ],
      engine: `plugin:${PLUGIN}`,
      provider: `plugin:${PLUGIN}`,
      model: 'deepl',
      callId: expect.any(String),
    });

    // The plugin mirrored the terms, then translated with the glossary id, over the Free host its key belongs to.
    expect(transport.calls.map((call) => `${call.method} ${new URL(call.url).host}${new URL(call.url).pathname}`)).toEqual([
      'GET api-free.deepl.com/v3/glossaries',
      'POST api-free.deepl.com/v3/glossaries',
      'POST api-free.deepl.com/v2/translate',
    ]);
    expect(transport.calls[1]!.body).toEqual({
      name: expect.stringMatching(/^heopress-[0-9a-f]{8}-en-zh$/),
      dictionaries: [{ source_lang: 'en', target_lang: 'zh', entries: 'HeoPress\t和欧', entries_format: 'tsv' }],
    });
    expect(transport.calls[2]!.body).toEqual({
      text: ['Hello, ', 'world!'],
      target_lang: 'ZH-HANS',
      source_lang: 'EN',
      glossary_id: GLOSSARY_ID,
    });
    expect(transport.calls[2]!.authorization).toBe(`DeepL-Auth-Key ${KEY}`);

    // One ledger call priced by characters: 27.5 per million × 13 characters = 358 micro-units (rounded up).
    const [attempt] = await attempts();
    expect(attempt).toMatchObject({
      billing: 'settled',
      outcome: 'succeeded',
      actualMicros: 358,
      reservedMicros: 358,
      billedCharacters: 13,
      inputTokens: null,
      outputTokens: null,
      instanceRef: `plugin:${PLUGIN}/deepl`,
      period: expect.any(String),
    });
    expect(attempt!.snapshot).toMatchObject({
      name: `plugin:${PLUGIN}`,
      model: 'deepl',
      pricing: { kind: 'per_1m_chars', charsMicros: 27_500_000 },
    });
    expect(await calls()).toEqual([expect.objectContaining({ id: out.callId, taskType: 'translation', capability: 'translate', status: 'completed' })]);

    // The same row is visible in the usage report under the plugin's name, with the characters it was priced by.
    const usage = await new LlmUsageService({ db: scopedDatabase(db, { site: SITE }), siteId: SITE, instanceCurrency: 'USD' }).usage();
    expect(usage.committedMicros).toBe(358);
    expect(usage.byModel).toEqual([
      expect.objectContaining({
        instanceRef: `plugin:${PLUGIN}/deepl`,
        name: `plugin:${PLUGIN}`,
        model: 'deepl',
        attempts: 1,
        settledCount: 1,
        settledMicros: 358,
        inputTokens: 0,
        outputTokens: 0,
        billedCharacters: 13,
      }),
    ]);
  });

  it('fails without a key instead of falling back to the language model', async () => {
    await install();
    await select();
    await expect(translate({}, null)).rejects.toMatchObject({ code: 'PLUGIN_ERROR' });
    expect(transport.calls).toEqual([]);

    const [attempt] = await attempts();
    expect(attempt).toMatchObject({ outcome: 'failed_final', billing: 'unknown', errorCode: 'PLUGIN_ERROR', inputTokens: null });
    // The one call is the failed plugin call (not a token-priced model call), so no fallback happened.
    expect(await calls()).toEqual([expect.objectContaining({ taskType: 'translation', capability: 'translate', status: 'failed' })]);
  });

  it('reserves before the call: a budget that cannot cover the translation leaves DeepL uncalled', async () => {
    await install();
    await select(100);
    await expect(translate({ glossary: GLOSSARY })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(transport.calls).toEqual([]);
    expect(await attempts()).toEqual([]);
  });

  it('reports SERVICE_UNAVAILABLE when the plugin is disabled instead of using the model', async () => {
    await install({ enabled: false });
    await select();
    await expect(translate()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(transport.calls).toEqual([]);
    expect(await attempts()).toEqual([]);
  });

  it('offers the service under the plugin name once the plugin is enabled and approved', async () => {
    await install();
    const services = await new PluginTranslationServices(host()).list(SITE);
    expect(services).toEqual([
      expect.objectContaining({
        plugin: PLUGIN,
        pluginName: 'DeepL translation',
        id: 'deepl',
        displayName: 'DeepL',
        engine: 'deepl',
        charsMicros: 27_500_000,
        durationMs: 30_000,
        maxRequests: 40,
      }),
    ]);
    // The row was not approved? Then the service is not offered at all (the sandbox is never asked).
    await fixtures.delete(extensions).where(and(eq(extensions.siteId, SITE), eq(extensions.name, PLUGIN)));
    await install({ permissionsStatus: 'reconfirm' });
    expect(await new PluginTranslationServices(host()).list(SITE)).toEqual([]);
  });
});
