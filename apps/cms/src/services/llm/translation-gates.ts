/**
 * Mechanical gates of the built-in two-model translation service (HeoPress v1.4, spec
 * ai/dual-model-translation "机械门禁").
 *
 * These are deterministic, cheap checks that run before any human-visible acceptance of a draft or a revision. They are
 * deliberately heuristics, not a language detector: no dependency, no network, no randomness, and the same input always
 * produces the same findings. A failing segment is a **defect of the draft**, not of the reviewer; its codes travel to
 * the reviewer and decide whether a revision may be accepted.
 *
 * Limits, documented in the spec and `design.md`:
 *   - numbers are compared as digit sequences, ignoring thousands/decimal separators (`1,000` = `1.000`, `3.5` = `35`);
 *   - "untranslated" only catches wholly untranslated output (normalized identity, or no target-script character at all
 *     for a cross-script pair); brand names inside a translated sentence are not flagged;
 *   - short segments (fewer than two words and fewer than twelve letters, e.g. a lone brand name, URL or `⟦P0⟧`) are
 *     exempt from the identity/untranslated checks; the other gates still run.
 */
import type { TranslationSegment } from './translation-service';

const GATE_CODES = [
  'empty',
  'same_locale',
  'identical',
  'untranslated',
  'placeholder_missing',
  'placeholder_added',
  'html_missing',
  'html_added',
  'url_missing',
  'url_added',
  'number_missing',
  'glossary_missing',
] as const;
type GateCode = (typeof GATE_CODES)[number];

export interface GateFinding {
  code: GateCode;
  /** A short, safe excerpt (never the whole text) for the reviewer and the operator. */
  detail?: string;
}

export interface GateContext {
  sourceLocale: string;
  targetLocale: string;
  /** Terms that must be rendered this way. */
  glossary?: ReadonlyArray<{ source: string; target: string }>;
}

const PLACEHOLDER = /⟦[^⟦⟧\s]+⟧/g;
const HTML_TAG = /<\/?[A-Za-z][^<>]*>/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>()\]]+/gi;
const NUMBER = /\d+(?:[.,]\d+)*/g;

/** `zh-CN` / `zh_CN` → `zh-cn`: two locale tags are the same when they normalize to the same string. */
function localeKey(locale: string): string {
  return locale.trim().toLowerCase().replace(/_/g, '-');
}

/** Whether two locale tags name the same language pair side (a same-locale translation has nothing to verify). */
export function sameLocale(a: string, b: string): boolean {
  return localeKey(a) === localeKey(b);
}

type Script = 'latin' | 'han' | 'japanese' | 'hangul' | 'cyrillic' | 'arabic' | 'hebrew' | 'devanagari' | 'thai' | 'greek';

const SCRIPT_BY_LANGUAGE: Record<string, Script> = {
  zh: 'han',
  ja: 'japanese',
  ko: 'hangul',
  ru: 'cyrillic',
  uk: 'cyrillic',
  bg: 'cyrillic',
  sr: 'cyrillic',
  mk: 'cyrillic',
  be: 'cyrillic',
  ar: 'arabic',
  fa: 'arabic',
  ur: 'arabic',
  he: 'hebrew',
  hi: 'devanagari',
  mr: 'devanagari',
  ne: 'devanagari',
  sa: 'devanagari',
  th: 'thai',
  el: 'greek',
};

const SCRIPT_TEST: Record<Script, RegExp> = {
  latin: /[A-Za-z\u00c0-\u024f]/,
  han: /[\u3400-\u9fff\uf900-\ufaff]/,
  japanese: /[\u3040-\u30ff\u3400-\u9fff]/,
  hangul: /[\u1100-\u11ff\uac00-\ud7af]/,
  cyrillic: /[\u0400-\u04ff]/,
  arabic: /[\u0600-\u06ff]/,
  hebrew: /[\u0590-\u05ff]/,
  devanagari: /[\u0900-\u097f]/,
  thai: /[\u0e00-\u0e7f]/,
  greek: /[\u0370-\u03ff]/,
};

/** The writing system a locale normally uses; unknown languages default to Latin. */
export function scriptOf(locale: string): Script {
  const language = locale.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return SCRIPT_BY_LANGUAGE[language] ?? 'latin';
}

/** The text with protected tokens removed: what is left is what could be translated. */
function contentText(text: string): string {
  return text.replace(PLACEHOLDER, ' ').replace(HTML_TAG, ' ').replace(URL_PATTERN, ' ');
}

/** Whether there is enough text for the identity/untranslated heuristics to be meaningful. */
function substantial(text: string): boolean {
  const plain = contentText(text).trim();
  const letters = (plain.match(/\p{L}/gu) ?? []).length;
  const words = plain.split(/\s+/).filter(Boolean).length;
  return words >= 2 || letters >= 12;
}

