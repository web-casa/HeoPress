import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { glossary as glossaryTable, translationMemory, type Database } from '@heopress/database';
import type { AiCapability } from '@heopress/contracts/schemas';
import { runSiteTransaction } from '../rls-transaction';
import { bestMatch } from '../translation-memory';
import { TranslationError, type TranslationResult, type TranslationService } from '../llm/translation-service';
import { protectFragments, restoreFragments } from '../quality-gate/protected-fragments';
import { sanitizeModelHtml } from './safety';

/**
 * Block-level translation (HeoPress P09 task 1.3; spec ai/content-pipeline "区块级翻译与翻译记忆"; design decision 3).
 *
 * For each block, in order:
 *   1. **translation memory, exact**: the same source text in the same language pair → its translation, no model;
 *   2. **glossary**: each term found becomes a placeholder (`⟦T0⟧`) before the model sees the text and is put back as
 *      the glossary's rendering afterwards — `prefer` and `do-not-translate` terms are enforced, not only suggested;
 *      a translation that loses a placeholder is refused;
 *   2b. **protected fragments** (task 2.5): code, commands, URLs, versions and identifiers become placeholders
 *      (`⟦P0⟧`) first and are put back verbatim; a translation that loses one is refused (the gate re-checks them);
 *   3. **model**, through the internal `TranslationService` (ledger, budget), with fuzzy memory matches as references.
 * Model translations go back into the memory (`source = 'mt'`); exact hits count a hit.
 */

export interface SourceBlock {
  /** The block's key (`body#b_1`, `title`, `seo_title#$`, …). */
  key: string;
  /** HTML of one element, or plain text for a text field. */
  text: string;
  /** Plain-text field (titles, SEO): the answer is not HTML. */
  plain?: boolean;
}

interface TranslatedBlock {
  key: string;
  text: string;
  origin: 'memory' | 'model';
}

export interface GlossaryTerm {
  term: string;
  translation: string;
  rule: 'prefer' | 'do-not-translate' | 'forbidden';
}

/** Memory lookups for one site and language pair. */
export interface TranslationMemoryStore {
  exact(texts: string[]): Promise<Map<string, string>>;
  fuzzy(text: string): Promise<{ source: string; target: string; score: number } | null>;
  learn(pairs: Array<{ source: string; target: string }>, provider: string, context: string): Promise<void>;
  hit(texts: string[]): Promise<void>;
}

const FUZZY_THRESHOLD = 75;
const FUZZY_CANDIDATES = 300;

/** The database memory of a site (`lumibase_translation_memory`). */
export class DbTranslationMemory implements TranslationMemoryStore {
  constructor(private readonly deps: { db: Database; siteId: string; from: string; to: string }) {}

  private pair() {
    const { siteId, from, to } = this.deps;
    return and(eq(translationMemory.siteId, siteId), eq(translationMemory.sourceLang, from), eq(translationMemory.targetLang, to));
  }

  async exact(texts: string[]): Promise<Map<string, string>> {
    if (!texts.length) return new Map();
    const rows = await runSiteTransaction(this.deps.db, this.deps.siteId, (tx) =>
      tx
        .select({ source: translationMemory.sourceText, target: translationMemory.targetText })
        .from(translationMemory)
        .where(and(this.pair(), inArray(translationMemory.sourceText, [...new Set(texts)])))
        .orderBy(desc(translationMemory.quality), desc(translationMemory.updatedAt)),
    );
    const out = new Map<string, string>();
    for (const r of rows) if (!out.has(r.source)) out.set(r.source, r.target);
    return out;
  }

  async fuzzy(text: string): Promise<{ source: string; target: string; score: number } | null> {
    // Candidates of a similar length (Levenshtein similarity cannot reach the threshold otherwise).
    const min = Math.floor(text.length * 0.6);
    const max = Math.ceil(text.length / 0.6);
    const rows = await runSiteTransaction(this.deps.db, this.deps.siteId, (tx) =>
      tx
        .select({ id: translationMemory.id, sourceText: translationMemory.sourceText, targetText: translationMemory.targetText, quality: translationMemory.quality })
        .from(translationMemory)
        .where(and(this.pair(), sql`length(${translationMemory.sourceText}) BETWEEN ${min} AND ${max}`))
        .orderBy(desc(translationMemory.hits))
        .limit(FUZZY_CANDIDATES),
    );
    const best = bestMatch(text, rows, FUZZY_THRESHOLD);
    return best ? { source: best.entry.sourceText, target: best.entry.targetText, score: best.score } : null;
  }

  async learn(pairs: Array<{ source: string; target: string }>, provider: string, context: string): Promise<void> {
    if (!pairs.length) return;
    const { siteId, from, to } = this.deps;
    await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx.insert(translationMemory).values(
        pairs.map((p) => ({ siteId, sourceLang: from, targetLang: to, sourceText: p.source, targetText: p.target, context, quality: 80, source: 'mt', provider })),
      ),
    );
  }

  async hit(texts: string[]): Promise<void> {
    if (!texts.length) return;
    await runSiteTransaction(this.deps.db, this.deps.siteId, (tx) =>
      tx
        .update(translationMemory)
        .set({ hits: sql`${translationMemory.hits} + 1` })
        .where(and(this.pair(), inArray(translationMemory.sourceText, [...new Set(texts)]))),
    );
  }
}

