/**
 * The official HeoPress DeepL translation provider (HeoPress v1.2, backlog P09 "专用机器翻译服务与术语表同步").
 *
 * It registers one machine-translation service, `deepl`, on the `translation-services` extension point. A site selects it
 * with `translationService = "heopress-deepl:deepl"`; from then on its translations are answered by DeepL instead of the
 * site's language model, and the host bills them by characters (the manifest's `pricePerMillionChars`).
 *
 * What this file does, and nothing more:
 *   - it sends the request's segments to `POST /v2/translate`, in batches of at most 50 texts and 128 KiB of body, and
 *     returns exactly the requested segment ids in the requested order;
 *   - it maps HeoPress locales to DeepL language codes and never guesses an unsupported target language;
 *   - it mirrors the request's `glossary` terms into a DeepL glossary (created once per site and language pair, reused by
 *     content hash, updated with the v3 "replace dictionary" call) and passes `glossary_id` on translation;
 *   - it turns DeepL's refusals into typed failures the host records.
 *
 * What the host does, not this file: capability checks, the per-call deadline and outbound-request budget, the answer's
 * shape, the ledger row priced by characters, and the `engine`/`provider`/`model`/`callId` fields of the result. The
 * service reaches DeepL only through `ctx.fetch` (the manifest declares `http:fetch:api.deepl.com` and
 * `http:fetch:api-free.deepl.com`) and reads its key only through `ctx.secrets.get('deepl_api_key')`.
 *
 * Only types are imported from `@heopress/extension-sdk`, so the built `dist/index.js` has no runtime import and the host
 * loads it as one self-contained module (`defineTranslationService` is an identity helper + a `kind` marker; the host
 * validates the registration itself).
 */
import type {
  PluginContext,
  TranslationAnswer,
  TranslationSegment,
  TranslationServiceContext,
  TranslationServiceDefinition,
} from '@heopress/extension-sdk';

/** The service id; `heopress-extension.json` declares the same id with its display name, engine and price. */
export const SERVICE_ID = 'deepl';
/** The secret the operator configures for this plugin on the site (`secrets:deepl_api_key`). */
export const SECRET_NAME = 'deepl_api_key';
/** DeepL's published API Growth overage price, in US dollars per million characters (README cites the page). */
export const PRICE_PER_MILLION_CHARS = 27.5;
/** DeepL `/v2/translate` accepts at most 50 `text` entries per request. */
export const MAX_TEXTS_PER_REQUEST = 50;
/** DeepL accepts request bodies up to 128 KiB; leave 8 KiB for field names and JSON escaping. */
export const MAX_REQUEST_BYTES = 120 * 1024;
/** The service declares `maxRequests: 40`; three requests are reserved for the glossary (cache miss + replace + retry). */
export const MAX_TRANSLATE_REQUESTS = 37;
/** A glossary source/target phrase and the glossary name are limited to 1024 UTF-8 bytes by DeepL. */
export const MAX_GLOSSARY_PHRASE_BYTES = 1024;
/** Per-call duration this service asks for (the host's default is 20 000 ms, its ceiling 60 000 ms). */
export const MAX_DURATION_MS = 30_000;
/** Outbound requests this service asks for (the host's ceiling is 100; batches + glossary fit well inside 40). */
export const MAX_REQUESTS = 40;
/** KV key prefix of the glossary cache (the cache is per plugin and site already, the site token keeps keys distinct). */
const GLOSSARY_CACHE_PREFIX = 'deepl:glossary:';
/** KV key of the best-effort record of the last glossary failure (no terms, no key). */
const GLOSSARY_ERROR_KEY = 'deepl:glossary:last-error';
/** Placeholder glossary id used when measuring a batch's request body (a real id is a UUID, shorter than this). */
const GLOSSARY_ID_ALLOWANCE = 36;
/** Free keys end with `:fx`; they must talk to the free host. */
const FREE_KEY_SUFFIX = ':fx';

