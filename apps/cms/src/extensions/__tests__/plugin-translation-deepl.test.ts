/**
 * The official DeepL translation provider (HeoPress v1.2, backlog P09; spec extensions/translation-services):
 * the manifest is a valid, signed-namespace declaration of exactly one service; `translate` sends only the request's
 * segments to DeepL in its per-request sizes, maps the locales, mirrors the glossary, and maps DeepL's refusals.
 *
 * The plugin is not a workspace package, so this suite drives its source with a fake `PluginContext` and a fake HTTP
 * transport — the same shape the host passes — instead of building it. The end-to-end behaviour through a real
 * `PluginHost` (install → approve → enable → select → ledger row) is
 * `apps/cms/src/__tests__/deepl-provider.db.integration.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { charsMicrosOf, translationDeclarationIssues, translationServicesOf } from '@heopress/contracts/extensions';
import { ExtensionManifestSchema } from '@heopress/contracts/schemas';
import type { TranslationAnswer, TranslationServiceContext, TranslationServiceDefinition } from '@heopress/extension-sdk';
import deeplPlugin, {
  MAX_REQUEST_BYTES,
  MAX_TEXTS_PER_REQUEST,
  SECRET_NAME,
  batchSegments,
  canonicalGlossary,
  deepLBaseUrl,
  fnv1a64,
  glossaryCacheKey,
  glossaryName,
  glossaryTsv,
  mapSourceRoot,
  mapTargetLang,
  type GlossaryTerm,
} from '../../../../../examples/plugin-translation-deepl/src/index';

const PLUGIN_ROOT = new URL('../../../../../examples/plugin-translation-deepl/', import.meta.url);
const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('heopress-extension.json', PLUGIN_ROOT)), 'utf8')) as Record<string, unknown>;
const SOURCE = readFileSync(fileURLToPath(new URL('src/index.ts', PLUGIN_ROOT)), 'utf8');

/** One recorded HTTP call, with its JSON body parsed for assertions. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Handler = (call: Call) => Response | Promise<Response>;

interface HarnessOptions {
  /** The key `ctx.secrets.get` resolves; null/undefined means the host configured none. */
  key?: string | null;
  /** Make `ctx.kv` throw on every call, like a host without the binding. */
  kvUnavailable?: boolean;
  /** Seed `ctx.kv` with entries. */
  kv?: Record<string, string>;
  /** Make `ctx.secrets.get` throw, like a missing capability. */
  secretsThrow?: boolean;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-trace-id': 'trace-1' } });

/** A fake HTTP transport: every call is recorded, the handler decides the answer. */
function harness(handler: Handler, options: HarnessOptions = {}) {
  const calls: Call[] = [];
  const kv = new Map<string, string>(Object.entries(options.kv ?? {}));
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>),
    };
    calls.push(call);
    return handler(call);
  };
  const registered: unknown[] = [];
  const ctx = {
    secrets: {
      get: async (name: string): Promise<string | null> => {
        if (options.secretsThrow) throw new Error('Plugin secrets are not available in this context.');
        expect(name).toBe(SECRET_NAME);
        return options.key === undefined ? 'test-key' : options.key;
      },
    },
    fetch,
    kv: {
      get: async (key: string): Promise<string | null> => {
        if (options.kvUnavailable) throw new Error('kv is not bound');
        return kv.get(key) ?? null;
      },
      put: async (key: string, value: string): Promise<void> => {
        if (options.kvUnavailable) throw new Error('kv is not bound');
        kv.set(key, value);
      },
      delete: async (key: string): Promise<void> => {
        kv.delete(key);
      },
    },
    extensionPoints: {
      register: (point: string, definition: unknown) => {
        expect(point).toBe('translation-services');
        registered.push(definition);
      },
    },
  };
  deeplPlugin(ctx as never);
  const service = registered[0] as TranslationServiceDefinition;
  return { ctx, service, calls, kv, registered };
}

