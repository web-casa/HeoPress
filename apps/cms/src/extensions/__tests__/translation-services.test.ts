/**
 * Plugin translation services (HeoPress v1.2, spec extensions/translation-services): the eleventh extension point, the
 * manifest declaration (id, engine, price) and its capability, the selection format, and the answer contract the host
 * enforces. Loading, selection, billing and the sandbox are exercised against a real database and a real sandbox in
 * `apps/cms/src/__tests__/translation-services.db.integration.test.ts` and
 * `apps/cms/src/extensions/__tests__/translation-services-sandbox.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_POINTS,
  EXTENSION_POINT_VERSIONS,
  TRANSLATION_LIMITS,
  extensionPointRangesOf,
  parseCapability,
  parseTranslationServiceRef,
  translationAnswerSegments,
  translationDeclarationIssues,
  translationServiceRef,
  translationServicesOf,
  validateCapabilities,
} from '@heopress/contracts/extensions';
import { ExtensionManifestSchema } from '@heopress/contracts/schemas';

const base = {
  name: 'heopress-deepl',
  version: '1.0.0',
  type: 'module',
  entry: './dist/index.js',
  heopress: '^1.0.0-0',
  security: { contact: 'security@example.com' },
};

/** A manifest offering one service, with the capability and the ranges it needs. */
const manifest = (over: Record<string, unknown> = {}) => ({
  ...base,
  capabilities: ['ext:translation-services', 'http:fetch:api.deepl.example', 'secrets:deepl-key'],
  extensionPoints: { 'translation-services': '^1.0.0', context: '^1.0.0' },
  translationServices: [{ id: 'deepl', displayName: 'DeepL', engine: 'deepl', pricePerMillionChars: 20 }],
  ...over,
});

describe('translation services: the contribution contract', () => {
  it('is an extension point of its own, with a contract version', () => {
    expect(EXTENSION_POINTS).toContain('translation-services');
    expect(EXTENSION_POINT_VERSIONS['translation-services']).toBe('1.0.0');
    expect(parseCapability('ext:translation-services')).toMatchObject({ category: 'extension-point', target: 'translation-services' });
    expect(validateCapabilities(['ext:translation-services']).errors).toEqual([]);
    // Every point, this one included, is in the version table: a point without a version could not be declared.
    expect(Object.keys(EXTENSION_POINT_VERSIONS).filter((k) => k !== 'context').sort()).toEqual([...EXTENSION_POINTS].sort());
  });

  it('a manifest that declares a service and holds the capability is valid', () => {
    const parsed = ExtensionManifestSchema.parse(manifest());
    expect(parsed.translationServices).toEqual([{ id: 'deepl', displayName: 'DeepL', engine: 'deepl', pricePerMillionChars: 20 }]);
    expect(translationServicesOf(parsed)).toEqual(parsed.translationServices);
    expect(extensionPointRangesOf(parsed)).toEqual({ 'translation-services': '^1.0.0', context: '^1.0.0' });
  });

  it('a declared service without ext:translation-services is refused', () => {
    const parsed = ExtensionManifestSchema.safeParse(manifest({ capabilities: ['secrets:deepl-key'], extensionPoints: { context: '^1.0.0' } }));
    expect(parsed.success).toBe(false);
    expect(
      parsed.error!.issues.some(
        (i) => i.path.join('.') === 'translationServices' && /ext:translation-services/.test(i.message),
      ),
    ).toBe(true);
    expect(
      translationDeclarationIssues({ translationServices: [{ id: 'deepl', displayName: 'DeepL', engine: 'deepl' }] }, ['secrets:deepl-key']),
    ).toEqual([{ path: 'translationServices', message: 'translation services need the ext:translation-services capability' }]);
  });

  it('refuses a repeated id, a malformed id or engine, a negative price and more services than the limit', () => {
    const invalid = [
      {
        translationServices: [
          { id: 'deepl', displayName: 'A', engine: 'deepl' },
          { id: 'deepl', displayName: 'B', engine: 'deepl' },
        ],
      },
      { translationServices: [{ id: 'DeepL', displayName: 'DeepL', engine: 'deepl' }] },
      { translationServices: [{ id: 'deepl', displayName: 'DeepL', engine: 'Deep L' }] },
      { translationServices: [{ id: 'deepl', displayName: 'DeepL', engine: 'deepl', pricePerMillionChars: -1 }] },
      {
        translationServices: Array.from({ length: TRANSLATION_LIMITS.services.max + 1 }, (_, i) => ({
          id: `service-${i}`,
          displayName: 'Service',
          engine: 'engine',
        })),
      },
    ];
    for (const over of invalid) {
      const parsed = ExtensionManifestSchema.safeParse(manifest(over));
      expect(parsed.success, JSON.stringify(over).slice(0, 90)).toBe(false);
    }
    expect(
      translationDeclarationIssues(
        {
          translationServices: [
            { id: 'deepl', displayName: 'A', engine: 'deepl' },
            { id: 'deepl', displayName: 'B', engine: 'deepl' },
          ],
        },
        ['ext:translation-services'],
      ),
    ).toEqual([{ path: 'translationServices', message: 'translation service ids repeat' }]);
  });

  it('an omitted price is allowed and means zero', () => {
    const parsed = ExtensionManifestSchema.parse(
      manifest({ translationServices: [{ id: 'deepl', displayName: 'DeepL', engine: 'deepl' }] }),
    );
    expect(translationServicesOf(parsed)).toEqual([{ id: 'deepl', displayName: 'DeepL', engine: 'deepl' }]);
  });

  it('a malformed stored declaration declares nothing', () => {
    expect(translationServicesOf({ translationServices: [{ id: 'Bad Id' }] })).toEqual([]);
    expect(translationServicesOf({ translationServices: 'deepl' })).toEqual([]);
    expect(translationServicesOf({})).toEqual([]);
  });
});

