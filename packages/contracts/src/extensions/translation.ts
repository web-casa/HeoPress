/**
 * Plugin-provided translation services (HeoPress v1.2 P12, spec extensions/translation-services).
 *
 * A plugin declares each service by id in its manifest, with the engine it stands for and the price the site pays for it:
 *
 * ```json
 * {
 *   "capabilities": ["ext:translation-services", "http:fetch:api.deepl.example", "secrets:deepl-key"],
 *   "translationServices": [
 *     { "id": "deepl", "displayName": "DeepL", "engine": "deepl", "pricePerMillionChars": 20 }
 *   ]
 * }
 * ```
 *
 * The bundle registers each service under the same id (`defineTranslationService({ id, translate })`); one registered under
 * an id the manifest does not declare is refused and recorded. The host owns what a call may return
 * (`PluginTranslationAnswerSchema`: the requested segment ids, each once, translated) and how long it may take
 * (`TRANSLATION_LIMITS`), fills in what a plugin cannot know (`engine`, `provider`, `model`, `callId`) and records the call
 * priced by characters, not tokens.
 *
 * `engine`, `displayName` and `pricePerMillionChars` come from the manifest — the declaration the admin approved — so a
 * bundle cannot change the price it is billed at.
 *
 * Pure functions and Zod schemas: shared by the CMS (install, load, routing, billing), the SDK and the documentation.
 */
import { z } from 'zod';
import { declaresExtensionPoint } from './capabilities';
import { RUNTIME_NAME, TRANSLATION_LIMITS } from './runtime';

/** A service's upstream engine name: a short slug that ends up in the ledger as the call's model. */
export const TRANSLATION_ENGINE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** One service a manifest declares: its id, the engine it stands for, the label shown to operators and its price. */
export const ExtensionTranslationServiceSchema = z.object({
  /** The id the bundle registers the service under (`defineTranslationService({ id })`). */
  id: z.string().regex(RUNTIME_NAME),
  displayName: z.string().min(1).max(TRANSLATION_LIMITS.displayNameChars),
  /** The upstream engine (`deepl`, `google`, `azure`, …); it becomes the call's model in the ledger. */
  engine: z.string().regex(TRANSLATION_ENGINE, 'engine must be a lowercase slug (e.g. "deepl")'),
  /**
   * Decimal currency units per million characters, in the site's currency; omitted → 0. The price is part of the approved
   * declaration, never of the registration.
   */
  pricePerMillionChars: z.number().min(0).max(TRANSLATION_LIMITS.maxPricePerMillionChars).optional(),
});

/** The translation-service declarations of a manifest (optional). */
export const TranslationDeclarationsSchema = z.object({
  translationServices: z.array(ExtensionTranslationServiceSchema).max(TRANSLATION_LIMITS.services.max).optional(),
});

export type ExtensionTranslationService = z.infer<typeof ExtensionTranslationServiceSchema>;
export type TranslationDeclarations = z.infer<typeof TranslationDeclarationsSchema>;

export interface TranslationDeclarationIssue {
  path: string;
  message: string;
}

/** Check the declarations against themselves and the capabilities (requested or granted). */
export function translationDeclarationIssues(
  decl: TranslationDeclarations,
  capabilities: readonly string[],
): TranslationDeclarationIssue[] {
  const services = decl.translationServices ?? [];
  if (services.length === 0) return [];
  const issues: TranslationDeclarationIssue[] = [];
  if (!declaresExtensionPoint(capabilities, 'translation-services')) {
    issues.push({ path: 'translationServices', message: 'translation services need the ext:translation-services capability' });
  }
  const ids = services.map((s) => s.id);
  if (new Set(ids).size !== ids.length) issues.push({ path: 'translationServices', message: 'translation service ids repeat' });
  return issues;
}

/** The services a stored manifest declares (anything malformed: none). */
export function translationServicesOf(manifest: unknown): ExtensionTranslationService[] {
  const declared = (manifest as { translationServices?: unknown } | null)?.translationServices;
  const parsed = z.array(ExtensionTranslationServiceSchema).max(TRANSLATION_LIMITS.services.max).safeParse(declared ?? []);
  return parsed.success ? parsed.data : [];
}