/** A translate call's request: two segments by default, one glossary term per language pair at most. */
function request(over: Partial<TranslationServiceContext> = {}): TranslationServiceContext {
  return {
    siteId: 'site_deepl_a',
    sourceLocale: 'en',
    targetLocale: 'zh-CN',
    segments: [
      { id: 's1', text: 'Hello, ' },
      { id: 's2', text: 'world!' },
    ],
    glossary: [],
    memory: [],
    signal: new AbortController().signal,
    ...over,
  };
}

/** The DeepL answer for the texts a translate call sent, prefixed so the mapping is visible. */
function answerWithPrefix(prefix = '译:'): Handler {
  return (call) => {
    const texts = (call.body?.text as string[] | undefined) ?? [];
    return json({ translations: texts.map((text, index) => ({ detected_source_language: 'EN', text: `${index}:${prefix}${text}` })) });
  };
}

const translateCalls = (calls: readonly Call[]) => calls.filter((call) => call.url.endsWith('/v2/translate'));

/** The rejection of a translate call (`translate` may answer synchronously in the type), or null if it resolved. */
async function rejectionOf(value: TranslationAnswer | Promise<TranslationAnswer>): Promise<unknown> {
  try {
    await value;
  } catch (error) {
    return error;
  }
  return null;
}

describe('DeepL plugin: the manifest', () => {
  it('is a valid official declaration of one service, priced and with the hosts and the secret it uses', () => {
    const parsed = ExtensionManifestSchema.parse(MANIFEST);
    expect(parsed.name).toBe('heopress-deepl');
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.type).toBe('module');
    expect([...parsed.capabilities].sort()).toEqual(
      [
        'ext:translation-services',
        'http:fetch:api-free.deepl.com',
        'http:fetch:api.deepl.com',
        'kv:read',
        'kv:write',
        'secrets:deepl_api_key',
      ].sort(),
    );
    expect(translationDeclarationIssues(parsed, parsed.capabilities)).toEqual([]);
    const services = translationServicesOf(parsed);
    expect(services).toEqual([
      { id: 'deepl', displayName: 'DeepL', engine: 'deepl', pricePerMillionChars: 27.5 },
    ]);
    expect(charsMicrosOf(services[0]!.pricePerMillionChars)).toBe(27_500_000);
    expect(parsed.extensionPoints).toEqual({ 'translation-services': '^1.0.0', context: '^1.0.0' });
    // It declares no capabilities it must not hold (no db, env, service account, host-less fetch).
    expect(parsed.capabilities.filter((capability) => /^(db:|env:|service-account|http:fetch$)/.test(capability))).toEqual([]);
    // The manifest has no inline key field of any shape.
    expect(Object.keys(MANIFEST)).not.toContain('secrets');
    expect(JSON.stringify(MANIFEST)).not.toMatch(/authorization|DeepL-Auth-Key|"apiKey"/i);
  });

  it('carries only types from the SDK, so the built bundle has no runtime import', () => {
    const imports = [...SOURCE.matchAll(/^import\s+(type\s+)?[^;]+?from\s+'([^']+)';/gms)];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.map((match) => match[2])).toEqual(['@heopress/extension-sdk']);
    expect(imports[0]![1]).toBe('type ');
    expect(SOURCE).not.toMatch(/from\s+['"](?:node:|[^'"]*(?:crypto|axios|undici))/);
  });

  it('registers exactly one service with the id the manifest declares, a deadline and a request budget', () => {
    const { registered } = harness(answerWithPrefix());
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ id: 'deepl', maxDurationMs: 30_000, maxRequests: 40 });
  });
});

