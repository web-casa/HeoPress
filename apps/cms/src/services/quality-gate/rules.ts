import { parseHTML } from 'linkedom';
import { evaluateRuleEvaluator, type ConstitutionEvaluator, type RuleEvaluator } from '../constitution-service';
import { isModelInstruction, stripHiddenContent, stripInvisible } from '../ingest/hidden-content';
import { compareFragments, extractFragments, type FragmentDifference } from './protected-fragments';

/**
 * Quality gate rules (HeoPress P09 tasks 2.1, 2.4, 2.5, 2.7; spec ai/quality-gate "门禁检查项"): pure functions from
 * what the gate read to a verdict with a score, evidence and suggestions. The service (`quality-gate.ts`) reads the
 * inputs, applies the site's levels and stores the result.
 *
 * A verdict is `passed`, `blocked`, `needs_review` or `warning` (fact checking only: it never passes an article on its
 * own and never blocks).
 */

export const GATE_CHECKS = [
  'source_rights',
  'near_duplicate',
  'citations',
  'editorial_rules',
  'safety',
  'seo_completeness',
  'seo_lengths',
  'literal_integrity',
  'text_overlap',
  'hidden_content',
  'fact_check',
] as const;
export type GateCheck = (typeof GATE_CHECKS)[number];

/** Checks a site can neither turn off nor downgrade to a warning. */
export const MANDATORY_CHECKS: ReadonlySet<GateCheck> = new Set(['source_rights', 'safety', 'literal_integrity', 'text_overlap', 'hidden_content']);

export type GateLevel = 'block' | 'warn' | 'off';

/** Default levels: everything blocks, except the optional fact check (off; at most `warn`). */
export const DEFAULT_LEVELS: Record<GateCheck, GateLevel> = {
  source_rights: 'block',
  near_duplicate: 'block',
  citations: 'block',
  editorial_rules: 'block',
  safety: 'block',
  seo_completeness: 'block',
  seo_lengths: 'block',
  literal_integrity: 'block',
  text_overlap: 'block',
  hidden_content: 'block',
  fact_check: 'off',
};

export const DEFAULT_THRESHOLDS = {
  /** Jaccard similarity of word / character shingles at or above which two articles are near duplicates. */
  near_duplicate: 0.8,
  /** Share of a draft paragraph's shingles found in a facts-only source at or above which it is copied. */
  text_overlap: 0.6,
};
export type GateThresholds = typeof DEFAULT_THRESHOLDS;

export type Verdict = 'passed' | 'blocked' | 'needs_review' | 'warning';

export interface RuleOutcome {
  rule: GateCheck;
  verdict: Verdict;
  score: number;
  evidence: Record<string, unknown>;
  suggestions: string[];
}

const outcome = (rule: GateCheck, verdict: Verdict, evidence: Record<string, unknown> = {}, suggestions: string[] = [], score?: number): RuleOutcome => ({
  rule,
  verdict,
  score: score ?? (verdict === 'passed' ? 100 : verdict === 'warning' ? 70 : verdict === 'needs_review' ? 50 : 0),
  evidence,
  suggestions,
});