const textEncoder = new TextEncoder();
/** Control characters cannot be represented in a TSV glossary entry (two columns, one line per entry). */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** The typed failures this plugin raises; the host records any of them as one failed plugin call. */
export type DeepLErrorCode =
  | 'DEEPL_NO_API_KEY'
  | 'DEEPL_UNAUTHORIZED'
  | 'DEEPL_AUTH_FAILED'
  | 'DEEPL_BAD_REQUEST'
  | 'DEEPL_QUOTA_EXCEEDED'
  | 'DEEPL_RATE_LIMITED'
  | 'DEEPL_UNAVAILABLE'
  | 'DEEPL_REQUEST_FAILED'
  | 'DEEPL_BAD_RESPONSE'
  | 'DEEPL_UNSUPPORTED_LOCALE'
  | 'DEEPL_REQUEST_TOO_LARGE'
  | 'DEEPL_TOO_MANY_SEGMENTS';

/**
 * One failed DeepL call. `message` starts with the code and never contains the API key, a segment's text or a glossary
 * term; the host keeps the code in its logs (the ledger's `errorCode` column is the host's `PLUGIN_ERROR`).
 */
export class DeepLError extends Error {
  readonly code: DeepLErrorCode;
  readonly status: number | null;
  readonly traceId: string | null;

  constructor(code: DeepLErrorCode, message: string, options: { status?: number; traceId?: string | null } = {}) {
    super(`${code}: ${message}`);
    this.name = code;
    this.code = code;
    this.status = options.status ?? null;
    this.traceId = options.traceId ?? null;
  }
}

/** The DeepL host a key belongs to: Free keys (`…:fx`) go to `api-free`, everything else to `api`. */
export function deepLBaseUrl(key: string): string {
  return key.trim().toLowerCase().endsWith(FREE_KEY_SUFFIX) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}

/** The languages DeepL supports (its glossary source-language list, which is also the translation language list). */
const BASE_LANGUAGES: Readonly<Record<string, string>> = {
  ar: 'AR',
  bg: 'BG',
  cs: 'CS',
  da: 'DA',
  de: 'DE',
  el: 'EL',
  en: 'EN-US',
  es: 'ES',
  et: 'ET',
  fi: 'FI',
  fr: 'FR',
  he: 'HE',
  hu: 'HU',
  id: 'ID',
  it: 'IT',
  ja: 'JA',
  ko: 'KO',
  lt: 'LT',
  lv: 'LV',
  nb: 'NB',
  nl: 'NL',
  pl: 'PL',
  pt: 'PT-PT',
  ro: 'RO',
  ru: 'RU',
  sk: 'SK',
  sl: 'SL',
  sv: 'SV',
  tr: 'TR',
  uk: 'UK',
  vi: 'VI',
  zh: 'ZH-HANS',
};

/**
 * The DeepL `target_lang` of a HeoPress locale, or null when DeepL does not translate into it. Variants are mapped the way
 * DeepL defines them: `zh-CN` → `ZH-HANS`, `zh-TW`/`zh-HK`/`zh-Hant` → `ZH-HANT`, `pt-BR` → `PT-BR`, otherwise `PT-PT`;
 * English variants DeepL does not offer fall back to `EN-US` (British/Irish spellings to `EN-GB`), and `de-CH`, `fr-CA`,
 * `es-419` keep their variant.
 */
export function mapTargetLang(locale: string): string | null {
  const tag = locale.trim().toLowerCase().replace(/_/g, '-');
  const [language, region] = tag.split('-');
  if (!language || !(language in BASE_LANGUAGES)) return null;
  if (language === 'zh') {
    const traditional = region === 'tw' || region === 'hk' || region === 'mo' || /(^|-)hant($|-)/.test(tag);
    return traditional ? 'ZH-HANT' : 'ZH-HANS';
  }
  if (language === 'pt') return region === 'br' ? 'PT-BR' : 'PT-PT';
  if (language === 'en') return region === 'gb' || region === 'uk' || region === 'ie' ? 'EN-GB' : 'EN-US';
  if (language === 'de' && region === 'ch') return 'DE-CH';
  if (language === 'fr' && region === 'ca') return 'FR-CA';
  if (language === 'es' && region === '419') return 'ES-419';
  return BASE_LANGUAGES[language] ?? null;
}

/**
 * The DeepL `source_lang` of a HeoPress locale, or null when the language is not one DeepL reads (the request then omits
 * `source_lang` and DeepL detects the language itself). DeepL reads base languages, so `en-GB` and `pt-BR` become `EN`/`PT`.
 */
export function mapSourceRoot(locale: string): string | null {
  const language = locale.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  return language && language in BASE_LANGUAGES ? language.toUpperCase() : null;
}

