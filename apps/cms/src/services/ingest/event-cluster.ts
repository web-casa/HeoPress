import { createHash } from 'node:crypto';

/**
 * Event fingerprints (HeoPress P08 task 4.4; spec ingest/deduplication "同一事件聚合", design "同一事件聚合使用关键实体与时间
 * 窗口生成事件指纹").
 *
 * A small, deterministic entity extractor over the title and the lead (first 400 characters of the body):
 *
 *   - **versions** — `5.2`, `v5.2.1`, `2.0-beta` → `v:5.2` (a leading `v` dropped);
 *   - **proper nouns** — runs of capitalised Latin words (`Example DB`, `ExampleDB`, `Example-DB` all become
 *     `n:exampledb`); a single common word at a sentence start (`The`, `Today`, `Version` …) is ignored;
 *   - **numbers** — other numbers of 2+ digits (`n#2026`, `n#300`), weak evidence only.
 *
 * Versions and proper nouns are *strong* entities. Two reports are the same event when, within the time window, they
 * share at least one strong entity and two entities overall, and do not name different versions (both name versions
 * and no version is shared). Limits, by design: no CJK or other non-Latin proper-noun detection (CJK titles only
 * cluster through Latin names, versions and numbers inside them), no synonyms or translation, no coreference; when in
 * doubt it does **not** merge — two separate representatives cost a little processing, a wrong merge loses a story.
 */

const STOP = new Set(
  [
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'in', 'on', 'at', 'for', 'from', 'with', 'by', 'of', 'to', 'and', 'or', 'but', 'as', 'it', 'its',
    'is', 'are', 'was', 'were', 'be', 'new', 'today', 'yesterday', 'tomorrow', 'now', 'here', 'there', 'how', 'why', 'what', 'when', 'where', 'who',
    'version', 'release', 'released', 'releases', 'update', 'updated', 'breaking', 'report', 'reports', 'news', 'after', 'before', 'more', 'all', 'we',
    'our', 'you', 'your', 'they', 'their', 'he', 'she', 'his', 'her', 'i', 'my', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
    'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  ],
);

const VERSION = /\bv?(\d+(?:\.\d+)+(?:-[0-9a-z]+(?:\.[0-9a-z]+)*)?)\b/gi;
const PROPER_RUN = /\b[A-Z][\p{L}\p{N}]*(?:[ -][A-Z][\p{L}\p{N}]*)*\b/gu;
const NUMBER = /\b\d{2,}\b/g;

export interface EventEntities {
  /** Every entity, sorted. */
  all: string[];
  strong: string[];
  versions: string[];
}

/** The key entities of a report (title + lead). */
export function extractEntities(title: string, body: string): EventEntities {
  const textIn = `${title}\n${body.slice(0, 400)}`;
  const versions = new Set<string>();
  const nouns = new Set<string>();
  const numbers = new Set<string>();
  let rest = textIn.replace(VERSION, (_m, v: string) => {
    versions.add(`v:${v.toLowerCase()}`);
    return ' ';
  });
  rest = rest.replace(PROPER_RUN, (m) => {
    const words = m.split(/[ -]/).filter((w) => !STOP.has(w.toLowerCase()));
    if (words.length === 0) return ' ';
    if (words.length === 1 && /^\d/.test(words[0]!)) return ' ';
    nouns.add(`n:${words.join('').toLowerCase()}`);
    return ' ';
  });
  for (const m of rest.match(NUMBER) ?? []) numbers.add(`n#${m}`);
  const strong = [...versions, ...nouns].sort();
  return { all: [...strong, ...numbers].sort(), strong, versions: [...versions].sort() };
}

/** The fingerprint of a set of strong entities. */
export function eventFingerprint(entities: EventEntities): string {
  return createHash('sha256').update(entities.strong.join('|')).digest('hex').slice(0, 32);
}

/** Rebuild the parts from a stored entity list. */
export function entitiesFromList(list: readonly string[]): EventEntities {
  const all = [...list].sort();
  return { all, strong: all.filter((e) => e.startsWith('v:') || e.startsWith('n:')), versions: all.filter((e) => e.startsWith('v:')) };
}

/** Same event: ≥ 1 shared strong entity, ≥ 2 shared entities, and no conflicting versions. */
export function sameEvent(a: EventEntities, b: EventEntities): boolean {
  if (a.versions.length && b.versions.length && !a.versions.some((v) => b.versions.includes(v))) return false;
  const bAll = new Set(b.all);
  const shared = a.all.filter((e) => bAll.has(e));
  return shared.length >= 2 && shared.some((e) => e.startsWith('v:') || e.startsWith('n:'));
}
