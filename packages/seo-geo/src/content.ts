/**
 * The normalised content of a page (HeoPress P07 task 2.5; spec seo/page-metadata "真实修改时间"): what its real
 * modification time follows. The content title (never `seo_title`), the excerpt and the bodies, each reduced to its
 * text and the addresses it shows (link targets, image sources and alternative texts), block by block in order.
 * Markup that only shapes how it looks (inline formatting, attributes, whitespace, entity spelling) does not count,
 * so a theme, a renderer or a sanitiser change never moves the time; a reordered block does.
 */

export interface ContentParts {
  title: string;
  excerpt: string;
  /** The rich-text bodies (sanitised HTML), in a stable order. */
  bodies: string[];
}

/** Elements that end a block of text: their boundaries separate it from what follows. */
const BLOCK = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'div', 'section', 'article',
]);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isLetter = (c: string | undefined): boolean => !!c && /[a-z]/i.test(c);

interface Tag {
  name: string;
  closing: boolean;
  attributes: Map<string, string>;
  /** Index just past the tag's `>`; null: the markup ends inside the tag (dropped, as HTML drops it). */
  end: number | null;
}

/**
 * A tag at `start` (`<` then a letter, or `</` then a letter), scanned as the HTML tokenizer does: the tag name, then
 * attribute names and values by their states — a quoted value runs to its closing quote; an unquoted value runs to
 * whitespace or `>` (quotes, `=`, `<`, a backtick and `/` inside it are part of it); a `/` only marks self-closing
 * between attributes. So no text inside a value is ever taken for another attribute. The first of a repeated name counts.
 */
function scanTag(html: string, start: number): Tag {
  let i = start + 1;
  const closing = html[i] === '/';
  if (closing) i++;
  let name = '';
  while (i < html.length && !isSpace(html[i]!) && html[i] !== '/' && html[i] !== '>') name += html[i++]!;
  const attributes = new Map<string, string>();
  const set = (n: string, v: string) => {
    const key = n.toLowerCase();
    if (key && !attributes.has(key)) attributes.set(key, collapse(decodeEntities(v)));
  };
  for (;;) {
    // Before an attribute name.
    while (i < html.length && (isSpace(html[i]!) || html[i] === '/')) i++;
    if (i >= html.length) return { name: name.toLowerCase(), closing, attributes, end: null };
    if (html[i] === '>') return { name: name.toLowerCase(), closing, attributes, end: i + 1 };
    // The attribute name (a leading `=` belongs to it).
    let attr = html[i++]!;
    while (i < html.length && !isSpace(html[i]!) && html[i] !== '/' && html[i] !== '>' && html[i] !== '=') attr += html[i++]!;
    // After the name.
    while (i < html.length && isSpace(html[i]!)) i++;
    if (html[i] !== '=') {
      set(attr, '');
      continue;
    }
    i++;
    while (i < html.length && isSpace(html[i]!)) i++;
    const q = html[i];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, i + 1);
      if (close < 0) return { name: name.toLowerCase(), closing, attributes, end: null };
      set(attr, html.slice(i + 1, close));
      i = close + 1;
    } else {
      let value = '';
      while (i < html.length && !isSpace(html[i]!) && html[i] !== '>') value += html[i++]!;
      set(attr, value);
    }
  }
}

/** One piece of a block: its text, a link target, an image (source and alternative text). */
export type ContentToken = ['text', string] | ['link', string] | ['image', string, string];

/**
 * An HTML body as blocks of typed tokens (text, link targets, images): structure, never markers inside the text, so
 * no text can stand for a link or an image. Tags and their attributes are scanned as the HTML tokenizer reads them
 * (`scanTag`); markup that ends inside a tag is dropped.
 */
export function normalizedBody(html: string): ContentToken[][] {
  const blocks: ContentToken[][] = [];
  let block: ContentToken[] = [];
  let text = '';
  const flushText = () => {
    const t = collapse(text);
    if (t) block.push(['text', t]);
    text = '';
  };
  const end = () => {
    flushText();
    if (block.length) blocks.push(block);
    block = [];
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text += decodeEntities(html.slice(i));
      break;
    }
    text += decodeEntities(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      // A comment; `<!-->` and `<!--->` close at once (the tokenizer's abrupt closing of an empty comment).
      const body = lt + 4;
      if (html[body] === '>') i = body + 1;
      else if (html.startsWith('->', body)) i = body + 2;
      else {
        const close = html.indexOf('-->', body);
        i = close < 0 ? html.length : close + 3;
      }
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      // A declaration or a bogus comment: to the next `>`.
      const close = html.indexOf('>', lt);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    if (!(isLetter(html[lt + 1]) || (html[lt + 1] === '/' && isLetter(html[lt + 2])))) {
      // Not a tag: a literal `<`.
      text += '<';
      i = lt + 1;
      continue;
    }
    const tag = scanTag(html, lt);
    if (tag.end === null) break;
    i = tag.end;
    if (BLOCK.has(tag.name)) end();
    if (tag.closing) continue;
    if (tag.name === 'a') {
      const href = tag.attributes.get('href') ?? '';
      if (href) {
        flushText();
        block.push(['link', href]);
      }
    } else if (tag.name === 'img') {
      flushText();
      block.push(['image', tag.attributes.get('src') ?? '', tag.attributes.get('alt') ?? '']);
    }
  }
  end();
  return blocks;
}

/** The text the modification time follows: equal for contents that read the same, different when a word, an address or the order changes. */
export function normalizedContent(parts: ContentParts): string {
  return JSON.stringify({
    // Plain text (escaped on output): only its whitespace is normalised.
    title: collapse(parts.title),
    excerpt: collapse(parts.excerpt),
    bodies: parts.bodies.map(normalizedBody),
  });
}