/** The site's glossary for a language pair (`lumibase_glossary`) plus the editorial profile's preferred terms. */
export async function loadGlossary(
  db: Database,
  siteId: string,
  from: string,
  to: string,
  profileGlossary: Array<{ term: string; preferred?: string }> = [],
): Promise<GlossaryTerm[]> {
  const rows = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select({ term: glossaryTable.term, translation: glossaryTable.translation, rule: glossaryTable.rule })
      .from(glossaryTable)
      .where(and(eq(glossaryTable.siteId, siteId), eq(glossaryTable.sourceLang, from), eq(glossaryTable.targetLang, to))),
  );
  const out: GlossaryTerm[] = rows.map((r) => ({
    term: r.term,
    translation: r.rule === 'do-not-translate' ? r.term : r.translation,
    rule: (['prefer', 'do-not-translate', 'forbidden'].includes(r.rule) ? r.rule : 'prefer') as GlossaryTerm['rule'],
  }));
  for (const g of profileGlossary) {
    if (g.preferred && !out.some((o) => o.term === g.term)) out.push({ term: g.term, translation: g.preferred, rule: 'prefer' });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWordy = (s: string) => /^[A-Za-z0-9]/.test(s) && /[A-Za-z0-9]$/.test(s);

/** Replace enforced glossary terms by placeholders (longest first, whole words for Latin terms). */
export function protectTerms(text: string, terms: GlossaryTerm[]): { text: string; slots: Array<{ token: string; value: string; term: string }> } {
  const slots: Array<{ token: string; value: string; term: string }> = [];
  let out = text;
  for (const t of [...terms].filter((t) => t.rule !== 'forbidden').sort((a, b) => b.term.length - a.term.length)) {
    const re = new RegExp(isWordy(t.term) ? `(?<![A-Za-z0-9])${escapeRe(t.term)}(?![A-Za-z0-9])` : escapeRe(t.term), 'g');
    if (!re.test(out)) continue;
    const token = `⟦T${slots.length}⟧`;
    slots.push({ token, value: t.translation, term: t.term });
    out = out.replace(re, token);
  }
  return { text: out, slots };
}

/** Put the glossary renderings back; null when the translation lost a placeholder. */
export function restoreTerms(text: string, slots: Array<{ token: string; value: string }>): string | null {
  let out = text;
  for (const s of slots) {
    if (!out.includes(s.token)) return null;
    out = out.split(s.token).join(s.value);
  }
  return out;
}

export interface BlockTranslationOutput {
  blocks: TranslatedBlock[];
  /** The model call, when one was made. */
  call: TranslationResult | null;
  memoryHits: number;
  fuzzyReferences: number;
  glossaryApplied: string[];
  /** Forbidden renderings found in model output (recorded; the gate decides). */
  forbiddenFound: string[];
}

export async function translateBlocks(input: {
  siteId: string;
  from: string;
  to: string;
  blocks: SourceBlock[];
  memory: TranslationMemoryStore;
  glossary: GlossaryTerm[];
  service: TranslationService;
  callKey?: string;
  origin?: { kind: string; id?: string };
  capability?: AiCapability;
  context: string;
  signal?: AbortSignal;
}): Promise<BlockTranslationOutput> {
  const exact = await input.memory.exact(input.blocks.map((b) => b.text));
  const done = new Map<string, TranslatedBlock>();
  for (const b of input.blocks) {
    const hit = exact.get(b.text);
    if (hit !== undefined) done.set(b.key, { key: b.key, text: hit, origin: 'memory' });
  }
  const todo = input.blocks.filter((b) => !done.has(b.key));
  await input.memory.hit(input.blocks.filter((b) => done.has(b.key)).map((b) => b.text));
  let call: TranslationResult | null = null;
  const applied = new Set<string>();
  const forbiddenFound: string[] = [];
  let fuzzyReferences = 0;
  if (todo.length) {
    const prepared = todo.map((b, i) => {
      // Fragments first (a term inside code stays code), then the glossary terms in what is left.
      const fragments = protectFragments(b.text);
      return { block: b, id: `s${i + 1}`, fragments: fragments.slots, ...protectTerms(fragments.text, input.glossary) };
    });
    const memory: Array<{ source: string; target: string }> = [];
    for (const p of prepared) {
      const near = await input.memory.fuzzy(p.block.text);
      if (near) memory.push({ source: near.source, target: near.target });
    }
    fuzzyReferences = memory.length;
    call = await input.service.translate({
      siteId: input.siteId,
      sourceLocale: input.from,
      targetLocale: input.to,
      segments: prepared.map((p) => ({ id: p.id, text: p.text })),
      // Enforced terms travel as placeholders the model must keep (the prompt says so); nothing else to tell it.
      glossary: [],
      memory,
      callKey: input.callKey,
      origin: input.origin,
      capability: input.capability,
      signal: input.signal,
    });
    const byId = new Map(call.segments.map((s) => [s.id, s.text]));
    const learned: Array<{ source: string; target: string }> = [];
    for (const p of prepared) {
      const terms = restoreTerms(byId.get(p.id) ?? '', p.slots);
      if (terms === null) throw new TranslationError('BAD_TRANSLATION', `The translation of ${p.block.key} lost a glossary term.`);
      const restored = restoreFragments(terms, p.fragments);
      if (restored === null) throw new TranslationError('BAD_TRANSLATION', `The translation of ${p.block.key} lost a protected fragment.`);
      for (const s of p.slots) applied.add(s.term);
      const text = p.block.plain ? restored.replace(/\s+/g, ' ').trim() : sanitizeModelHtml(restored);
      for (const g of input.glossary) if (g.rule === 'forbidden' && g.translation && text.includes(g.translation)) forbiddenFound.push(g.translation);
      done.set(p.block.key, { key: p.block.key, text, origin: 'model' });
      learned.push({ source: p.block.text, target: text });
    }
    await input.memory.learn(learned, `${call.engine}:${call.model}`, input.context);
  }
  return {
    blocks: input.blocks.map((b) => done.get(b.key)!),
    call,
    memoryHits: input.blocks.length - todo.length,
    fuzzyReferences,
    glossaryApplied: [...applied],
    forbiddenFound,
  };
}