/** A translated segment as a plugin returns it. */
export const PluginTranslationSegmentSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(TRANSLATION_LIMITS.segmentTextChars),
});

/**
 * What a service's `translate` returns: the requested segment ids, each once, with their translations. Anything else — a
 * missing id, an id that was never requested, a repeated id — is refused as a whole.
 */
export const PluginTranslationAnswerSchema = z.object({
  segments: z.array(PluginTranslationSegmentSchema).max(TRANSLATION_LIMITS.segments.max),
});

export type PluginTranslationSegment = z.infer<typeof PluginTranslationSegmentSchema>;
export type PluginTranslationAnswer = z.infer<typeof PluginTranslationAnswerSchema>;

/** One segment of a plugin translation request. */
export interface PluginTranslationSegmentInput {
  id: string;
  text: string;
}

/** What a plugin service's `translate` receives. */
export interface PluginTranslationRequest {
  siteId: string;
  sourceLocale: string;
  targetLocale: string;
  segments: PluginTranslationSegmentInput[];
  /** Terms that must be rendered this way. */
  glossary: Array<{ source: string; target: string }>;
  /** Fuzzy translation-memory matches, as references only. */
  memory: Array<{ source: string; target: string }>;
  /** Aborted when the call runs out of time or the plugin is stopped. */
  signal?: AbortSignal;
}

/**
 * The answer's segments in the requested order, or `null` when it does not translate exactly the requested ids once each.
 * A plugin cannot answer a subset, reorder the result or smuggle extra segments into the translation.
 */
export function translationAnswerSegments(
  answer: unknown,
  wanted: readonly PluginTranslationSegmentInput[],
): PluginTranslationSegment[] | null {
  const parsed = PluginTranslationAnswerSchema.safeParse(answer);
  if (!parsed.success) return null;
  const byId = new Map<string, string>();
  for (const segment of parsed.data.segments) {
    if (byId.has(segment.id)) return null;
    byId.set(segment.id, segment.text);
  }
  if (byId.size !== wanted.length || wanted.some((w) => !byId.has(w.id))) return null;
  return wanted.map((w) => ({ id: w.id, text: byId.get(w.id)! }));
}

/** A declaration's decimal price per million characters as integer micro-units per million (0 when omitted). */
export function charsMicrosOf(pricePerMillionChars: number | undefined): number {
  return Math.round((pricePerMillionChars ?? 0) * 1_000_000);
}

/**
 * The built-in translation services the host ships. Their `heopress` namespace is reserved: a selection equal to one of
 * these ids is answered by the host implementation, never resolved as a plugin (HeoPress v1.4, spec
 * ai/dual-model-translation "内置服务与站点选择").
 */
export const BUILTIN_TRANSLATION_SERVICE_IDS = ['heopress:dual-model'] as const;
export type BuiltinTranslationServiceId = (typeof BUILTIN_TRANSLATION_SERVICE_IDS)[number];
/** The two-model translation service: one model drafts, a different one verifies and revises. */
export const DUAL_MODEL_TRANSLATION_SERVICE: BuiltinTranslationServiceId = 'heopress:dual-model';

/** Whether a selection names a built-in service (and must not be resolved as a plugin). */
export function isBuiltinTranslationService(ref: string): ref is BuiltinTranslationServiceId {
  return (BUILTIN_TRANSLATION_SERVICE_IDS as readonly string[]).includes(ref);
}

/** A site's selection: `"<plugin name>:<service id>"` (the plugin name may contain `/`, the service id may not contain `:`). */
export const TranslationServiceRefSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-_/]*:[a-z][a-z0-9-]{0,39}$/, 'use "<plugin name>:<service id>", e.g. "heopress-deepl:deepl"');

/** The parts of a selection, or null when it is not `"<plugin name>:<service id>"`. */
export function parseTranslationServiceRef(ref: string): { plugin: string; service: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) return null;
  const plugin = ref.slice(0, i);
  const service = ref.slice(i + 1);
  if (!/^[a-z0-9][a-z0-9-_/]*$/.test(plugin) || !RUNTIME_NAME.test(service)) return null;
  return { plugin, service };
}

/** The selection of `plugin`'s `service`. */
export function translationServiceRef(plugin: string, service: string): string {
  return `${plugin}:${service}`;
}
