/**
 * A WordPress eXtended RSS (WXR) parser (v1.1 WordPress import; spec migration/wordpress-import "安全解析").
 *
 * WXR is RSS 2.0 with the WordPress, content and Dublin Core namespaces. A general XML library would bring external
 * entities, entity expansion and large-document behaviour with it; the import only needs elements, attributes, text
 * and CDATA. This parser is that subset, and it refuses what it does not support:
 *
 *   - `<!DOCTYPE` or `<!ENTITY` anywhere is an error (no external or internal entities, no XXE);
 *   - a byte limit (64 MiB by default) and an element-depth limit (256);
 *   - only the five predefined entities and numeric character references are decoded;
 *   - it reads the bytes it is given and nothing else — no network, no files.
 */

export class WxrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WxrError';
  }
}

export interface WxrNode {
  /** The element's name as written, namespace prefix included (`wp:post_id`). */
  name: string;
  attrs: Record<string, string>;
  children: WxrNode[];
  text: string;
}

export interface WxrPostMeta {
  key: string;
  value: string;
}

interface WxrTerm {
  domain: string;
  nicename: string;
  name: string;
}

export interface WxrItem {
  title: string;
  link: string;
  pubDate?: string;
  creator?: string;
  guid?: string;
  content?: string;
  excerpt?: string;
  postId: string;
  postDate?: string;
  postDateGmt?: string;
  postModified?: string;
  postModifiedGmt?: string;
  postName?: string;
  status?: string;
  postType?: string;
  terms: WxrTerm[];
  meta: WxrPostMeta[];
  attachmentUrl?: string;
  attachedFile?: string;
}

export interface WxrDocument {
  title?: string;
  link?: string;
  description?: string;
  language?: string;
  baseSiteUrl?: string;
  baseBlogUrl?: string;
  authors: Array<{ login: string; displayName: string; email?: string }>;
  categories: Array<{ nicename: string; name: string; parent?: string }>;
  tags: Array<{ nicename: string; name: string }>;
  items: WxrItem[];
}