/** The base (root) language used for a DeepL glossary dictionary, e.g. `EN-US` → `en`, `ZH-HANS` → `zh`. */
export function glossaryRootLang(code: string): string {
  return code.toLowerCase().split('-')[0] ?? code.toLowerCase();
}

/** The UTF-8 byte length of a string (DeepL's limits are byte limits). */
export function utf8Bytes(text: string): number {
  return textEncoder.encode(text).length;
}

/**
 * Split the segments into DeepL-sized batches: at most 50 texts and at most 120 KiB of JSON body each, including a
 * placeholder glossary id and the language fields. A single segment too large for one request is a typed failure rather
 * than a silent truncation.
 */
export function batchSegments(
  segments: readonly TranslationSegment[],
  targetLang: string,
  sourceLang: string | null,
): TranslationSegment[][] {
  const batches: TranslationSegment[][] = [];
  let current: TranslationSegment[] = [];
  for (const segment of segments) {
    if (requestBytes([segment], targetLang, sourceLang) > MAX_REQUEST_BYTES) {
      throw new DeepLError('DEEPL_REQUEST_TOO_LARGE', `segment "${segment.id}" does not fit in one DeepL request`);
    }
    const full = current.length >= MAX_TEXTS_PER_REQUEST;
    const tooLarge = requestBytes([...current, segment], targetLang, sourceLang) > MAX_REQUEST_BYTES;
    if (current.length > 0 && (full || tooLarge)) {
      batches.push(current);
      current = [segment];
    } else {
      current.push(segment);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The JSON body size of one batch (the placeholder keeps room for the glossary id chosen later). */
function requestBytes(segments: readonly TranslationSegment[], targetLang: string, sourceLang: string | null): number {
  const body = {
    text: segments.map((segment) => segment.text),
    target_lang: targetLang,
    ...(sourceLang ? { source_lang: sourceLang } : {}),
    glossary_id: 'g'.repeat(GLOSSARY_ID_ALLOWANCE),
  };
  return utf8Bytes(JSON.stringify(body));
}

/** One glossary term the request asked to apply. */
export interface GlossaryTerm {
  source: string;
  target: string;
}

/** A cached DeepL glossary: its provider id and the content hash it was written for. */
export interface GlossaryCacheEntry {
  id: string;
  hash: string;
}

/**
 * The terms that can be mirrored into a DeepL glossary, deterministically: trimmed, without empty entries or entries
 * carrying control characters, without phrases longer than DeepL's 1024-byte limit, one per source phrase (the first
 * wins), sorted by source phrase. The same set of terms always yields the same entries, TSV and hash.
 */
export function canonicalGlossary(terms: readonly GlossaryTerm[]): GlossaryTerm[] {
  const seen = new Set<string>();
  const entries: GlossaryTerm[] = [];
  for (const term of terms) {
    const source = String(term.source ?? '').trim();
    const target = String(term.target ?? '').trim();
    if (source === '' || target === '') continue;
    if (CONTROL_CHARACTERS.test(source) || CONTROL_CHARACTERS.test(target)) continue;
    if (utf8Bytes(source) > MAX_GLOSSARY_PHRASE_BYTES || utf8Bytes(target) > MAX_GLOSSARY_PHRASE_BYTES) continue;
    if (seen.has(source)) continue;
    seen.add(source);
    entries.push({ source, target });
  }
  return entries.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/** The TSV DeepL expects for glossary entries, one `source\ttarget` line per term. */
export function glossaryTsv(entries: readonly GlossaryTerm[]): string {
  return entries.map((entry) => `${entry.source}\t${entry.target}`).join('\n');
}

/**
 * FNV-1a (64-bit) as 16 hexadecimal characters. This is a change detector for the glossary's content, not a security
 * primitive: 64 bits are enough to tell whether a site's term list changed, and keeping it dependency-free keeps the
 * bundle import-free.
 */
export function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of textEncoder.encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** A short, stable token for a site: the raw site id is not written into a third-party system. */
export function siteToken(siteId: string): string {
  return fnv1a64(siteId).slice(0, 8);
}

/** The DeepL glossary name of one site and language pair: stable, so terms change the dictionary, not the glossary. */
export function glossaryName(siteId: string, sourceRoot: string, targetRoot: string): string {
  return `heopress-${siteToken(siteId)}-${sourceRoot.toLowerCase()}-${targetRoot.toLowerCase()}`;
}

/** The KV key the glossary id of a site and language pair is cached under. */
export function glossaryCacheKey(siteId: string, sourceRoot: string, targetRoot: string): string {
  return `${GLOSSARY_CACHE_PREFIX}${siteToken(siteId)}:${sourceRoot.toLowerCase()}:${targetRoot.toLowerCase()}`;
}

/** Whether an error is the call being stopped (a deadline or the plugin being disabled): never a glossary fallback. */
function isAborted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

/** The DeepL refusal code of an HTTP status. */
function errorCodeFor(status: number): DeepLErrorCode {
  if (status === 401) return 'DEEPL_UNAUTHORIZED';
  if (status === 403) return 'DEEPL_AUTH_FAILED';
  if (status === 400 || status === 413 || status === 415) return 'DEEPL_BAD_REQUEST';
  if (status === 456) return 'DEEPL_QUOTA_EXCEEDED';
  if (status === 429) return 'DEEPL_RATE_LIMITED';
  if (status >= 500) return 'DEEPL_UNAVAILABLE';
  return 'DEEPL_REQUEST_FAILED';
}

/** DeepL's human-readable message from an error body, bounded; never the request body or a segment. */
function errorMessageOf(raw: string): string {
  try {
    const body = JSON.parse(raw) as { message?: unknown; detail?: unknown; error?: { message?: unknown } };
    const parts = [body.message, body.detail, body.error?.message].filter(
      (part): part is string => typeof part === 'string' && part.trim() !== '',
    );
    if (parts.length > 0) return parts.join(': ').replace(/\s+/g, ' ').slice(0, 200);
  } catch {
    /* not JSON: fall through to a fixed message */
  }
  return 'DeepL refused the request';
}

/** The key, or a typed failure before any request is made. A resolver that throws means the same: no key available. */
async function readApiKey(ctx: PluginContext): Promise<string> {
  let key: string | null = null;
  try {
    key = await ctx.secrets.get(SECRET_NAME);
  } catch {
    key = null;
  }
  if (key === null || key.trim() === '') {
    throw new DeepLError('DEEPL_NO_API_KEY', `the host did not provide the "${SECRET_NAME}" secret for this plugin`);
  }
  return key.trim();
}

/** One DeepL request; returns the parsed answer or throws a `DeepLError` (or the abort reason). */
async function request(ctx: PluginContext, key: string, method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await ctx.fetch(`${deepLBaseUrl(key)}${path}`, {
      method,
      headers: {
        authorization: `DeepL-Auth-Key ${key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  } catch (error) {
    if (isAborted(error, signal)) throw error;
    throw new DeepLError('DEEPL_REQUEST_FAILED', 'the request to DeepL failed before an answer arrived');
  }
  const traceId = response.headers.get('x-trace-id');
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    if (isAborted(error, signal)) throw error;
    throw new DeepLError('DEEPL_REQUEST_FAILED', 'the answer from DeepL could not be read', { status: response.status, traceId });
  }
  if (!response.ok) {
    throw new DeepLError(errorCodeFor(response.status), errorMessageOf(raw), { status: response.status, traceId });
  }
  try {
    return raw === '' ? null : JSON.parse(raw);
  } catch {
    throw new DeepLError('DEEPL_BAD_RESPONSE', 'DeepL answered with something that is not JSON', {
      status: response.status,
      traceId,
    });
  }
}

/** The translations of one batch, in the order DeepL returned them; a count or type mismatch is a whole-answer failure. */
function translationTexts(payload: unknown, expected: number): string[] {
  const translations = (payload as { translations?: unknown } | null)?.translations;
  if (!Array.isArray(translations) || translations.length !== expected) {
    throw new DeepLError(
      'DEEPL_BAD_RESPONSE',
      `DeepL answered ${Array.isArray(translations) ? translations.length : 'no'} segments for ${expected}`,
    );
  }
  const texts: string[] = [];
  for (const translation of translations) {
    const text = (translation as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') throw new DeepLError('DEEPL_BAD_RESPONSE', 'DeepL answered a segment without text');
    texts.push(text);
  }
  return texts;
}

/** The cached glossary id of a key, or null (an unreadable or malformed entry is a cache miss, never a failure). */
async function readGlossaryCache(ctx: PluginContext, cacheKey: string): Promise<GlossaryCacheEntry | null> {
  try {
    const raw = await ctx.kv.get(cacheKey);
    if (!raw) return null;
    const body = JSON.parse(raw) as { id?: unknown; hash?: unknown };
    return typeof body.id === 'string' && body.id !== '' && typeof body.hash === 'string' ? { id: body.id, hash: body.hash } : null;
  } catch {
    return null;
  }
}

/** Cache the glossary id for a hash; the host may not bind KV, in which case the write is simply dropped. */
async function writeGlossaryCache(ctx: PluginContext, cacheKey: string, id: string, hash: string): Promise<void> {
  try {
    await ctx.kv.put(cacheKey, JSON.stringify({ id, hash }));
  } catch {
    /* the name-based lookup is the durable path */
  }
}

/** Record why the glossary was skipped, for an operator with a KV viewer; never a term or a key. */
async function noteGlossaryFailure(ctx: PluginContext, error: unknown): Promise<void> {
  const record =
    error instanceof DeepLError
      ? { code: error.code, status: error.status, traceId: error.traceId }
      : { code: 'DEEPL_REQUEST_FAILED', status: null, traceId: null };
  try {
    await ctx.kv.put(GLOSSARY_ERROR_KEY, JSON.stringify(record));
  } catch {
    /* best effort */
  }
}

/** The id of an existing glossary with exactly this name, or null. */
async function findGlossary(ctx: PluginContext, key: string, name: string, signal: AbortSignal): Promise<string | null> {
  const payload = await request(ctx, key, 'GET', '/v3/glossaries', undefined, signal);
  const glossaries = (payload as { glossaries?: unknown } | null)?.glossaries;
  if (!Array.isArray(glossaries)) throw new DeepLError('DEEPL_BAD_RESPONSE', 'DeepL did not list glossaries');
  for (const glossary of glossaries) {
    const entry = glossary as { glossary_id?: unknown; name?: unknown } | null;
    if (entry?.name === name && typeof entry.glossary_id === 'string' && entry.glossary_id !== '') return entry.glossary_id;
  }
  return null;
}

/** Replace (or create) one language pair's dictionary in a glossary; v3's replace semantics, unlike immutable v2. */
async function replaceDictionary(
  ctx: PluginContext,
  key: string,
  glossaryId: string,
  sourceRoot: string,
  targetRoot: string,
  tsv: string,
  signal: AbortSignal,
): Promise<void> {
  await request(ctx, key, 'PUT', `/v3/glossaries/${encodeURIComponent(glossaryId)}/dictionaries`, {
    source_lang: sourceRoot.toLowerCase(),
    target_lang: targetRoot.toLowerCase(),
    entries: tsv,
    entries_format: 'tsv',
  }, signal);
}

/** Create a glossary with one dictionary and return its id. */
async function createGlossary(
  ctx: PluginContext,
  key: string,
  name: string,
  sourceRoot: string,
  targetRoot: string,
  tsv: string,
  signal: AbortSignal,
): Promise<string> {
  const payload = await request(ctx, key, 'POST', '/v3/glossaries', {
    name,
    dictionaries: [
      {
        source_lang: sourceRoot.toLowerCase(),
        target_lang: targetRoot.toLowerCase(),
        entries: tsv,
        entries_format: 'tsv',
      },
    ],
  }, signal);
  const id = (payload as { glossary_id?: unknown } | null)?.glossary_id;
  if (typeof id !== 'string' || id === '') throw new DeepLError('DEEPL_BAD_RESPONSE', 'DeepL did not return a glossary id');
  return id;
}

/**
 * Mirror the request's terms into a DeepL glossary and return the id to apply, or null when there is nothing to apply.
 *
 * The cache (KV) is the fast path: a hash match needs no glossary request at all, a hash change replaces the dictionary.
 * Without a cache the glossary is found by its deterministic name and updated before use. Any failure of the glossary
 * endpoints is a documented degradation: the translation still runs, without `glossary_id`. A stopped call is different:
 * the abort is rethrown so the host records a timeout instead of a glossary-less translation.
 */
async function syncGlossary(
  ctx: PluginContext,
  key: string,
  siteId: string,
  sourceRoot: string,
  targetRoot: string,
  terms: readonly GlossaryTerm[],
  signal: AbortSignal,
): Promise<string | null> {
  const entries = canonicalGlossary(terms);
  if (entries.length === 0) return null;
  const tsv = glossaryTsv(entries);
  const hash = fnv1a64(tsv);
  const name = glossaryName(siteId, sourceRoot, targetRoot);
  const cacheKey = glossaryCacheKey(siteId, sourceRoot, targetRoot);
  try {
    const cached = await readGlossaryCache(ctx, cacheKey);
    if (cached) {
      if (cached.hash === hash) return cached.id;
      try {
        await replaceDictionary(ctx, key, cached.id, sourceRoot, targetRoot, tsv, signal);
        await writeGlossaryCache(ctx, cacheKey, cached.id, hash);
        return cached.id;
      } catch (error) {
        if (isAborted(error, signal)) throw error;
        // The glossary was deleted upstream: forget the stale id and fall through to the name-based lookup.
        if (!(error instanceof DeepLError) || error.status !== 404) throw error;
      }
    }
    const existing = await findGlossary(ctx, key, name, signal);
    if (existing !== null) {
      await replaceDictionary(ctx, key, existing, sourceRoot, targetRoot, tsv, signal);
      await writeGlossaryCache(ctx, cacheKey, existing, hash);
      return existing;
    }
    const created = await createGlossary(ctx, key, name, sourceRoot, targetRoot, tsv, signal);
    await writeGlossaryCache(ctx, cacheKey, created, hash);
    return created;
  } catch (error) {
    if (isAborted(error, signal)) throw error;
    await noteGlossaryFailure(ctx, error);
    return null;
  }
}

/**
 * Translate one request with DeepL: read the key, map the locales, batch the segments, apply the glossary when there is
 * one, and return the requested ids in the requested order.
 */
export async function translateWithDeepL(ctx: PluginContext, request_: TranslationServiceContext): Promise<TranslationAnswer> {
  const key = await readApiKey(ctx);
  const targetLang = mapTargetLang(request_.targetLocale);
  if (targetLang === null) {
    throw new DeepLError('DEEPL_UNSUPPORTED_LOCALE', `DeepL does not translate into "${request_.targetLocale}"`);
  }
  const sourceLang = mapSourceRoot(request_.sourceLocale);
  const batches = batchSegments(request_.segments, targetLang, sourceLang);
  if (batches.length > MAX_TRANSLATE_REQUESTS) {
    throw new DeepLError(
      'DEEPL_TOO_MANY_SEGMENTS',
      `${request_.segments.length} segments need ${batches.length} DeepL requests; one call allows ${MAX_TRANSLATE_REQUESTS}`,
    );
  }
  const sourceRoot = sourceLang === null ? null : glossaryRootLang(sourceLang);
  const targetRoot = glossaryRootLang(targetLang);
  const glossaryId =
    sourceRoot !== null && request_.glossary.length > 0
      ? await syncGlossary(ctx, key, request_.siteId, sourceRoot, targetRoot, request_.glossary, request_.signal)
      : null;
  const segments: Array<{ id: string; text: string }> = [];
  for (const batch of batches) {
    const body: Record<string, unknown> = { text: batch.map((segment) => segment.text), target_lang: targetLang };
    if (sourceLang !== null) body.source_lang = sourceLang;
    if (glossaryId !== null) body.glossary_id = glossaryId;
    const payload = await request(ctx, key, 'POST', '/v2/translate', body, request_.signal);
    const texts = translationTexts(payload, batch.length);
    for (let i = 0; i < batch.length; i += 1) {
      segments.push({ id: batch[i]!.id, text: texts[i]! });
    }
  }
  return { segments };
}

/** The service this plugin registers: the `deepl` id, a 30 s deadline, 40 requests and the translate above. */
export function createDeepLService(ctx: PluginContext): TranslationServiceDefinition {
  return {
    id: SERVICE_ID,
    maxDurationMs: MAX_DURATION_MS,
    maxRequests: MAX_REQUESTS,
    translate: (request_) => translateWithDeepL(ctx, request_),
  };
}

/** The plugin: register the `deepl` service and return no other export. */
export default (ctx: PluginContext) => {
  ctx.extensionPoints.register('translation-services', createDeepLService(ctx));
  return {};
};