describe('DeepL plugin: request shape', () => {
  it('sends one JSON request with only the segments, the target and the source languages', async () => {
    const { service, calls } = harness(answerWithPrefix());
    const answer = await service.translate(request());
    expect(answer).toEqual({
      segments: [
        { id: 's1', text: '0:译:Hello, ' },
        { id: 's2', text: '1:译:world!' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://api.deepl.com/v2/translate', method: 'POST' });
    expect(calls[0]!.headers).toMatchObject({ authorization: 'DeepL-Auth-Key test-key', 'content-type': 'application/json' });
    expect(calls[0]!.body).toEqual({ text: ['Hello, ', 'world!'], target_lang: 'ZH-HANS', source_lang: 'EN' });
    // Nothing but the segments and the languages: no site id, no glossary, no prompt.
    expect(Object.keys(calls[0]!.body ?? {}).sort()).toEqual(['source_lang', 'target_lang', 'text']);
  });

  it('uses the free host for a Free key and the pro host otherwise', async () => {
    expect(deepLBaseUrl('abc:fx')).toBe('https://api-free.deepl.com');
    expect(deepLBaseUrl('abc-123')).toBe('https://api.deepl.com');
    const { service, calls } = harness(answerWithPrefix(), { key: 'free-key:fx' });
    await service.translate(request({ targetLocale: 'de' }));
    expect(calls[0]!.url).toBe('https://api-free.deepl.com/v2/translate');
  });

  it('maps locales to DeepL codes and refuses an unsupported target without a request', async () => {
    expect(mapTargetLang('zh-CN')).toBe('ZH-HANS');
    expect(mapTargetLang('zh-TW')).toBe('ZH-HANT');
    expect(mapTargetLang('zh-Hant')).toBe('ZH-HANT');
    expect(mapTargetLang('pt-BR')).toBe('PT-BR');
    expect(mapTargetLang('pt-PT')).toBe('PT-PT');
    expect(mapTargetLang('pt')).toBe('PT-PT');
    expect(mapTargetLang('en-GB')).toBe('EN-GB');
    expect(mapTargetLang('en-AU')).toBe('EN-US');
    expect(mapTargetLang('de-CH')).toBe('DE-CH');
    expect(mapTargetLang('fr-CA')).toBe('FR-CA');
    expect(mapTargetLang('es-419')).toBe('ES-419');
    expect(mapTargetLang('ja-JP')).toBe('JA');
    expect(mapTargetLang('th')).toBeNull();
    expect(mapSourceRoot('en-GB')).toBe('EN');
    expect(mapSourceRoot('pt-BR')).toBe('PT');
    expect(mapSourceRoot('xx')).toBeNull();

    const { service, calls } = harness(answerWithPrefix());
    await expect(service.translate(request({ targetLocale: 'th' }))).rejects.toMatchObject({
      name: 'DEEPL_UNSUPPORTED_LOCALE',
      code: 'DEEPL_UNSUPPORTED_LOCALE',
    });
    expect(calls).toEqual([]);
  });

  it('omits source_lang for a language DeepL does not read instead of guessing one', async () => {
    const { service, calls } = harness(answerWithPrefix());
    await service.translate(request({ sourceLocale: 'xx' }));
    expect(calls[0]!.body).toEqual({ text: ['Hello, ', 'world!'], target_lang: 'ZH-HANS' });
  });

  it('splits at DeepL’s 50-texts-per-request limit and keeps the request order across batches', async () => {
    const segments = Array.from({ length: 51 }, (_, index) => ({ id: `s${index}`, text: `text ${index}` }));
    const { service, calls } = harness(answerWithPrefix());
    const answer = await service.translate(request({ segments }));
    expect(translateCalls(calls)).toHaveLength(2);
    expect((calls[0]!.body?.text as string[]).length).toBe(MAX_TEXTS_PER_REQUEST);
    expect((calls[1]!.body?.text as string[]).length).toBe(1);
    expect(answer.segments.map((segment) => segment.id)).toEqual(segments.map((segment) => segment.id));
    expect(answer.segments[0]).toEqual({ id: 's0', text: '0:译:text 0' });
    expect(answer.segments[50]).toEqual({ id: 's50', text: '0:译:text 50' });
  });

  it('splits on DeepL’s request-body limit and never sends a body over it', async () => {
    const segments = Array.from({ length: 100 }, (_, index) => ({ id: `s${index}`, text: `${index}-`.padEnd(3_000, 'x') }));
    const { service, calls } = harness(answerWithPrefix());
    const answer = await service.translate(request({ segments }));
    expect(translateCalls(calls).length).toBeGreaterThan(1);
    for (const call of translateCalls(calls)) {
      expect(Buffer.byteLength(JSON.stringify(call.body), 'utf8')).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
      expect((call.body?.text as string[]).length).toBeLessThanOrEqual(MAX_TEXTS_PER_REQUEST);
    }
    expect(answer.segments.map((segment) => segment.id)).toEqual(segments.map((segment) => segment.id));
  });

  it('refuses a single segment that cannot fit one request without sending anything', async () => {
    const huge = [{ id: 's1', text: 'x'.repeat(MAX_REQUEST_BYTES + 1_024) }];
    const { service, calls } = harness(answerWithPrefix());
    await expect(service.translate(request({ segments: huge }))).rejects.toMatchObject({
      name: 'DEEPL_REQUEST_TOO_LARGE',
      code: 'DEEPL_REQUEST_TOO_LARGE',
    });
    expect(calls).toEqual([]);
    expect(() => batchSegments(huge, 'ZH-HANS', 'EN')).toThrow(/DEEPL_REQUEST_TOO_LARGE/);
  });

  it('refuses a call that would need more translate requests than its budget before sending one', async () => {
    const segments = Array.from({ length: 1_000 }, (_, index) => ({ id: `s${index}`, text: 'y'.repeat(6_000) }));
    const { service, calls } = harness(answerWithPrefix());
    await expect(service.translate(request({ segments }))).rejects.toMatchObject({
      name: 'DEEPL_TOO_MANY_SEGMENTS',
      code: 'DEEPL_TOO_MANY_SEGMENTS',
    });
    expect(calls).toEqual([]);
  });

  it('returns the requested ids in the requested order', async () => {
    const { service } = harness(() =>
      json({ translations: [{ text: 'B' }, { text: 'A' }] }),
    );
    const answer = await service.translate(request());
    expect(answer.segments).toEqual([
      { id: 's1', text: 'B' },
      { id: 's2', text: 'A' },
    ]);
  });
});

describe('DeepL plugin: glossary', () => {
  const TERMS: GlossaryTerm[] = [
    { source: 'World', target: '世界' },
    { source: 'Hello', target: '你好' },
    { source: 'Hello', target: '重复' },
    { source: '', target: '空' },
    { source: 'Bad\ttab', target: '制表符' },
  ];
  const SITE = 'site_deepl_a';
  const NAME = glossaryName(SITE, 'en', 'zh');
  const KEY = glossaryCacheKey(SITE, 'en', 'zh');
  const TSV = 'Hello\t你好\nWorld\t世界';
  const HASH = fnv1a64(TSV);

  it('canonicalises terms deterministically: trims, dedupes by source, drops what DeepL cannot store, sorts', () => {
    expect(canonicalGlossary(TERMS)).toEqual([
      { source: 'Hello', target: '你好' },
      { source: 'World', target: '世界' },
    ]);
    expect(glossaryTsv(canonicalGlossary(TERMS))).toBe(TSV);
    expect(fnv1a64(TSV)).toBe(HASH);
    // The same de-duplicated set in a different order produces the same TSV and hash.
    const reordered: GlossaryTerm[] = [{ source: 'World', target: '世界' }, { source: 'Hello', target: '你好' }];
    expect(fnv1a64(glossaryTsv(canonicalGlossary(reordered)))).toBe(HASH);
    expect(fnv1a64('other')).not.toBe(HASH);
    expect(canonicalGlossary([{ source: 'a'.repeat(1_025), target: 'b' }])).toEqual([]);
  });

  it('sends no glossary request when the request carries no terms', async () => {
    const { service, calls } = harness(answerWithPrefix());
    await service.translate(request());
    expect(calls.filter((call) => call.url.includes('/v3/glossaries'))).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('lists, creates and caches a glossary, then translates with its id', async () => {
    const { service, calls, kv } = harness((call) => {
      if (call.url.endsWith('/v3/glossaries') && call.method === 'GET') return json({ glossaries: [] });
      if (call.url.endsWith('/v3/glossaries') && call.method === 'POST') return json({ glossary_id: 'glossary-1', ready: true });
      return answerWithPrefix()(call);
    });
    await service.translate(request({ glossary: TERMS }));

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.deepl.com/v3/glossaries',
      'POST https://api.deepl.com/v3/glossaries',
      'POST https://api.deepl.com/v2/translate',
    ]);
    expect(calls[1]!.body).toEqual({
      name: NAME,
      dictionaries: [{ source_lang: 'en', target_lang: 'zh', entries: TSV, entries_format: 'tsv' }],
    });
    expect(calls[2]!.body?.glossary_id).toBe('glossary-1');
    expect(JSON.parse(kv.get(KEY) ?? '{}')).toEqual({ id: 'glossary-1', hash: HASH });
  });

  it('reuses a cached glossary for the same terms without a glossary request', async () => {
    const { service, calls } = harness(answerWithPrefix(), { kv: { [KEY]: JSON.stringify({ id: 'glossary-1', hash: HASH }) } });
    await service.translate(request({ glossary: TERMS }));
    expect(calls.map((call) => call.url)).toEqual(['https://api.deepl.com/v2/translate']);
    expect(calls[0]!.body?.glossary_id).toBe('glossary-1');
  });

  it('replaces the dictionary when the terms changed and updates the cache', async () => {
    const changed: GlossaryTerm[] = [{ source: 'Hello', target: '您好' }];
    const { service, calls, kv } = harness((call) => {
      if (call.url.includes('/v3/glossaries/') && call.method === 'PUT') return json({ entry_count: 1 });
      return answerWithPrefix()(call);
    }, { kv: { [KEY]: JSON.stringify({ id: 'glossary-1', hash: HASH }) } });
    await service.translate(request({ glossary: changed }));

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'PUT https://api.deepl.com/v3/glossaries/glossary-1/dictionaries',
      'POST https://api.deepl.com/v2/translate',
    ]);
    expect(calls[0]!.body).toEqual({ source_lang: 'en', target_lang: 'zh', entries: 'Hello\t您好', entries_format: 'tsv' });
    expect(calls[1]!.body?.glossary_id).toBe('glossary-1');
    expect(JSON.parse(kv.get(KEY) ?? '{}')).toEqual({ id: 'glossary-1', hash: fnv1a64('Hello\t您好') });
  });

  it('finds an existing glossary by name when the cache is not bound, and updates it', async () => {
    const { service, calls } = harness((call) => {
      if (call.url.endsWith('/v3/glossaries') && call.method === 'GET') {
        return json({ glossaries: [{ glossary_id: 'glossary-9', name: NAME, dictionaries: [{ source_lang: 'en', target_lang: 'zh', entry_count: 2 }] }] });
      }
      if (call.url.includes('/v3/glossaries/') && call.method === 'PUT') return json({ entry_count: 2 });
      return answerWithPrefix()(call);
    }, { kvUnavailable: true });
    await service.translate(request({ glossary: TERMS }));
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.deepl.com/v3/glossaries',
      'PUT https://api.deepl.com/v3/glossaries/glossary-9/dictionaries',
      'POST https://api.deepl.com/v2/translate',
    ]);
    expect(calls[2]!.body?.glossary_id).toBe('glossary-9');
  });

  it('falls back to translating without a glossary id when DeepL refuses the glossary endpoints', async () => {
    const { service, calls } = harness((call) => {
      if (call.url.includes('/v3/glossaries')) return json({ message: 'Forbidden' }, 403);
      return answerWithPrefix()(call);
    });
    const answer = await service.translate(request({ glossary: TERMS }));
    expect(answer.segments).toHaveLength(2);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.deepl.com/v3/glossaries',
      'POST https://api.deepl.com/v2/translate',
    ]);
    expect(calls[1]!.body?.glossary_id).toBeUndefined();
    // The still-valid batch must have been translated; nothing about the omission is disguised as success.
    expect(calls[1]!.body).toEqual({ text: ['Hello, ', 'world!'], target_lang: 'ZH-HANS', source_lang: 'EN' });
  });

  it('does not swallow an aborted call into a glossary-less translation', async () => {
    const controller = new AbortController();
    const { service, calls } = harness((call) => {
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    await expect(service.translate(request({ glossary: TERMS, signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/v3/glossaries');
  });

  it('does not apply a glossary when the source language is unknown', async () => {
    const { service, calls } = harness(answerWithPrefix());
    await service.translate(request({ sourceLocale: 'xx', glossary: TERMS }));
    expect(calls.map((call) => call.url)).toEqual(['https://api.deepl.com/v2/translate']);
    expect(calls[0]!.body?.glossary_id).toBeUndefined();
  });
});

describe('DeepL plugin: failures', () => {
  it('fails with a typed error when the host configured no key, before any request', async () => {
    const { service, calls } = harness(answerWithPrefix(), { key: null });
    await expect(service.translate(request())).rejects.toMatchObject({ name: 'DEEPL_NO_API_KEY', code: 'DEEPL_NO_API_KEY' });
    expect(calls).toEqual([]);
  });

  it('treats a throwing secret resolver as no key', async () => {
    const { service, calls } = harness(answerWithPrefix(), { secretsThrow: true });
    await expect(service.translate(request())).rejects.toMatchObject({ code: 'DEEPL_NO_API_KEY' });
    expect(calls).toEqual([]);
  });

  it.each([
    [429, 'DEEPL_RATE_LIMITED'],
    [456, 'DEEPL_QUOTA_EXCEEDED'],
    [403, 'DEEPL_AUTH_FAILED'],
    [401, 'DEEPL_UNAUTHORIZED'],
    [400, 'DEEPL_BAD_REQUEST'],
    [500, 'DEEPL_UNAVAILABLE'],
    [503, 'DEEPL_UNAVAILABLE'],
  ])('maps DeepL HTTP %i to %s without retrying', async (status, code) => {
    const { service, calls } = harness((call) => json({ message: 'refused' }, status));
    const failure = await rejectionOf(service.translate(request()));
    expect(failure).toMatchObject({ name: code, code, status });
    expect(calls).toHaveLength(1);
  });

  it('does not leak the key or a segment into the error message', async () => {
    const key = 'secret-key-value-123';
    const { service } = harness((call) => json({ message: 'Invalid request' }, 400), { key });
    const failure = (await rejectionOf(service.translate(request()))) as Error;
    expect(failure.message).toContain('DEEPL_BAD_REQUEST');
    expect(failure.message).toContain('Invalid request');
    expect(failure.message).not.toContain(key);
    expect(failure.message).not.toContain('Hello, ');
    expect(failure.message).not.toContain('world!');
  });

  it('fails the whole translation when a batch answer has the wrong number of segments', async () => {
    const { service } = harness(() => json({ translations: [{ text: 'only one' }] }));
    await expect(service.translate(request())).rejects.toMatchObject({ name: 'DEEPL_BAD_RESPONSE', code: 'DEEPL_BAD_RESPONSE' });
  });

  it('fails the whole translation on a segment without text', async () => {
    const { service } = harness(() => json({ translations: [{ text: 'a' }, { detected_source_language: 'EN' }] }));
    await expect(service.translate(request())).rejects.toMatchObject({ code: 'DEEPL_BAD_RESPONSE' });
  });

  it('turns a network failure into a typed error', async () => {
    const { service } = harness(() => {
      throw new TypeError('fetch failed');
    });
    await expect(service.translate(request())).rejects.toMatchObject({ name: 'DEEPL_REQUEST_FAILED', code: 'DEEPL_REQUEST_FAILED' });
  });

  it('turns a non-JSON success body into a typed error', async () => {
    const { service } = harness(() => new Response('<html>', { status: 200 }));
    await expect(service.translate(request())).rejects.toMatchObject({ code: 'DEEPL_BAD_RESPONSE' });
  });

  it('does not return the first batch when a later batch fails', async () => {
    const segments = Array.from({ length: 51 }, (_, index) => ({ id: `s${index}`, text: `text ${index}` }));
    let translateCount = 0;
    const { service } = harness((call) => {
      if (call.url.endsWith('/v2/translate')) {
        translateCount += 1;
        if (translateCount === 2) return json({ message: 'Too many requests' }, 429);
      }
      return answerWithPrefix()(call);
    });
    await expect(service.translate(request({ segments }))).rejects.toMatchObject({ code: 'DEEPL_RATE_LIMITED' });
    expect(translateCount).toBe(2);
  });

  it('propagates an abort with no answer request made', async () => {
    const controller = new AbortController();
    controller.abort();
    const { service, calls } = harness(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    await expect(service.translate(request({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
  });
});
