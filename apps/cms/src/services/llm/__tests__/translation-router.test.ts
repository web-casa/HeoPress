/**
 * The host wiring of plugin translation services (HeoPress v1.2, spec extensions/translation-services "站点选择与宿主接线"):
 * the site's `translationService` setting decides whether a translation is served by the plugin or by `LlmTranslationService`,
 * a stale selection fails instead of silently falling back, and the call reaches the ledger with characters, not tokens.
 *
 * The database is stubbed at the one query the router makes (the site's setting); the real ledger row and the real plugin
 * load are covered by `apps/cms/src/__tests__/translation-services.db.integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@heopress/database';
import { TranslationError, type TranslationRequest } from '../translation-service';
import { TranslationServiceRouter } from '../translation-router';
import { pluginTranslationCandidate, translateWithPlugin, type TranslationGateway } from '../plugin-translation';
import type { LoadedTranslationService } from '../../../extensions/runtime/translation-services';
import type { PluginTranslationRequest } from '@heopress/contracts/extensions';

/** A database that answers exactly the router's settings query (`SELECT translation_service … LIMIT 1`). */
function settingsDb(selection: string | null): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ translationService: selection }] }),
      }),
    }),
  } as unknown as Database;
}

const request = (over: Partial<TranslationRequest> = {}): TranslationRequest => ({
  siteId: 'site_a',
  sourceLocale: 'en',
  targetLocale: 'zh-CN',
  segments: [
    { id: 's1', text: 'Hello, ' },
    { id: 's2', text: 'world!' },
  ],
  ...over,
});

/** A plugin service that answers in one language, recording what it was asked. */
function pluginService(over: Partial<LoadedTranslationService> = {}): LoadedTranslationService & { calls: TranslationRequest[] } {
  const calls: TranslationRequest[] = [];
  return {
    plugin: 'heopress-deepl',
    pluginName: 'DeepL',
    id: 'deepl',
    displayName: 'DeepL',
    engine: 'deepl',
    charsMicros: 20_000_000,
    durationMs: 5_000,
    maxRequests: 5,
    calls,
    translate: vi.fn(async (req: PluginTranslationRequest) => {
      calls.push(req as unknown as TranslationRequest);
      return { segments: req.segments.map((s) => ({ id: s.id, text: `译:${s.text}` })) };
    }),
    ...over,
  };
}

/** A gateway that answers the LLM path and records the plugin path's ledger spec. */
function gateway(over: { externalThrows?: Error } = {}) {
  const chat = vi.fn(async () => ({
    response: { content: JSON.stringify({ segments: [{ id: 's1', text: 'LLM 一' }, { id: 's2', text: 'LLM 二' }] }) },
    provider: 'OpenAI',
    model: 'gpt-test',
    callId: 'call_llm',
    attemptIds: ['att_llm'],
  }));
  const external = vi.fn(async (spec: Record<string, unknown>) => {
    if (over.externalThrows) throw over.externalThrows;
    // The gateway hands back the stored result (`toResult` = `{ value: parsed content }`).
    const send = spec.send as (signal: AbortSignal, timeoutMs: number) => Promise<{ kind: string; content?: string }>;
    const outcome = await send(new AbortController().signal, 5_000);
    if (outcome.kind !== 'ok') throw new Error(`unexpected outcome ${outcome.kind}`);
    const value = JSON.parse(outcome.content ?? 'null') as { answer: unknown };
    return { value, callId: 'call_plugin', attemptIds: ['att_plugin'] };
  });
  const currency = vi.fn(async () => 'USD');
  return { chat, external, currency };
}