function normalizeWords(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokensOf(text: string, pattern: RegExp, normalize: (value: string) => string = (v) => v): string[] {
  return (text.match(pattern) ?? []).map(normalize);
}

/** Which source tokens are missing from the target and which target tokens were not in the source (multisets). */
function multisetDiff(source: string[], target: string[]): { missing: string[]; added: string[] } {
  const remaining = new Map<string, number>();
  for (const token of target) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const token of source) {
    const left = remaining.get(token) ?? 0;
    if (left > 0) remaining.set(token, left - 1);
    else if (!seen.has(token)) {
      missing.push(token);
      seen.add(token);
    }
  }
  const added = [...remaining].filter(([, left]) => left > 0).map(([token]) => token);
  return { missing, added };
}

function excerpt(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** `href` values and bare URLs; trailing sentence punctuation is not part of the URL. */
function urlTokens(text: string): string[] {
  return tokensOf(text, URL_PATTERN, (value) => value.replace(/[.,;:!?]+$/, ''));
}

/** Digit sequences, with separators removed (`1,000` and `1.000` are the same number; `3.5` and `35` too). */
function numberTokens(text: string): string[] {
  return tokensOf(contentText(text), NUMBER, (value) => value.replace(/\D/g, '')).filter(Boolean);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `needle` occurs in `haystack`; Latin terms match whole words, case-insensitively. */
function containsTerm(haystack: string, needle: string): boolean {
  const escaped = escapeRe(needle);
  const wordy = /^[A-Za-z0-9]/.test(needle) && /[A-Za-z0-9]$/.test(needle);
  return new RegExp(wordy ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])` : escaped, 'iu').test(haystack);
}

/** The gate findings of one source segment against its (draft or revised) target text, in a fixed order. */
export function gateFindings(source: string, target: string, ctx: GateContext): GateFinding[] {
  const findings: GateFinding[] = [];
  const targetText = target ?? '';
  if (!targetText.trim()) return [{ code: 'empty' }];

  if (localeKey(ctx.sourceLocale) === localeKey(ctx.targetLocale)) findings.push({ code: 'same_locale' });

  if (contentText(source).trim() && substantial(source)) {
    if (normalizeWords(source) === normalizeWords(targetText)) findings.push({ code: 'identical' });
    const sourceScript = scriptOf(ctx.sourceLocale);
    const targetScript = scriptOf(ctx.targetLocale);
    if (sourceScript !== targetScript && !SCRIPT_TEST[targetScript].test(contentText(targetText))) findings.push({ code: 'untranslated' });
  }

  const placeholders = multisetDiff(tokensOf(source, PLACEHOLDER), tokensOf(targetText, PLACEHOLDER));
  for (const token of placeholders.missing.slice(0, 5)) findings.push({ code: 'placeholder_missing', detail: excerpt(token) });
  for (const token of placeholders.added.slice(0, 5)) findings.push({ code: 'placeholder_added', detail: excerpt(token) });

  const html = multisetDiff(tokensOf(source, HTML_TAG), tokensOf(targetText, HTML_TAG));
  for (const token of html.missing.slice(0, 5)) findings.push({ code: 'html_missing', detail: excerpt(token) });
  for (const token of html.added.slice(0, 5)) findings.push({ code: 'html_added', detail: excerpt(token) });

  const urls = multisetDiff(urlTokens(source), urlTokens(targetText));
  for (const token of urls.missing.slice(0, 5)) findings.push({ code: 'url_missing', detail: excerpt(token) });
  for (const token of urls.added.slice(0, 5)) findings.push({ code: 'url_added', detail: excerpt(token) });

  const numbers = multisetDiff(numberTokens(source), numberTokens(targetText));
  for (const token of numbers.missing.slice(0, 5)) findings.push({ code: 'number_missing', detail: excerpt(token) });

  for (const term of ctx.glossary ?? []) {
    const from = term.source?.trim();
    const to = term.target?.trim();
    if (!from || !to || !containsTerm(source, from)) continue;
    if (!containsTerm(targetText, to)) findings.push({ code: 'glossary_missing', detail: excerpt(from) });
  }

  return findings;
}

/** The findings of every requested segment, keyed by id, in the request order. */
export function gateFindingsForSegments(
  segments: readonly TranslationSegment[],
  texts: ReadonlyMap<string, string>,
  ctx: GateContext,
): Map<string, GateFinding[]> {
  const out = new Map<string, GateFinding[]>();
  for (const segment of segments) out.set(segment.id, gateFindings(segment.text, texts.get(segment.id) ?? '', ctx));
  return out;
}