export interface ParseWxrOptions {
  /** The input's byte limit (default 64 MiB). */
  maxBytes?: number;
  /** The element-depth limit (default 256). */
  maxDepth?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 256;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** The local name of an element or attribute (`wp:post_id` → `post_id`). */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** The first child with the local name, or undefined. */
export function child(node: WxrNode, name: string): WxrNode | undefined {
  return node.children.find((c) => localName(c.name) === name);
}

/** The text of the first child with the local name, trimmed, or undefined when absent or empty. */
function childText(node: WxrNode, name: string): string | undefined {
  const found = child(node, name);
  const text = found?.text.trim();
  return text ? text : undefined;
}

/** The first child whose full name matches (`content:encoded`, `excerpt:encoded`). */
export function childNamed(node: WxrNode, name: string): WxrNode | undefined {
  return node.children.find((c) => c.name === name);
}

/** Every child with the local name. */
export function children(node: WxrNode, name: string): WxrNode[] {
  return node.children.filter((c) => localName(c.name) === name);
}

interface Token {
  kind: 'open' | 'close' | 'self' | 'text' | 'cdata';
  name?: string;
  attrs?: Record<string, string>;
  text?: string;
}

const NAME = /^[A-Za-z_][\w.:-]*/;
const ATTR = /\s+([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const length = input.length;
  while (i < length) {
    const lt = input.indexOf('<', i);
    if (lt < 0) {
      tokens.push({ kind: 'text', text: decodeEntities(input.slice(i)) });
      break;
    }
    if (lt > i) tokens.push({ kind: 'text', text: decodeEntities(input.slice(i, lt)) });
    i = lt;
    if (input.startsWith('<![CDATA[', i)) {
      const end = input.indexOf(']]>', i + 9);
      if (end < 0) throw new WxrError('unterminated CDATA section');
      tokens.push({ kind: 'cdata', text: input.slice(i + 9, end) });
      i = end + 3;
      continue;
    }
    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      if (end < 0) throw new WxrError('unterminated comment');
      i = end + 3;
      continue;
    }
    if (input.startsWith('<?', i)) {
      const end = input.indexOf('?>', i + 2);
      if (end < 0) throw new WxrError('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (input.startsWith('</', i)) {
      const end = input.indexOf('>', i);
      if (end < 0) throw new WxrError('unterminated closing tag');
      const name = input.slice(i + 2, end).trim();
      if (!NAME.test(name)) throw new WxrError(`invalid closing tag </${name}>`);
      tokens.push({ kind: 'close', name });
      i = end + 1;
      continue;
    }
    // An opening or self-closing tag.
    const nameMatch = NAME.exec(input.slice(i + 1, i + 1 + 256));
    if (!nameMatch) throw new WxrError(`invalid tag at offset ${i}`);
    const name = nameMatch[0];
    let cursor = i + 1 + name.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      ATTR.lastIndex = cursor;
      const m = ATTR.exec(input);
      if (!m) break;
      const value = m[3] ?? m[4] ?? '';
      attrs[m[1]!] = decodeEntities(value);
      cursor = ATTR.lastIndex;
    }
    while (cursor < length && /\s/.test(input[cursor]!)) cursor += 1;
    if (input[cursor] === '/') {
      if (input[cursor + 1] !== '>') throw new WxrError(`malformed self-closing tag <${name}>`);
      tokens.push({ kind: 'self', name, attrs });
      i = cursor + 2;
      continue;
    }
    if (input[cursor] !== '>') throw new WxrError(`malformed tag <${name}>`);
    tokens.push({ kind: 'open', name, attrs });
    i = cursor + 1;
  }
  return tokens;
}

/** Parse a WXR document into a tree of the elements the import uses. */
export function parseWxr(input: string | Uint8Array, options: ParseWxrOptions = {}): WxrDocument {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > maxBytes) throw new WxrError(`the WXR file is ${bytes.byteLength} bytes; the limit is ${maxBytes}`);
  const text = (typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: false }).decode(bytes)).replace(/^\uFEFF/, '');
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) throw new WxrError('DOCTYPE and ENTITY declarations are not supported (external entities are refused)');

  const tokens = tokenize(text);
  const root: WxrNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: WxrNode[] = [root];
  for (const token of tokens) {
    const top = stack[stack.length - 1]!;
    if (token.kind === 'text' || token.kind === 'cdata') {
      top.text += token.text ?? '';
      continue;
    }
    if (token.kind === 'open') {
      if (stack.length > maxDepth) throw new WxrError(`the WXR file nests deeper than ${maxDepth} elements`);
      const node: WxrNode = { name: token.name!, attrs: token.attrs ?? {}, children: [], text: '' };
      top.children.push(node);
      stack.push(node);
      continue;
    }
    if (token.kind === 'self') {
      top.children.push({ name: token.name!, attrs: token.attrs ?? {}, children: [], text: '' });
      continue;
    }
    // close
    if (top.name !== token.name) throw new WxrError(`</${token.name}> does not close <${top.name}>`);
    stack.pop();
  }
  if (stack.length !== 1) throw new WxrError(`unclosed element <${stack[stack.length - 1]!.name}>`);

  const rss = child(root, 'rss') ?? child(child(root, 'channel') ?? root, 'rss');
  const channel = rss ? child(rss, 'channel') : child(root, 'channel');
  if (!channel) throw new WxrError('not a WXR document: no <channel>');
  const wp = (name: string) => child(channel, name);

  const authors = children(channel, 'author').map((a) => ({
    login: childText(a, 'author_login') ?? '',
    displayName: childText(a, 'author_display_name') ?? '',
    email: childText(a, 'author_email'),
  }));
  const categories = children(channel, 'category').map((c) => ({
    nicename: childText(c, 'category_nicename') ?? '',
    name: childText(c, 'cat_name') ?? '',
    parent: childText(c, 'category_parent'),
  }));
  const tags = children(channel, 'tag').map((t) => ({
    nicename: childText(t, 'tag_slug') ?? '',
    name: childText(t, 'tag_name') ?? '',
  }));

  const items: WxrItem[] = children(channel, 'item').map((item) => {
    const terms: WxrTerm[] = children(item, 'category').map((c) => ({
      domain: c.attrs['domain'] ?? '',
      nicename: c.attrs['nicename'] ?? '',
      name: c.text.trim(),
    }));
    const meta: WxrPostMeta[] = children(item, 'postmeta').map((m) => ({
      key: childText(m, 'meta_key') ?? '',
      value: childText(m, 'meta_value') ?? '',
    }));
    const postId = childText(item, 'post_id') ?? childText(item, 'post_ID') ?? '';
    return {
      title: childText(item, 'title') ?? '',
      link: childText(item, 'link') ?? '',
      pubDate: childText(item, 'pubDate'),
      creator: childText(item, 'creator'),
      guid: childText(item, 'guid'),
      content: childNamed(item, 'content:encoded')?.text ?? child(item, 'encoded')?.text,
      excerpt: childNamed(item, 'excerpt:encoded')?.text,
      postId,
      postDate: childText(item, 'post_date'),
      postDateGmt: childText(item, 'post_date_gmt'),
      postModified: childText(item, 'post_modified'),
      postModifiedGmt: childText(item, 'post_modified_gmt'),
      postName: childText(item, 'post_name'),
      status: childText(item, 'status'),
      postType: childText(item, 'post_type'),
      terms,
      meta,
      attachmentUrl: childText(item, 'attachment_url'),
      attachedFile: meta.find((m) => m.key === '_wp_attached_file')?.value,
    };
  });

  return {
    title: childText(channel, 'title'),
    link: childText(channel, 'link'),
    description: childText(channel, 'description'),
    language: childText(channel, 'language'),
    baseSiteUrl: wp('base_site_url')?.text.trim() || undefined,
    baseBlogUrl: wp('base_blog_url')?.text.trim() || undefined,
    authors,
    categories,
    tags,
    items,
  };
}