describe('translation service routing', () => {
  it('not selected: the LLM answers, and nothing is recorded as a plugin call', async () => {
    const g = gateway();
    const router = new TranslationServiceRouter({ db: settingsDb(null), gateway: g as unknown as TranslationGateway });
    const out = await router.translate(request());
    expect(out).toMatchObject({ engine: 'llm', provider: 'OpenAI', model: 'gpt-test', callId: 'call_llm' });
    expect(g.chat).toHaveBeenCalledTimes(1);
    expect(g.external).not.toHaveBeenCalled();
  });

  it('selected: the plugin answers, with the host filling in engine, provider, model and callId', async () => {
    const g = gateway();
    const service = pluginService();
    const router = new TranslationServiceRouter({
      db: settingsDb('heopress-deepl:deepl'),
      gateway: g as unknown as TranslationGateway,
      plugins: { resolve: async () => service },
    });
    const out = await router.translate(request());
    expect(out).toEqual({
      segments: [
        { id: 's1', text: '译:Hello, ' },
        { id: 's2', text: '译:world!' },
      ],
      engine: 'plugin:heopress-deepl',
      provider: 'plugin:heopress-deepl',
      model: 'deepl',
      callId: 'call_plugin',
    });
    expect(g.chat).not.toHaveBeenCalled();
    expect(g.external).toHaveBeenCalledTimes(1);
    const spec = g.external.mock.calls[0]![0] as unknown as {
      siteId: string;
      taskType: string;
      capability: string;
      characters: number;
      attempts: number;
      candidate: ReturnType<typeof pluginTranslationCandidate>;
    };
    expect(spec).toMatchObject({ siteId: 'site_a', taskType: 'translation', capability: 'translate', attempts: 1, characters: 13 });
    expect(spec.candidate).toMatchObject({
      name: 'plugin:heopress-deepl',
      instanceRef: 'plugin:heopress-deepl/deepl',
      model: 'deepl',
      currency: 'USD',
      pricing: { kind: 'per_1m_chars', charsMicros: 20_000_000 },
    });
    // The plugin saw the request, not the host's ledger details.
    expect(service.calls[0]).toMatchObject({ siteId: 'site_a', sourceLocale: 'en', targetLocale: 'zh-CN' });
  });

  it('selected but not offered: fails with SERVICE_UNAVAILABLE instead of falling back to the model', async () => {
    const g = gateway();
    const router = new TranslationServiceRouter({
      db: settingsDb('heopress-deepl:deepl'),
      gateway: g as unknown as TranslationGateway,
      plugins: { resolve: async () => null },
    });
    await expect(router.translate(request())).rejects.toMatchObject({ name: 'TranslationError', code: 'SERVICE_UNAVAILABLE' });
    expect(g.chat).not.toHaveBeenCalled();
    expect(g.external).not.toHaveBeenCalled();
  });

  it('selected but the ledger is unavailable: fails rather than recording nothing', async () => {
    const router = new TranslationServiceRouter({
      db: settingsDb('heopress-deepl:deepl'),
      gateway: { chat: vi.fn() } as unknown as TranslationGateway,
      plugins: { resolve: async () => pluginService() },
    });
    await expect(router.translate(request())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('a plugin answer that is not the requested segments is BAD_TRANSLATION', async () => {
    const g = gateway();
    const service = pluginService({
      translate: async () => ({ segments: [{ id: 's1', text: 'only one' }] }),
    });
    const router = new TranslationServiceRouter({
      db: settingsDb('heopress-deepl:deepl'),
      gateway: g as unknown as TranslationGateway,
      plugins: { resolve: async () => service },
    });
    await expect(router.translate(request())).rejects.toBeInstanceOf(TranslationError);
    // The call was sent and recorded: the plugin processed the characters even though its answer is unusable.
    expect(g.external).toHaveBeenCalledTimes(1);
  });

  it('an empty request is refused before anything is loaded or recorded', async () => {
    const g = gateway();
    const router = new TranslationServiceRouter({ db: settingsDb('heopress-deepl:deepl'), gateway: g as unknown as TranslationGateway });
    await expect(router.translate(request({ segments: [] }))).rejects.toMatchObject({ code: 'EMPTY_REQUEST' });
    expect(g.external).not.toHaveBeenCalled();
  });
});

describe('the plugin translation candidate', () => {
  it('is named after the plugin, modelled by its engine and priced per character', () => {
    const candidate = pluginTranslationCandidate(pluginService(), 'CNY');
    expect(candidate).toMatchObject({
      source: 'instance',
      instanceRef: 'plugin:heopress-deepl/deepl',
      name: 'plugin:heopress-deepl',
      protocol: 'plugin',
      baseUrl: null,
      model: 'deepl',
      currency: 'CNY',
      pricing: { kind: 'per_1m_chars', charsMicros: 20_000_000 },
    });
  });

  it('prices a service that declares nothing at zero', () => {
    const candidate = pluginTranslationCandidate(pluginService({ charsMicros: 0 }), 'USD');
    expect(candidate.pricing).toEqual({ kind: 'per_1m_chars', charsMicros: 0 });
  });

  it('built-in selection: answered by the two-model service, never resolved as a plugin', async () => {
    const g = gateway();
    const resolve = vi.fn(async () => pluginService());
    const dualModel = {
      translate: vi.fn(async () => ({
        segments: request().segments,
        engine: 'heopress:dual-model',
        provider: 'provider-p_draft',
        model: 'model-p_draft',
        callId: 'call-p_draft',
      })),
    };
    const router = new TranslationServiceRouter({
      db: settingsDb('heopress:dual-model'),
      gateway: g as unknown as TranslationGateway,
      plugins: { resolve },
      dualModel,
    });
    const out = await router.translate(request());
    expect(out).toMatchObject({ engine: 'heopress:dual-model', provider: 'provider-p_draft', model: 'model-p_draft' });
    expect(dualModel.translate).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(g.chat).not.toHaveBeenCalled();
    expect(g.external).not.toHaveBeenCalled();
  });

  it('built-in selection without a gateway that can call one binding fails clearly instead of falling back', async () => {
    const router = new TranslationServiceRouter({
      db: settingsDb('heopress:dual-model'),
      gateway: { chat: vi.fn() } as unknown as TranslationGateway,
    });
    await expect(router.translate(request())).rejects.toMatchObject({ name: 'TranslationError', code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('plugin failures and the deadline', () => {
  /** A ledger that runs the plugin's `send` and records its outcome, then stops (the real gateway classifies it). */
  async function sendOutcome(service: LoadedTranslationService): Promise<unknown> {
    const seen: { outcome?: unknown } = {};
    const gateway = {
      currency: async () => 'USD',
      external: async (spec: { attempts: number; send: (signal: AbortSignal, timeoutMs: number) => Promise<unknown> }) => {
        expect(spec.attempts).toBe(1);
        seen.outcome = await spec.send(new AbortController().signal, 5_000);
        throw new Error('the ledger stopped here');
      },
    };
    await expect(translateWithPlugin(gateway as never, service, request())).rejects.toThrow('the ledger stopped here');
    return seen.outcome;
  }

  it('a plugin that throws is a failed outcome with our code, not a raw error and not a retry', async () => {
    expect(
      await sendOutcome(
        pluginService({
          translate: async () => {
            throw new Error('upstream said no');
          },
        }),
      ),
    ).toEqual({ kind: 'failed', errorCode: 'PLUGIN_ERROR' });
  });

  it('a plugin that never answers is stopped at its deadline and reported as PLUGIN_TIMEOUT', async () => {
    const started = Date.now();
    const outcome = await sendOutcome(
      pluginService({ durationMs: 100, translate: () => new Promise(() => undefined) }),
    );
    expect(outcome).toEqual({ kind: 'failed', errorCode: 'PLUGIN_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
