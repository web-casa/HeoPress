import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

/**
 * Sanitised rich text as Markdown (HeoPress P07 tasks 4.1, 4.2; spec geo/machine-readable-content): the body of a
 * page's Markdown copy and of `llms-full.txt`. The input is the projection's sanitised HTML (its elements are the
 * sanitiser's allow-list); links and images become absolute against the page. Text is escaped where Markdown would read
 * it as syntax; anything not known keeps its text.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const isElement = (n: Node): n is Element => 'tagName' in n;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? null;

/** Characters Markdown reads as syntax at any place in a line, escaped. */
function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`);
}

/**
 * At the start of a line: what could begin a heading, a list, a quote, a rule, a setext underline or a fence, whatever
 * follows it (Codex review of batch 9, round 2: `>` needs no space, `---` and `===` are lines of their own). An escape
 * too many is harmless: a backslash before punctuation always stands for the character. Our own syntax (`**`, `[`, `!`,
 * a code span, `~~`) never starts with one of these.
 */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)([#>+=-]|~~~)/, '$1\\$2').replace(/^(\s*\d+)([.)])/, '$1\\$2');
}

function absolute(url: string | null, base: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, base);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A URL inside `( )`: spaces and parentheses escaped. */
const destination = (url: string) => url.replace(/[ ()]/g, (c) => ({ ' ': '%20', '(': '%28', ')': '%29' })[c]!);

function inline(nodes: Node[], base: string): string {
  return nodes.map((n) => inlineOf(n, base)).join('');
}

function inlineOf(n: Node, base: string): string {
  if (n.nodeName === '#text') return escapeText((n as DefaultTreeAdapterMap['textNode']).value.replace(/\s+/g, ' '));
  if (!isElement(n)) return '';
  const inner = () => inline(n.childNodes, base);
  switch (n.tagName) {
    case 'strong':
    case 'b': {
      const t = inner().trim();
      return t ? `**${t}**` : '';
    }
    case 'em':
    case 'i': {
      const t = inner().trim();
      return t ? `*${t}*` : '';
    }
    case 's':
      return `~~${inner()}~~`;
    case 'code': {
      // The code as it is: delimited by more backticks than its longest run (CommonMark), padded when it starts or ends
      // with one (Codex review of batch 9: never rewritten).
      const code = textOf(n).replace(/\n/g, ' ');
      if (!code) return '';
      const fence = '`'.repeat(longestRun(code, '`') + 1);
      const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
      return `${fence}${pad}${code}${pad}${fence}`;
    }
    case 'br':
      return '  \n';
    case 'a': {
      const href = absolute(attr(n, 'href'), base);
      // An empty link shows its address, escaped as text (round 2: never Markdown of its own).
      const text = inner().trim() || escapeText(href ?? '');
      return href ? `[${text}](${destination(href)})` : text;
    }
    case 'img': {
      const src = absolute(attr(n, 'src'), base);
      return src ? `![${escapeText(attr(n, 'alt') ?? '')}](${destination(src)})` : '';
    }
    default:
      return inner();
  }
}

/** Block content: paragraphs and blocks separated by a blank line. */
function blocks(nodes: Node[], base: string): string[] {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const text = inline(run, base).trim();
    if (text) out.push(text.split('\n').map(escapeLineStart).join('\n'));
    run = [];
  };
  for (const n of nodes) {
    if (isElement(n) && BLOCK.has(n.tagName)) {
      flush();
      const b = block(n, base);
      if (b) out.push(b);
    } else {
      run.push(n);
    }
  }
  flush();
  return out;
}

const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'hr', 'table', 'figure', 'figcaption', 'dl', 'dt', 'dd']);

function block(el: Element, base: string): string {
  switch (el.tagName) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      // A line break inside a heading starts a line of its own: escaped as any other (Codex review of batch 9, round 3).
      const t = inline(el.childNodes, base).trim().split('\n').map((l, i) => (i === 0 ? l : escapeLineStart(l))).join('\n');
      return t ? `${'#'.repeat(Number(el.tagName[1]))} ${t}` : '';
    }
    case 'hr':
      return '---';
    case 'pre': {
      // A fence longer than any run of backticks in the code: it cannot be closed early.
      const text = textOf(el).replace(/\n+$/, '');
      const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
      return `${fence}\n${text}\n${fence}`;
    }
    case 'blockquote':
      return blocks(el.childNodes, base)
        .join('\n\n')
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'ul':
    case 'ol': {
      let i = 0;
      return el.childNodes
        .filter((c): c is Element => isElement(c) && c.tagName === 'li')
        .map((li) => {
          i++;
          const mark = el.tagName === 'ol' ? `${i}.` : '-';
          const body = blocks(li.childNodes, base).join('\n\n');
          return `${mark} ${body.split('\n').join(`\n${' '.repeat(mark.length + 1)}`)}`;
        })
        .join('\n');
    }
    case 'table': {
      const rows = rowsOf(el).map((r) => r.map((c) => inline(c.childNodes, base).trim().replace(/\n/g, ' ')));
      if (rows.length === 0) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? '').join(' | ')} |`;
      return [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
    }
    default:
      return blocks(el.childNodes, base).join('\n\n');
  }
}