// ── text helpers ────────────────────────────────────────────────────

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
export const plainText = (html: string) => decode(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The paragraphs (block-level elements' text) of an HTML body. */
function paragraphs(html: string): string[] {
  const parts = String(html ?? '').split(/<\/?(?:p|h[1-6]|li|blockquote|pre|td|th|dd|dt|figcaption)\b[^>]*>/i);
  return parts.map(plainText).filter((p) => p.length > 0);
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** Shingles: 5-word windows for space-separated text, 3-character windows for CJK text. */
function shingles(text: string): Set<string> {
  const t = text.toLowerCase();
  const out = new Set<string>();
  if (CJK.test(t)) {
    const s = t.replace(/[\s\p{P}]+/gu, '');
    for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
    if (!out.size && s) out.add(s);
    return out;
  }
  const words = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let i = 0; i + 5 <= words.length; i++) out.add(words.slice(i, i + 5).join(' '));
  if (!out.size && words.length) out.add(words.join(' '));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/** Share of `a`'s shingles that are in `b`. */
function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / a.size;
}

/** A word-level diff of two texts (longest common subsequence): `=` kept, `-` only in the source, `+` only in the draft. */
function wordDiff(source: string, draft: string): Array<{ op: '=' | '-' | '+'; text: string }> {
  const tok = (s: string) => (CJK.test(s) ? [...s] : s.split(/(\s+)/).filter((w) => w.length));
  const a = tok(source).slice(0, 400);
  const b = tok(draft).slice(0, 400);
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Array<{ op: '=' | '-' | '+'; text: string }> = [];
  const push = (op: '=' | '-' | '+', text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('=', a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push('-', a[i++]!);
    else push('+', b[j++]!);
  }
  while (i < a.length) push('-', a[i++]!);
  while (j < b.length) push('+', b[j++]!);
  return out;
}

// ── the draft ───────────────────────────────────────────────────────

/** What the gate reads of the draft. */
export interface DraftView {
  title: string;
  slug: string;
  locale: string;
  bodyHtml: string;
  seoTitle: string;
  seoDescription: string;
  /** Explicit canonical URL, when the item sets one. */
  canonical: string | null;
  /** Every string field of the item (hidden content and safety read all of them). */
  fields: Record<string, string>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The draft as the rules read it, from an item's data. */
export function draftView(data: Record<string, unknown>, bodyField = 'body'): DraftView {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (typeof v === 'string') fields[k] = v;
  const seo = (data.seo && typeof data.seo === 'object' ? data.seo : {}) as Record<string, unknown>;
  return {
    title: str(data.title),
    slug: str(data.slug),
    locale: str(data.locale),
    bodyHtml: str(data[bodyField]),
    seoTitle: str(data.seo_title) || str(seo.title),
    seoDescription: str(data.seo_description) || str(seo.description) || str(data.excerpt),
    canonical: str(data.canonical_url) || str(data.canonical) || str(seo.canonical) || null,
    fields,
  };
}

// ── source rights ───────────────────────────────────────────────────

export interface SourceView {
  id: string;
  kind: 'source_document' | 'item';
  /** Current terms (a source document's source); null for own items. */
  licenceStatus: string | null;
  usageMode: string | null;
  /** Whether the current terms allow the production's operation. */
  usageAllowed: boolean;
  usageReason?: string;
  title: string;
  url: string | null;
  bodyHtml: string;
}

const PASSING_LICENCES = new Set(['licensed', 'own', 'open-license']);

/** `licensed` / `own` / `open-license` with the usage allowed pass; `unknown` needs a person; anything else blocks. */
export function sourceRights(sources: SourceView[]): RuleOutcome {
  const per = sources.map((s) => {
    if (s.kind === 'item') return { id: s.id, kind: s.kind, verdict: 'passed' as const, licenceStatus: 'own' };
    const verdict: Verdict =
      s.licenceStatus === 'unknown' ? 'needs_review' : PASSING_LICENCES.has(String(s.licenceStatus)) && s.usageAllowed ? 'passed' : PASSING_LICENCES.has(String(s.licenceStatus)) ? 'needs_review' : 'blocked';
    return { id: s.id, kind: s.kind, verdict, licenceStatus: s.licenceStatus, usageMode: s.usageMode, ...(s.usageReason ? { usageReason: s.usageReason } : {}) };
  });
  const verdict: Verdict = per.some((p) => p.verdict === 'blocked') ? 'blocked' : per.some((p) => p.verdict === 'needs_review') ? 'needs_review' : 'passed';
  const suggestions = verdict === 'passed' ? [] : ['Record the source licence (licensed, own or open licence) or remove the source before publishing.'];
  return outcome('source_rights', verdict, { sources: per }, suggestions);
}

// ── near duplicate ──────────────────────────────────────────────────

export interface PublishedCandidate {
  siteId: string;
  itemId: string;
  locale: string;
  /** The candidate's translation group, when it has one. */
  groupId: string | null;
  text: string;
}

/**
 * Compare the draft with published content of this site and of the others. A match in the draft's own translation
 * group (explicitly linked) is judged by translation rules: another language is a legitimate translation, the same
 * language is a duplicate. Everything else at or above the threshold blocks. The evidence names the match (site, item,
 * similarity) and never carries its text; the API shows another site's ids only to callers with rights there.
 */
export function nearDuplicate(
  draft: { siteId: string; itemId: string; locale: string; groupId: string | null; text: string },
  candidates: PublishedCandidate[],
  threshold: number,
): RuleOutcome {
  const mine = shingles(draft.text);
  let best: { c: PublishedCandidate; similarity: number } | null = null;
  const translations: Array<{ siteId: string; itemId: string; locale: string; similarity: number }> = [];
  for (const c of candidates) {
    if (c.siteId === draft.siteId && c.itemId === draft.itemId) continue;
    const sim = Math.round(jaccard(mine, shingles(c.text)) * 10_000) / 10_000;
    if (draft.groupId && c.groupId === draft.groupId && c.locale !== draft.locale) {
      translations.push({ siteId: c.siteId, itemId: c.itemId, locale: c.locale, similarity: sim });
      continue;
    }
    if (sim >= threshold && (!best || sim > best.similarity)) best = { c, similarity: sim };
  }
  if (!best) {
    return outcome('near_duplicate', 'passed', { checked: candidates.length, threshold, ...(translations.length ? { translationGroup: { groupId: draft.groupId, judgedBy: 'translation_rules', members: translations } } : {}) });
  }
  const scope = best.c.siteId === draft.siteId ? 'same_site' : 'cross_site';
  return outcome(
    'near_duplicate',
    'blocked',
    { threshold, match: { scope, siteId: best.c.siteId, itemId: best.c.itemId, similarity: best.similarity, sameTranslationGroup: Boolean(draft.groupId && best.c.groupId === draft.groupId) } },
    [scope === 'cross_site' ? 'Another site already published this content. Link the two as a translation group if this is a licensed translation, or write original content.' : 'This site already published this content: update that article instead.'],
    Math.round((1 - best.similarity) * 100),
  );
}

// ── citations ───────────────────────────────────────────────────────

/** Links of a body: those in the citations section, and all of them. */
export function linksOf(html: string): { cited: string[]; all: string[] } {
  const all = [...String(html ?? '').matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]+)"/gi)].map((m) => decode(m[1]!)).filter((u) => /^https?:\/\//i.test(u));
  const section = /<section\b[^>]*data-citations[^>]*>([\s\S]*?)<\/section>/i.exec(String(html ?? ''))?.[1] ?? '';
  const cited = [...section.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]+)"/gi)].map((m) => decode(m[1]!));
  return { cited: [...new Set(cited)], all: [...new Set(all)] };
}

/** Rewrite and write must cite; every cited URL must be reachable (checked through the SSRF-guarded fetch). */
export function citations(mode: string, html: string, reachability: Map<string, { ok: boolean; status?: number; error?: string }>): RuleOutcome {
  const { cited, all } = linksOf(html);
  const urls = cited.length ? cited : all;
  if (!urls.length) {
    return mode === 'rewrite' || mode === 'write'
      ? outcome('citations', 'blocked', { mode, cited: [] }, ['Cite the sources the article is based on (a Sources section with their links).'])
      : outcome('citations', 'passed', { mode, cited: [], required: false });
  }
  const unreachable = urls.filter((u) => reachability.get(u)?.ok === false).map((u) => ({ url: u, ...reachability.get(u) }));
  if (unreachable.length) return outcome('citations', 'blocked', { mode, cited: urls, unreachable }, ['Replace or remove the citations that cannot be reached.'], Math.round(((urls.length - unreachable.length) / urls.length) * 100));
  return outcome('citations', 'passed', { mode, cited: urls });
}

// ── editorial rules ─────────────────────────────────────────────────

export interface EditorialInput {
  version: number | null;
  forbiddenTopics: string[];
  glossary: Array<{ term: string; preferred?: string; avoid?: string[] }>;
}

/**
 * The editorial profile in effect (forbidden topics, glossary spellings to avoid) and the site's active constitution
 * (LumiBase's versioned rule DSL; `llm_judge` verdicts are passed in by the service, which bills them).
 */
export function editorialRules(
  draft: DraftView,
  policy: EditorialInput,
  constitution: { hash: string | null; evaluators: ConstitutionEvaluator[]; judged: Array<{ evaluatorId: string; status: 'pass' | 'fail' | 'error'; blocking: boolean; message?: string }> },
): RuleOutcome {
  const text = `${draft.title}\n${plainText(draft.bodyHtml)}`.toLowerCase();
  const forbidden = policy.forbiddenTopics.filter((t) => t && text.includes(t.toLowerCase()));
  const avoided = policy.glossary.flatMap((g) => (g.avoid ?? []).filter((a) => a && text.includes(a.toLowerCase())).map((a) => ({ term: g.term, avoid: a, preferred: g.preferred ?? g.term })));
  const content = { ...draft.fields, title: draft.title, content: draft.bodyHtml };
  const rules = constitution.evaluators.filter((e): e is RuleEvaluator => e.type === 'rule').map((e) => evaluateRuleEvaluator(e, content));
  const results = [...rules, ...constitution.judged];
  const blockingFailures = results.filter((r) => r.status === 'fail' && r.blocking);
  const errors = results.filter((r) => r.status === 'error' && r.blocking);
  const evidence = {
    editorialProfileVersion: policy.version,
    constitutionHash: constitution.hash,
    forbiddenTopics: forbidden,
    avoidedTerms: avoided,
    constitution: results.filter((r) => r.status !== 'pass'),
  };
  const suggestions = [
    ...forbidden.map((t) => `Remove the forbidden topic "${t}".`),
    ...avoided.map((a) => `Write "${a.preferred}" instead of "${a.avoid}".`),
    ...blockingFailures.map((f) => f.message ?? `Fix constitution rule ${f.evaluatorId}.`),
  ];
  if (forbidden.length || avoided.length || blockingFailures.length) return outcome('editorial_rules', 'blocked', evidence, suggestions);
  if (errors.length) return outcome('editorial_rules', 'needs_review', evidence, ['A constitution judge could not answer: review by hand.']);
  return outcome('editorial_rules', 'passed', evidence);
}

// ── safety ──────────────────────────────────────────────────────────

const PII: Array<{ kind: string; re: RegExp; valid?: (m: string) => boolean }> = [
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'phone', re: /(?<![\w.])(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]\d{3,4}[ -]?\d{3,4}(?![\w.])|(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: 'national_id', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { kind: 'card_number', re: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, valid: (m) => luhn(m.replace(/\D/g, '')) },
  { kind: 'secret', re: /\b(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
];

function luhn(digits: string): boolean {
  if (digits.length < 13) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Illegal content the gate never lets through (a short deterministic list; the editorial profile adds the site's own). */
const ILLEGAL: RegExp[] = [
  /\b(buy|sell|order)\b.{0,30}\b(cocaine|heroin|methamphetamine|fentanyl)\b/i,
  /\bchild\s+(porn|sexual abuse material)\b/i,
  /\b(how to )?(make|build) (a )?(pipe )?bomb\b/i,
  /\b(counterfeit|fake) (passports?|banknotes?|id cards?) for sale\b/i,
  /(出售|代办|购买).{0,10}(假证|假钞|枪支|毒品|身份证信息)/,
];

const mask = (s: string) => (s.length <= 4 ? '****' : `${s.slice(0, 2)}…${s.slice(-2)}`);

/** Personal data and illegal content. A safety block is fixed, never overridden by a reviewer. */
export function safety(draft: DraftView): RuleOutcome {
  const findings: Array<{ kind: string; field: string; excerpt: string }> = [];
  for (const [field, raw] of Object.entries(draft.fields)) {
    const text = plainText(raw);
    for (const p of PII) {
      for (const m of text.match(p.re) ?? []) if (!p.valid || p.valid(m)) findings.push({ kind: p.kind, field, excerpt: mask(m.trim()) });
    }
    for (const r of ILLEGAL) {
      const m = r.exec(text);
      if (m) findings.push({ kind: 'illegal_content', field, excerpt: m[0].slice(0, 80) });
    }
  }
  if (!findings.length) return outcome('safety', 'passed');
  return outcome('safety', 'blocked', { findings, overridable: false }, ['Remove the personal data or illegal content, then run the gate again. A safety block cannot be approved by a reviewer.']);
}

// ── SEO ─────────────────────────────────────────────────────────────

export function seoCompleteness(draft: DraftView, availableLocales: string[]): RuleOutcome {
  const missing: string[] = [];
  if (!draft.title.trim()) missing.push('title');
  if (!draft.seoDescription.trim()) missing.push('description');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug)) missing.push('slug');
  if (!draft.locale || (availableLocales.length && !availableLocales.includes(draft.locale))) missing.push('language');
  // Without an explicit canonical the page is its own canonical (it needs a slug); an explicit one must be absolute.
  if (draft.canonical !== null && !/^https?:\/\/[^\s]+$/i.test(draft.canonical)) missing.push('canonical');
  if (!missing.length) return outcome('seo_completeness', 'passed', { canonical: draft.canonical ?? 'self' });
  return outcome('seo_completeness', 'blocked', { missing }, missing.map((m) => `Add a valid ${m}.`), Math.round(((5 - missing.length) / 5) * 100));
}

export function seoLengths(draft: DraftView): RuleOutcome {
  const title = (draft.seoTitle || draft.title).trim();
  const description = draft.seoDescription.trim();
  const problems: Array<{ field: string; length: number; min: number; max: number }> = [];
  const wide = (s: string) => [...s].reduce((n, ch) => n + (CJK.test(ch) ? 2 : 1), 0);
  if (wide(title) < 10 || wide(title) > 70) problems.push({ field: 'title', length: wide(title), min: 10, max: 70 });
  if (wide(description) < 50 || wide(description) > 170) problems.push({ field: 'description', length: wide(description), min: 50, max: 170 });
  if (!problems.length) return outcome('seo_lengths', 'passed');
  return outcome('seo_lengths', 'blocked', { problems }, problems.map((p) => `Make the ${p.field} ${p.min}–${p.max} characters long (now ${p.length}).`), 60);
}

// ── literal integrity and facts-only overlap ────────────────────────

/** Every protected fragment of the sources must survive translation exactly; a rewrite may drop one but not alter it. */
export function literalIntegrity(mode: string, sources: SourceView[], draft: DraftView): RuleOutcome {
  const source = sources.flatMap((s) => extractFragments(s.bodyHtml));
  const found = extractFragments(draft.bodyHtml);
  const differences: FragmentDifference[] = compareFragments(source, found, { requireAll: mode === 'translate' || mode === 'retranslate' });
  if (!differences.length) return outcome('literal_integrity', 'passed', { checked: source.length });
  return outcome(
    'literal_integrity',
    'blocked',
    { differences },
    differences.map((d) => (d.change === 'missing' ? `Restore ${d.kind} "${d.original}" exactly as in the source.` : `Write ${d.kind} "${d.original}" exactly as in the source (found "${d.found}").`)),
    Math.round((1 - differences.length / Math.max(source.length, 1)) * 100),
  );
}

/** Drafts from facts-only sources must be written in their own words: a paragraph copied from a source blocks. */
export function textOverlap(sources: SourceView[], draft: DraftView, threshold: number): RuleOutcome {
  const facts = sources.filter((s) => s.usageMode === 'facts_only');
  if (!facts.length) return outcome('text_overlap', 'passed', { applies: false });
  const sourceParas = facts.flatMap((s) => paragraphs(s.bodyHtml).map((text) => ({ sourceId: s.id, text, sh: shingles(text) })));
  const all = new Set(sourceParas.flatMap((p) => [...p.sh]));
  const copied: Array<{ paragraph: number; overlap: number; sourceId: string; draft: string; source: string; diff: ReturnType<typeof wordDiff> }> = [];
  paragraphs(draft.bodyHtml).forEach((text, i) => {
    const sh = shingles(text);
    if (sh.size < 2) return;
    const overlap = containment(sh, all);
    if (overlap < threshold) return;
    let best = sourceParas[0]!;
    let bestScore = -1;
    for (const p of sourceParas) {
      const s = containment(sh, p.sh);
      if (s > bestScore) {
        best = p;
        bestScore = s;
      }
    }
    copied.push({ paragraph: i + 1, overlap: Math.round(overlap * 1000) / 1000, sourceId: best.sourceId, draft: text.slice(0, 600), source: best.text.slice(0, 600), diff: wordDiff(best.text, text) });
  });
  if (!copied.length) return outcome('text_overlap', 'passed', { applies: true, threshold });
  return outcome('text_overlap', 'blocked', { threshold, copied }, copied.map((c) => `Rewrite paragraph ${c.paragraph} in your own words: it repeats the facts-only source.`));
}

// ── hidden content ──────────────────────────────────────────────────

/** Invisible characters, hidden text and text addressed to a model, in any string field of the draft. */
export function hiddenContent(draft: DraftView): RuleOutcome {
  const findings: Array<{ field: string; kind: string; paragraph?: number; location: string; excerpt: string }> = [];
  for (const [field, raw] of Object.entries(draft.fields)) {
    if (!raw) continue;
    const isHtml = /<[a-z][^>]*>/i.test(raw);
    const paras = isHtml ? paragraphs(raw) : [raw];
    // Invisible characters, per paragraph (so the evidence points at it).
    const blocks = isHtml ? String(raw).split(/(?=<(?:p|h[1-6]|li|blockquote|pre|div|section|td)\b)/i) : [raw];
    blocks.forEach((b, i) => {
      if (stripInvisible(b) !== b) {
        const codes = [...new Set([...b].filter((ch) => stripInvisible(ch) === '').map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`))];
        findings.push({ field, kind: 'invisible_chars', paragraph: i + 1, location: `${field} block ${i + 1}`, excerpt: `${plainText(stripInvisible(b)).slice(0, 160)} [${codes.join(' ')}]` });
      }
    });
    paras.forEach((p, i) => {
      if (isModelInstruction(stripInvisible(p))) findings.push({ field, kind: 'model_instruction', paragraph: i + 1, location: `${field} paragraph ${i + 1}`, excerpt: p.slice(0, 200) });
    });
    if (isHtml) {
      const { document } = parseHTML(`<!doctype html><html><body>${stripInvisible(raw)}</body></html>`);
      for (const e of stripHiddenContent(document as never)) {
        if (e.kind === 'invisible_chars' || e.kind === 'model_instruction') continue;
        findings.push({ field, kind: e.kind, location: `${field} ${e.location}`, excerpt: e.excerpt });
      }
    }
  }
  if (!findings.length) return outcome('hidden_content', 'passed');
  return outcome('hidden_content', 'blocked', { findings }, ['Remove the invisible characters, hidden text and instructions addressed to models.']);
}

// ── fact check ──────────────────────────────────────────────────────

/** The model's fact check: issues are a warning, never a block, and no issues never pass an article by itself. */
export function factCheck(issues: Array<{ claim: string; problem: string }> | null, error?: string): RuleOutcome {
  if (issues === null) return outcome('fact_check', 'warning', { error: error ?? 'no_answer' }, ['The fact check did not answer: check facts by hand.']);
  if (!issues.length) return outcome('fact_check', 'passed', { issues: [], advisory: true });
  return outcome('fact_check', 'warning', { issues, advisory: true }, issues.map((i) => `Check: ${i.claim} — ${i.problem}`));
}
