/**
 * Protected fragments and literal integrity (HeoPress P09 task 2.5; spec ai/quality-gate "受保护片段与字面完整性").
 *
 * Code blocks, inline code, commands, URLs, version numbers and identifiers (CVE / GHSA / RFC numbers) must reach the
 * reader exactly as the source wrote them. Before a model sees a text, `protectFragments` replaces each one by a
 * placeholder (`⟦P0⟧`) the model is told to keep; `restoreFragments` puts the originals back and answers null when a
 * placeholder went missing. After writing, the gate compares the fragments of the sources and the draft
 * (`compareFragments`): a fragment that is missing or changed is a block, with the original and the draft value as
 * evidence.
 */

type FragmentKind = 'code' | 'command' | 'url' | 'version' | 'identifier';

export interface Fragment {
  kind: FragmentKind;
  /** The literal value: for code, its text with whitespace runs collapsed; otherwise the matched text. */
  value: string;
}

const CODE_ELEMENT = /<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi;
const URL = /\bhttps?:\/\/[^\s"'<>()\]]+[^\s"'<>()\].,;:!?]/gi;
const IDENTIFIER = /\b(?:CVE-\d{4}-\d{4,7}|GHSA(?:-[0-9a-z]{4}){3}|RFC ?\d{3,5})\b/gi;
const VERSION = /(?<![\w.])(?:v\d+(?:\.\d+)+|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)(?![\w])/g;
const COMMAND = /^\s*(?:\$\s*)?(?:sudo|apt|apt-get|yum|dnf|apk|brew|npm|npx|pnpm|yarn|pip3?|git|docker|kubectl|helm|curl|wget|systemctl|service|make|go|cargo|rustup|composer|php|node|python3?|ssh|scp|rsync|chmod|chown|mkdir|rm|cp|mv|tar|cd|ls|cat|echo|export|nginx|openssl)\b/;

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const textOf = (html: string) => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** Every protected fragment of an HTML (or plain) text, in order. */
export function extractFragments(html: string): Fragment[] {
  const out: Fragment[] = [];
  const rest = (html ?? '').replace(CODE_ELEMENT, (m) => {
    const value = textOf(m);
    if (value) out.push({ kind: COMMAND.test(value) ? 'command' : 'code', value });
    return ' ';
  });
  // URLs from text and from link targets; then identifiers and versions from the text outside URLs.
  const hrefs = [...rest.matchAll(/\bhref\s*=\s*"([^"]*)"/gi)].map((m) => decode(m[1]!));
  const text = decode(rest.replace(/<[^>]*>/g, ' '));
  const urls = [...hrefs.filter((h) => /^https?:\/\//i.test(h)), ...(text.match(URL) ?? [])];
  for (const u of urls) out.push({ kind: 'url', value: u });
  const plain = text.replace(URL, ' ');
  for (const m of plain.match(IDENTIFIER) ?? []) out.push({ kind: 'identifier', value: m });
  for (const m of plain.replace(IDENTIFIER, ' ').match(VERSION) ?? []) out.push({ kind: 'version', value: m });
  return out;
}

export interface FragmentSlot {
  token: string;
  value: string;
}

/**
 * Replace the protected fragments of `text` by placeholders: code elements whole, URLs (in text and `href`),
 * identifiers and versions in text. Tags themselves are never touched (block ids stay).
 */
export function protectFragments(text: string, prefix = 'P'): { text: string; slots: FragmentSlot[] } {
  const slots: FragmentSlot[] = [];
  const slot = (value: string) => {
    const existing = slots.find((s) => s.value === value);
    if (existing) return existing.token;
    const token = `⟦${prefix}${slots.length}⟧`;
    slots.push({ token, value });
    return token;
  };
  const withCode = text.replace(CODE_ELEMENT, (m) => slot(m));
  const out = withCode
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) return part.replace(/(\bhref\s*=\s*")(https?:\/\/[^"]*)(")/gi, (_m, a: string, u: string, b: string) => `${a}${slot(u)}${b}`);
      return part
        .replace(URL, (m) => slot(m))
        .replace(IDENTIFIER, (m) => slot(m))
        .replace(VERSION, (m) => slot(m));
    })
    .join('');
  return { text: out, slots };
}

/** Put the protected fragments back; null when the processed text lost a placeholder. */
export function restoreFragments(text: string, slots: FragmentSlot[]): string | null {
  let out = text;
  for (const s of slots) {
    if (!out.includes(s.token)) return null;
    out = out.split(s.token).join(s.value);
  }
  return out;
}

/** Similarity 0–1 of two strings (normalised Levenshtein over at most 400 characters). */
function similarity(a: string, b: string): number {
  const x = a.slice(0, 400);
  const y = b.slice(0, 400);
  if (!x.length && !y.length) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length);
}

export interface FragmentDifference {
  kind: FragmentKind;
  /** The source's value. */
  original: string;
  /** The closest draft value of the same kind (null: none at all). */
  found: string | null;
  change: 'missing' | 'altered';
}

/**
 * Compare the sources' fragments with the draft's. `requireAll` (a translation): every source fragment must be in the
 * draft, so a missing one is a difference too. Otherwise (rewrite, write) a fragment may be left out, but one that is
 * there in a changed form (the closest draft value is similar but not equal) is a difference.
 */
export function compareFragments(source: Fragment[], draft: Fragment[], opts: { requireAll: boolean }): FragmentDifference[] {
  const pool = new Map<string, number>();
  const keyOf = (f: Fragment) => `${f.kind === 'command' ? 'code' : f.kind}\u0000${f.value}`;
  for (const f of draft) pool.set(keyOf(f), (pool.get(keyOf(f)) ?? 0) + 1);
  const diffs: FragmentDifference[] = [];
  const seen = new Set<string>();
  for (const f of source) {
    const key = keyOf(f);
    if ((pool.get(key) ?? 0) > 0) {
      pool.set(key, pool.get(key)! - 1);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const family = (k: FragmentKind) => (k === 'command' ? 'code' : k);
    let best: { value: string; score: number } | null = null;
    for (const d of draft) {
      if (family(d.kind) !== family(f.kind)) continue;
      const score = similarity(f.value, d.value);
      if (!best || score > best.score) best = { value: d.value, score };
    }
    const altered = best !== null && best.score >= 0.5;
    if (altered) diffs.push({ kind: f.kind, original: f.value, found: best!.value, change: 'altered' });
    else if (opts.requireAll) diffs.push({ kind: f.kind, original: f.value, found: null, change: 'missing' });
  }
  return diffs;
}