function rowsOf(el: Element): Element[][] {
  const rows: Element[][] = [];
  const walk = (n: Element) => {
    for (const c of n.childNodes) {
      if (!isElement(c)) continue;
      if (c.tagName === 'tr') rows.push(c.childNodes.filter((x): x is Element => isElement(x) && (x.tagName === 'td' || x.tagName === 'th')));
      else if (c.tagName === 'thead' || c.tagName === 'tbody' || c.tagName === 'tfoot') walk(c);
    }
  };
  walk(el);
  return rows;
}

/** The longest run of `ch` in `text`. */
function longestRun(text: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

function textOf(n: Node): string {
  if (n.nodeName === '#text') return (n as DefaultTreeAdapterMap['textNode']).value;
  return isElement(n) ? n.childNodes.map(textOf).join('') : '';
}

/** Sanitised HTML as Markdown, links and images absolute against `base`. */
export function htmlToMarkdown(html: string, base: string): string {
  const fragment = parseFragment(html);
  return blocks(fragment.childNodes as Node[], base).join('\n\n').trim();
}

/** Plain text as Markdown paragraphs (a body that is not rich text): escaped, blank lines kept as paragraph breaks. */
export function textToMarkdown(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    // Every line's start escaped (a line inside a paragraph could begin a heading or a list too).
    .map((p) => escapeText(p).split('\n').map(escapeLineStart).join('  \n'))
    .join('\n\n');
}

/** The copy's address of a page's address (`https://h/a/b/` → `https://h/a/b.md`); null for a site's root (P07 task 4.2). */
export function markdownUrlOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, '');
  if (!path) return null;
  u.pathname = `${path}.md`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Letters and digits only, lowercased: what two renderings of one text must share whatever their markup. */
const letters = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The text a reader gets of sanitised HTML: its text, an image's alternative text, an empty link's address. */
function readerText(nodes: Node[], base: string): string {
  return nodes
    .map((n) => {
      if (n.nodeName === '#text') return (n as DefaultTreeAdapterMap['textNode']).value;
      if (!isElement(n)) return '';
      if (n.tagName === 'img') return ` ${attr(n, 'alt') ?? ''} `;
      const inner = readerText(n.childNodes, base);
      if (n.tagName === 'a' && !inner.trim()) return ` ${absolute(attr(n, 'href'), base) ?? ''} `;
      return ` ${inner} `;
    })
    .join('');
}

/** Elements whose content a Markdown copy cannot carry (an embed, media, a form, a drawing). */
const OPAQUE = new Set(['iframe', 'video', 'audio', 'object', 'embed', 'canvas', 'svg', 'form', 'math', 'picture', 'source']);

/**
 * Whether a page's Markdown copy says what its rich text says (HeoPress P07 task 5.1, rule `markdown/inconsistent`): the
 * letters and digits of the copy's body, link and image addresses aside, against those the HTML shows a reader; and the
 * elements the copy leaves out. Null: consistent; else what differs (the elements left out, or where the texts part).
 */
export function markdownCopyDifference(html: string, base: string): { opaque: string[]; at: string | null } | null {
  const fragment = parseFragment(html);
  const opaque = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      if (OPAQUE.has(n.tagName)) opaque.add(n.tagName);
      walk(n.childNodes);
    }
  };
  walk(fragment.childNodes as Node[]);
  const page = letters(readerText(fragment.childNodes as Node[], base));
  // The copy without its link and image destinations (`](…)`), whose escapes are not text either.
  // Ordered lists' numbers are the copy's markup, not text.
  const copy = letters(
    htmlToMarkdown(html, base)
      .replace(/\]\((?:[^()\s]|\([^()]*\))*\)/g, ']')
      .replace(/^(\s*(?:> ?)*)\d+\. /gm, '$1'),
  );
  let at: string | null = null;
  if (page !== copy) {
    let i = 0;
    while (i < page.length && page[i] === copy[i]) i++;
    at = page.slice(Math.max(0, i - 20), i + 40);
  }
  return opaque.size || at !== null ? { opaque: [...opaque].sort(), at } : null;
}

/**
 * A field as plain text (the description of the head, the feeds and llms): a rich-text field (sanitised HTML) without
 * its tags and with its character references read; another field as it is (Codex review of batch 6).
 */
export function plainFieldOf(row: { data: Record<string, unknown>; richFields: string[] }, field: string): string {
  const raw = row.data[field];
  const value = typeof raw === 'string' ? raw : '';
  if (!value || !row.richFields.includes(field)) return value;
  return value
    // A block or a line break separates words; an inline element does not (`Exam<strong>ple</strong>` is one word).
    .replace(/<\/?(?:p|div|br|hr|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|pre|table|thead|tbody|tfoot|tr|td|th|caption|figure|figcaption)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, ref: string) => {
      const r = ref.toLowerCase();
      if (r.startsWith('#x')) return String.fromCodePoint(parseInt(r.slice(2), 16));
      if (r.startsWith('#')) return String.fromCodePoint(Number(r.slice(1)));
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[r]!;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