describe('translation services: the site selection', () => {
  it('parses "<plugin name>:<service id>", slash-form plugin names included', () => {
    expect(parseTranslationServiceRef('heopress-deepl:deepl')).toEqual({ plugin: 'heopress-deepl', service: 'deepl' });
    expect(parseTranslationServiceRef('heopress/translation:deepl-v2')).toEqual({ plugin: 'heopress/translation', service: 'deepl-v2' });
    expect(translationServiceRef('heopress-deepl', 'deepl')).toBe('heopress-deepl:deepl');
  });

  it('refuses a selection that is not plugin:service', () => {
    for (const ref of ['', 'deepl', ':deepl', 'plugin:', 'Plugin:deepl', 'plugin:DeepL', 'plugin:deepl:x']) {
      expect(parseTranslationServiceRef(ref), ref).toBeNull();
    }
  });
});

describe('translation services: the answer contract', () => {
  const wanted = [
    { id: 's1', text: 'Hello' },
    { id: 's2', text: 'World' },
  ];

  it('accepts exactly the requested ids, in the requested order', () => {
    expect(
      translationAnswerSegments({ segments: [{ id: 's2', text: '世界' }, { id: 's1', text: '你好' }] }, wanted),
    ).toEqual([
      { id: 's1', text: '你好' },
      { id: 's2', text: '世界' },
    ]);
  });

  it('refuses a missing, extra or repeated id, and a non-string text', () => {
    for (const answer of [
      { segments: [{ id: 's1', text: '你好' }] },
      { segments: [{ id: 's1', text: '你好' }, { id: 's2', text: '世界' }, { id: 's3', text: 'extra' }] },
      { segments: [{ id: 's1', text: '你好' }, { id: 's1', text: '世界' }] },
      { segments: [{ id: 's1', text: 1 }, { id: 's2', text: '世界' }] },
      { segments: [] },
      { segments: 'nope' },
      null,
    ]) {
      expect(translationAnswerSegments(answer, wanted), JSON.stringify(answer)).toBeNull();
    }
  });

  it('bounds the segments and their text', () => {
    expect(TRANSLATION_LIMITS.segments.max).toBeGreaterThan(0);
    expect(TRANSLATION_LIMITS.durationMs.default).toBeLessThanOrEqual(TRANSLATION_LIMITS.durationMs.max);
    expect(TRANSLATION_LIMITS.requests.default).toBeLessThanOrEqual(TRANSLATION_LIMITS.requests.max);
  });
});
