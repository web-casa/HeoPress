/**
 * Plugin translation services (HeoPress v1.2, spec extensions/translation-services): a declared, registered service
 * translates for its own site when the site selects it; an undeclared one is refused and audited; a service of another
 * site is never used; a failing or never-answering one fails its own translation only; and the call is recorded in the
 * ledger priced by characters, visible in the usage report.
 *
 * The cells here back the `translation-services` rows of the extension-point matrix (`helpers/extension-matrix.ts`); the
 * contract-version cell lives in `extension-matrix.db.integration.test.ts` (`versionCell`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { auditLog, extensions, llmAttempts, llmCalls, llmSiteSettings, sites, scopedDatabase, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { ExtensionSandbox } from '../extensions/sandbox';
import { LlmGateway } from '../services/llm/gateway';
import { LlmUsageService } from '../services/llm/usage-service';
import { TranslationError } from '../services/llm/translation-service';
import { TranslationServiceRouter } from '../services/llm/translation-router';
import { PluginTranslationServices } from '../extensions/runtime/translation-services';
import { PluginHost } from '../extensions/runtime/plugin-host';

const A = 'site_v12_translation_a';
const B = 'site_v12_translation_b';
const KEK = Buffer.alloc(32, 7).toString('base64');
const ENV = { HEOPRESS_ENV: 'development', HEOPRESS_VERSION: '1.2.0', LLM_PRICE_CURRENCY: 'USD' } as Record<string, unknown>;

declare global {
  // eslint-disable-next-line no-var
  var __v12TranslationCalls: number | undefined;
}

const MANIFEST = {
  displayName: 'DeepL',
  translationServices: [{ id: 'deepl', displayName: 'DeepL', engine: 'deepl', pricePerMillionChars: 20 }],
};

/** A bundle registering the `deepl` service; `body` is the translate implementation, `limits` extra registration fields. */
function bundle(body: string, limits = ''): string {
  const source = `export default (ctx) => {
    ctx.extensionPoints.register('translation-services', { id: 'deepl', translate: ${body}${limits} });
    return {};
  }`;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

const GOOD = bundle(`async (req) => {
  globalThis.__v12TranslationCalls = (globalThis.__v12TranslationCalls ?? 0) + 1;
  return { segments: req.segments.map((s) => ({ id: s.id, text: '译:' + s.text })) };
}`);
const THROWS = bundle(`async () => { throw new Error('upstream said no'); }`);
/** A service that never answers, registered with the shortest deadline the host allows. */
const SLOW = bundle(`() => new Promise(() => {})`, ', maxDurationMs: 100');

const SEGMENTS = [
  { id: 's1', text: 'Hello, ' },
  { id: 's2', text: 'world!' },
];

describe.skipIf(!hasDbIntegrationUrl)('v1.2 plugin translation services — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  beforeAll(async () => {
    db = await connectDbIntegration('v12-translation');
    fixtures = await connectDbFixtures('v12-translation');
    // Data URLs are the tests' bundles; production loads only the trusted bundle origins.
    vi.spyOn(ExtensionSandbox.prototype as unknown as { isTrustedBundleUrl(url: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (!fixtures) return;
    await fixtures.delete(auditLog).where(inArray(auditLog.siteId, [A, B]));
    await fixtures.delete(llmAttempts).where(inArray(llmAttempts.siteId, [A, B]));
    await fixtures.delete(llmCalls).where(inArray(llmCalls.siteId, [A, B]));
    await fixtures.delete(llmSiteSettings).where(inArray(llmSiteSettings.siteId, [A, B]));
    await fixtures.delete(extensions).where(inArray(extensions.siteId, [A, B]));
    await fixtures.delete(sites).where(inArray(sites.id, [A, B]));
  });
  beforeEach(async () => {
    await fixtures.delete(auditLog).where(inArray(auditLog.siteId, [A, B]));
    await fixtures.delete(llmAttempts).where(inArray(llmAttempts.siteId, [A, B]));
    await fixtures.delete(llmCalls).where(inArray(llmCalls.siteId, [A, B]));
    await fixtures.delete(llmSiteSettings).where(inArray(llmSiteSettings.siteId, [A, B]));
    await fixtures.delete(extensions).where(inArray(extensions.siteId, [A, B]));
    await fixtures.delete(sites).where(inArray(sites.id, [A, B]));
    for (const id of [A, B]) await fixtures.insert(sites).values({ id, name: id });
    globalThis.__v12TranslationCalls = 0;
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
    const capabilities = options.capabilities ?? ['ext:translation-services'];
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
        manifest: options.manifest ?? MANIFEST,
        capabilities,
        requestedCapabilities: capabilities,
        permissionsStatus: options.permissionsStatus ?? 'approved',
      })
      .returning();
    return row!;
  }

  /** The site's model settings, with (or without) the selected translation service. */
  async function select(siteId: string, translationService: string | null, monthlyBudgetMicros: number | null = null) {
    await fixtures
      .insert(llmSiteSettings)
      .values({ siteId, currency: 'USD', monthlyBudgetMicros, budgetTimezone: 'UTC', translationService })
      .onConflictDoUpdate({ target: llmSiteSettings.siteId, set: { translationService, monthlyBudgetMicros } });
  }

  const keys = () => createRuntime({ ...process.env, ENCRYPTION_KEY: KEK, HEOPRESS_ENV: 'development' }).keys;
  const gateway = () => new LlmGateway({ db, keys: keys(), env: ENV });
  const router = (siteId: string, extra: Partial<ConstructorParameters<typeof TranslationServiceRouter>[0]> = {}) =>
    new TranslationServiceRouter({ db: scopedDatabase(db, { site: siteId }), gateway: gateway(), env: ENV, ...extra });
  const translate = (siteId: string, over: Record<string, unknown> = {}, extra: Partial<ConstructorParameters<typeof TranslationServiceRouter>[0]> = {}) =>
    router(siteId, extra).translate({ siteId, sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS, ...over });
  const attempts = (siteId: string) => fixtures.select().from(llmAttempts).where(eq(llmAttempts.siteId, siteId)).orderBy(llmAttempts.seq);

  it('9.1 translation-services × declared: a declared, registered service translates for its own site', async () => {
    await install(A, 'acme-deepl', { bundleUrl: GOOD });
    await select(A, 'acme-deepl:deepl');
    const out = await translate(A);
    expect(out).toEqual({
      segments: [
        { id: 's1', text: '译:Hello, ' },
        { id: 's2', text: '译:world!' },
      ],
      engine: 'plugin:acme-deepl',
      provider: 'plugin:acme-deepl',
      model: 'deepl',
      callId: expect.any(String),
    });
    expect(globalThis.__v12TranslationCalls).toBe(1);
    const listed = await new PluginTranslationServices(new PluginHost({ db, env: ENV })).list(A);
    expect(listed).toMatchObject([{ plugin: 'acme-deepl', id: 'deepl', engine: 'deepl', charsMicros: 20_000_000 }]);
  });

  it('writes one usage row priced by characters, not tokens', async () => {
    await install(A, 'acme-deepl', { bundleUrl: GOOD });
    await select(A, 'acme-deepl:deepl');
    const out = await translate(A);
    expect(globalThis.__v12TranslationCalls).toBe(1);

    const rows = await attempts(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      billing: 'settled',
      outcome: 'succeeded',
      actualMicros: 260, // 20 currency units per million characters × 13 characters
      reservedMicros: 260,
      billedCharacters: 13,
      inputTokens: null,
      outputTokens: null,
      period: expect.any(String),
    });
    expect(rows[0]!.snapshot).toMatchObject({
      name: 'plugin:acme-deepl',
      model: 'deepl',
      pricing: { kind: 'per_1m_chars', charsMicros: 20_000_000 },
    });
    expect(rows[0]!.instanceRef).toBe('plugin:acme-deepl/deepl');

    const [call] = await fixtures.select().from(llmCalls).where(eq(llmCalls.siteId, A));
    expect(call).toMatchObject({ id: out.callId, taskType: 'translation', capability: 'translate', status: 'completed' });

    // Visible in the usage report, under the plugin's name, with the characters it was priced by.
    const usage = await new LlmUsageService({ db: scopedDatabase(db, { site: A }), siteId: A, instanceCurrency: 'USD' }).usage();
    expect(usage.committedMicros).toBe(260);
    expect(usage.byModel).toEqual([
      expect.objectContaining({
        source: 'instance',
        instanceRef: 'plugin:acme-deepl/deepl',
        name: 'plugin:acme-deepl',
        model: 'deepl',
        attempts: 1,
        settledCount: 1,
        settledMicros: 260,
        inputTokens: 0,
        outputTokens: 0,
        billedCharacters: 13,
        withoutUsageCount: 0,
      }),
    ]);
  });

  it('a service that declares no price is still one recorded, settled row', async () => {
    await install(A, 'acme-deepl', {
      bundleUrl: GOOD,
      manifest: { translationServices: [{ id: 'deepl', displayName: 'DeepL', engine: 'deepl' }] },
    });
    await select(A, 'acme-deepl:deepl');
    await translate(A);
    const [row] = await attempts(A);
    expect(row).toMatchObject({ billing: 'settled', actualMicros: 0, billedCharacters: 13, inputTokens: null, outputTokens: null });
  });

  it('the reservation comes first: a budget that cannot cover the translation leaves the plugin uncalled', async () => {
    await install(A, 'acme-deepl', { bundleUrl: GOOD });
    await select(A, 'acme-deepl:deepl', 100);
    await expect(translate(A)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(globalThis.__v12TranslationCalls).toBe(0);
    expect(await attempts(A)).toEqual([]);
  });

  it('not selected: the LLM answers, and no plugin call is recorded', async () => {
    await install(A, 'acme-deepl', { bundleUrl: GOOD });
    await select(A, null);
    const llm = { translate: vi.fn(async () => ({ segments: SEGMENTS.map((s) => ({ id: s.id, text: `llm:${s.text}` })), engine: 'llm', provider: 'OpenAI', model: 'gpt-test', callId: 'call_llm' })) };
    const out = await translate(A, {}, { llm });
    expect(llm.translate).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ engine: 'llm', callId: 'call_llm' });
    expect(globalThis.__v12TranslationCalls).toBe(0);
    expect(await attempts(A)).toEqual([]);
  });

  it('a selection that is no longer offered fails instead of falling back to the model', async () => {
    await install(A, 'acme-deepl', { bundleUrl: GOOD, enabled: false });
    await select(A, 'acme-deepl:deepl');
    const llm = { translate: vi.fn() };
    await expect(translate(A, {}, { llm })).rejects.toMatchObject({ name: 'TranslationError', code: 'SERVICE_UNAVAILABLE' });
    expect(llm.translate).not.toHaveBeenCalled();
    expect(await attempts(A)).toEqual([]);
  });

  it('9.1 translation-services × undeclared: a service without the capability is not offered, and one the manifest does not declare is refused and recorded', async () => {
    // Without the extension point the bundle cannot register the service at all.
    await install(A, 'acme-deepl', { bundleUrl: GOOD, capabilities: ['ext:jobs'] });
    await select(A, 'acme-deepl:deepl');
    await expect(translate(A)).rejects.toBeInstanceOf(TranslationError);
    expect(await new PluginTranslationServices(new PluginHost({ db, env: ENV })).resolve(A, 'acme-deepl:deepl')).toBeNull();
    // A plugin holding the point capability but registering an id the manifest never declared is refused and recorded.
    await fixtures.delete(auditLog).where(eq(auditLog.siteId, A));
    await fixtures.delete(extensions).where(and(eq(extensions.siteId, A), eq(extensions.name, 'acme-deepl')));
    const undeclared = bundle(`async (req) => ({ segments: req.segments })`);
    await install(A, 'acme-deepl', {
      bundleUrl: undeclared,
      manifest: { translationServices: [{ id: 'google', displayName: 'Google', engine: 'google' }] },
    });
    await select(A, 'acme-deepl:deepl');
    await expect(translate(A)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(await new PluginTranslationServices(new PluginHost({ db, env: ENV })).resolve(A, 'acme-deepl:deepl')).toBeNull();
    const recorded = await fixtures
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.siteId, A), eq(auditLog.event, 'extension_capability_denied')));
    // One denial per load of the plugin (the settings read and the resolve each load it); every one names the refused id.
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.map((d) => d.metadata)).toEqual(
      recorded.map(() =>
        expect.objectContaining({
          extensionName: 'acme-deepl',
          capability: 'translationServices:deepl',
          operation: 'register:translation-services',
        }),
      ),
    );
  });

  it("9.1 translation-services × cross-site: a plugin's service translates for its own site only", async () => {
    await install(A, 'acme-deepl', { bundleUrl: GOOD });
    await select(A, 'acme-deepl:deepl');
    await select(B, 'acme-deepl:deepl');
    await expect(translate(B)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(globalThis.__v12TranslationCalls).toBe(0);
    await expect(translate(A)).resolves.toMatchObject({ engine: 'plugin:acme-deepl' });
  });

  it('9.1 translation-services × isolation: a service that throws or never answers fails its own translation; the next one runs', async () => {
    await install(A, 'acme-deepl', { bundleUrl: THROWS });
    await select(A, 'acme-deepl:deepl');
    await expect(translate(A)).rejects.toMatchObject({ code: 'PLUGIN_ERROR' });
    const [failed] = await attempts(A);
    expect(failed).toMatchObject({ outcome: 'failed_final', billing: 'unknown', errorCode: 'PLUGIN_ERROR', inputTokens: null });

    // A service that never answers is stopped at its deadline (the registration asks for the shortest one).
    await fixtures.delete(llmAttempts).where(eq(llmAttempts.siteId, A));
    await fixtures.delete(llmCalls).where(eq(llmCalls.siteId, A));
    await fixtures.delete(extensions).where(eq(extensions.siteId, A));
    await install(A, 'acme-slow', { bundleUrl: SLOW });
    await select(A, 'acme-slow:deepl');
    const started = Date.now();
    await expect(translate(A)).rejects.toMatchObject({ code: 'PLUGIN_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(5_000);

    // The site is not broken: a working service still answers.
    await select(A, 'acme-deepl:deepl');
    await fixtures.delete(extensions).where(eq(extensions.siteId, A));
    await install(A, 'acme-deepl', { bundleUrl: GOOD });
    await expect(translate(A)).resolves.toMatchObject({ engine: 'plugin:acme-deepl' });
  });

  it('a plugin answer that is not the requested segments is BAD_TRANSLATION, after the call is recorded', async () => {
    await install(A, 'acme-deepl', {
      bundleUrl: bundle(`async () => ({ segments: [{ id: 's1', text: 'only one' }] })`),
    });
    await select(A, 'acme-deepl:deepl');
    await expect(translate(A)).rejects.toBeInstanceOf(TranslationError);
    const [row] = await attempts(A);
    // The plugin processed the characters, so the call is settled like a model answer that could not be used.
    expect(row).toMatchObject({ billing: 'settled', actualMicros: 260, billedCharacters: 13 });
  });

  it('a candidate with an empty segment list is refused before the ledger', async () => {
    await install(A, 'acme-deepl', { bundleUrl: GOOD });
    await select(A, 'acme-deepl:deepl');
    await expect(translate(A, { segments: [] })).rejects.toMatchObject({ code: 'EMPTY_REQUEST' });
    expect(await attempts(A)).toEqual([]);
  });

  it('the selection is the site setting, readable and writable through the settings API surface', async () => {
    // The service layer reads the same column the settings route writes; a change applies to the next translation.
    await install(A, 'acme-deepl', { bundleUrl: GOOD });
    await select(A, null);
    const llm = { translate: vi.fn(async () => ({ segments: SEGMENTS, engine: 'llm', provider: 'OpenAI', model: 'gpt-test', callId: 'call_llm' })) };
    await translate(A, {}, { llm });
    await select(A, 'acme-deepl:deepl');
    await expect(translate(A, {}, { llm })).resolves.toMatchObject({ engine: 'plugin:acme-deepl' });
    expect(llm.translate).toHaveBeenCalledTimes(1);
  });
});
