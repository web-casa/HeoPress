/**
 * Term links in a body (pure: no host, no I/O).
 *
 * The plugin links the first occurrence of each published term (its title or an alias) in an article's HTML body to the
 * term's page, with the term's short definition as the link's title — the tooltip readers see on hover. The links it
 * writes carry a marker attribute (`data-heopress-glossary`, kept in the stored body, dropped by the public sanitiser),
 * so recomputing them first removes its own links and then links again: a deleted or renamed term leaves no stale link,
 * and running twice changes nothing.
 *
 * Text inside links, code, preformatted blocks and headings is never linked. Latin-script terms match whole words only;
 * terms in scripts written without spaces (Chinese, Japanese, Korean) match anywhere in the text.
 */

/** A published term, as the plugin reads it from its collection. */
export interface GlossaryTerm {
  id: string;
  slug: string;
  title: string;
  /** Other spellings that link to the same term. */
  aliases: string[];
  /** The short definition (the tooltip). */
  definition: string;
  /** The term's language; '' for a term without one (it links in every language). */
  locale: string;
}

export interface LinkOptions {
  /** The address of a term's page. */
  hrefOf(term: GlossaryTerm): string;
  /** At most this many terms are linked in one body. */
  maxLinks: number;
  /** The body's language ('' when unknown: every term may link). */
  locale: string;
}

/** The attribute that marks a link as the plugin's own. */
export const LINK_MARKER = 'data-heopress-glossary';

/** Elements whose text is never linked. */
const SKIP = new Set(['a', 'code', 'pre', 'kbd', 'samp', 'script', 'style', 'textarea', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Scripts written without spaces between words: no word boundaries apply. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The tooltip text of a term: its definition (or title) on one line, at most 200 characters. */
export function tooltipOf(term: Pick<GlossaryTerm, 'definition' | 'title'>): string {
  const text = (term.definition || term.title).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;
}

/** Remove the plugin's own links from a body, keeping their text. */
export function unlinkTerms(html: string): string {
  return html.replace(new RegExp(`<a\\b[^>]*\\s${LINK_MARKER}="[^"]*"[^>]*>([\\s\\S]*?)</a>`, 'gi'), '$1');
}

/** One alternative of the term pattern: whole words for spaced scripts. */
function alternative(form: string): string {
  const body = escapeRegExp(form);
  const first = form[0] ?? '';
  const last = form[form.length - 1] ?? '';
  const before = WORD_CHAR.test(first) && !UNSPACED.test(first) ? '(?<![\\p{L}\\p{N}])' : '';
  const after = WORD_CHAR.test(last) && !UNSPACED.test(last) ? '(?![\\p{L}\\p{N}])' : '';
  return `${before}${body}${after}`;
}

const sameLocale = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Link the terms in `html`. Returns the new body and the terms it links (in order of first occurrence); the body is
 * unchanged when it already carries exactly these links.
 */
export function linkTerms(html: string, terms: readonly GlossaryTerm[], opts: LinkOptions): { html: string; linked: GlossaryTerm[] } {
  const base = unlinkTerms(html);
  const byForm = new Map<string, GlossaryTerm>();
  for (const term of terms) {
    if (term.locale && opts.locale && !sameLocale(term.locale, opts.locale)) continue;
    for (const raw of [term.title, ...term.aliases]) {
      const form = raw.trim();
      if (form.length < 2) continue;
      const key = escapeHtml(form).toLowerCase();
      if (!byForm.has(key)) byForm.set(key, term);
    }
  }
  if (byForm.size === 0 || opts.maxLinks <= 0) return { html: base, linked: [] };
  // Longest first: "REST API" wins over "API".
  const forms = [...byForm.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const pattern = new RegExp(forms.map(alternative).join('|'), 'giu');

  const linked: GlossaryTerm[] = [];
  const done = new Set<string>();
  const open = new Map<string, number>();
  const skipping = () => [...open.values()].some((n) => n > 0);
  const parts = base.split(/(<[^>]*>)/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 1) {
      const tag = /^<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(part);
      const name = tag?.[2]?.toLowerCase();
      if (name && SKIP.has(name) && !/\/\s*>$/.test(part)) open.set(name, Math.max(0, (open.get(name) ?? 0) + (tag?.[1] ? -1 : 1)));
      continue;
    }
    if (!part || skipping() || linked.length >= opts.maxLinks) continue;
    parts[i] = part.replace(pattern, (match) => {
      const term = byForm.get(match.toLowerCase());
      if (!term || done.has(term.id) || linked.length >= opts.maxLinks) return match;
      done.add(term.id);
      linked.push(term);
      return `<a href="${escapeHtml(opts.hrefOf(term))}" title="${escapeHtml(tooltipOf(term))}" ${LINK_MARKER}="${escapeHtml(term.slug)}">${match}</a>`;
    });
  }
  return { html: parts.join(''), linked };
}

/** Where a term's page is: its language's prefix (`/fr`), the plugin's route `/glossary/:slug`, the site's trailing slash. */
export function termHref(term: Pick<GlossaryTerm, 'slug' | 'locale'>, site: { localePrefixes: Readonly<Record<string, string>>; trailingSlash: boolean }): string {
  const raw = term.locale ? (site.localePrefixes[term.locale] ?? '') : '';
  const prefix = /^\/[A-Za-z0-9_-]+$/.test(raw.replace(/\/+$/, '')) ? raw.replace(/\/+$/, '') : '';
  return `${prefix}/glossary/${encodeURIComponent(term.slug)}${site.trailingSlash ? '/' : ''}`;
}
