import { Marked } from 'marked';

/**
 * Markdown and MDX bodies to rich-text blocks (HeoPress P12 task 7.2; spec migration/astro-content-import
 * "MDX 与媒体转换").
 *
 * Markdown becomes HTML whose top-level elements are the blocks (`block-ids.ts`). MDX adds three things:
 *   - `import` / `export` lines: imports name the components and images used below; nothing else of them is kept;
 *   - components (`<Callout>…</Callout>`, `<Image src={hero} />`): a component the mapping knows becomes that block;
 *     `Image` / `Picture` become a figure; any other one is kept as a **custom-component block**
 *     (`<div data-block-type="custom-component" data-component="…" data-props="…">children</div>`) and reported
 *     with its line — never dropped;
 *   - `{expressions}`: kept as text and reported.
 * Images (Markdown, `<img>`, `Image`) go through `resolveImage`, which puts local files into the media manifest and
 * answers the reference to write instead.
 */

interface ComponentMapping {
  /** The element the component becomes; its children are converted inside it. */
  as: 'blockquote' | 'section' | 'div' | 'figure' | 'p';
}

export interface MdxOptions {
  /** `.mdx` (components and imports) or plain Markdown. */
  mdx: boolean;
  components?: Record<string, ComponentMapping>;
  /** A local image reference → what to write instead (`heopress-media:<id>`), or null (left as is, noted). */
  resolveImage: (src: string) => string | null;
  /** Imports seen so far (an enclosing body's, for a component's children). */
  imports?: Map<string, string>;
}

export interface MdxResult {
  html: string;
  notes: string[];
  unknownComponents: Array<{ component: string; line: number }>;
}

const TOKEN = (n: number) => `HEOPRESSBLOCK${n}X`;
const INLINE_TOKEN = (n: number) => `HEOPRESSINLINE${n}X`;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type PropValue = string | boolean | { $expr: string };

/** Attributes of a JSX opening tag's inside (`src={hero} alt="x" wide`). */
export function parseJsxAttributes(src: string): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    const m = /^[A-Za-z_:][\w:.-]*/.exec(src.slice(i));
    if (!m) {
      i++;
      continue;
    }
    const name = m[0];
    i += name.length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== '=') {
      out[name] = true;
      continue;
    }
    i++;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    const q = src[i];
    if (q === '"' || q === "'") {
      const end = src.indexOf(q, i + 1);
      out[name] = src.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? src.length : end + 1;
    } else if (q === '{') {
      let depth = 0;
      let j = i;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) break;
      }
      out[name] = { $expr: src.slice(i + 1, j).trim() };
      i = j + 1;
    }
  }
  return out;
}

/** The end of a JSX opening tag starting at `start` (the index of `>`), skipping quoted and braced parts. */
function openTagEnd(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
}

interface JsxBlock {
  name: string;
  attrs: Record<string, PropValue>;
  children: string | null;
  /** Index just past the block. */
  end: number;
  source: string;
}

/** A component starting at `start` (at `<Name`), up to its matching close (nested same-name tags counted). */
function readComponent(text: string, start: number): JsxBlock | null {
  const m = /^<([A-Z][\w.]*)/.exec(text.slice(start));
  if (!m) return null;
  const name = m[1]!;
  const gt = openTagEnd(text, start + m[0].length);
  if (gt === -1) return null;
  const inside = text.slice(start + m[0].length, gt);
  const selfClosing = inside.trimEnd().endsWith('/');
  const attrs = parseJsxAttributes(selfClosing ? inside.trimEnd().slice(0, -1) : inside);
  if (selfClosing) return { name, attrs, children: null, end: gt + 1, source: text.slice(start, gt + 1) };
  const open = new RegExp(`<${name.replace('.', '\\.')}(?=[\\s/>])`, 'g');
  const close = new RegExp(`</${name.replace('.', '\\.')}\\s*>`, 'g');
  let depth = 1;
  let i = gt + 1;
  while (depth > 0) {
    open.lastIndex = i;
    close.lastIndex = i;
    const o = open.exec(text);
    const c = close.exec(text);
    if (!c) return null;
    if (o && o.index < c.index) {
      const oe = openTagEnd(text, o.index + o[0].length);
      const selfC = oe !== -1 && text.slice(o.index, oe).trimEnd().endsWith('/');
      if (!selfC) depth++;
      i = oe === -1 ? o.index + 1 : oe + 1;
    } else {
      depth--;
      i = c.index + c[0].length;
      if (depth === 0) return { name, attrs, children: text.slice(gt + 1, c.index), end: i, source: text.slice(start, i) };
    }
  }
  return null;
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** Convert one body. `lineOffset`: lines before the body in the file (frontmatter), for the reported lines. */
export function convertBody(body: string, opts: MdxOptions, lineOffset = 0): MdxResult {
  const notes: string[] = [];
  const unknownComponents: MdxResult['unknownComponents'] = [];
  const blocks: string[] = [];
  const inlines: string[] = [];
  const imports = opts.imports ?? new Map<string, string>();
  const marked = new Marked({ gfm: true, async: false });
  const md = (s: string) => marked.parse(s) as string;

  const renderComponent = (b: JsxBlock, line: number): string => {
    const childHtml = b.children !== null ? convertBody(b.children, { ...opts, imports }, line - 1) : null;
    if (childHtml) {
      notes.push(...childHtml.notes);
      unknownComponents.push(...childHtml.unknownComponents);
    }
    if (b.name === 'Image' || b.name === 'Picture') {
      const raw = b.attrs.src;
      const src = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? imports.get(raw.$expr) ?? null : null;
      const alt = typeof b.attrs.alt === 'string' ? b.attrs.alt : '';
      const ref = src ? opts.resolveImage(src) : null;
      if (!ref) {
        notes.push(`<${b.name}> at line ${line}: image ${src ?? '(expression)'} could not be resolved; kept as a custom component.`);
      } else {
        return `<figure><img src="${escapeHtml(ref)}" alt="${escapeHtml(alt)}"></figure>`;
      }
    }
    const mapped = opts.components?.[b.name];
    if (mapped) return `<${mapped.as}>${childHtml?.html ?? ''}</${mapped.as}>`;
    unknownComponents.push({ component: b.name, line });
    notes.push(`Unknown component <${b.name}> at line ${line}: kept as a custom-component block.`);
    return `<div data-block-type="custom-component" data-component="${escapeHtml(b.name)}" data-props="${escapeHtml(JSON.stringify(b.attrs))}">${childHtml?.html ?? ''}</div>`;
  };

  // Pass 1 (MDX): imports, exports, block components and inline components become tokens.
  let text = body;
  if (opts.mdx) {
    const out: string[] = [];
    let i = 0;
    let inFence = false;
    while (i < text.length) {
      const nl = text.indexOf('\n', i);
      const lineEnd = nl === -1 ? text.length : nl;
      const line = text.slice(i, lineEnd);
      const lineNo = lineAt(text, i) + lineOffset;
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence || /^\s*(```|~~~)/.test(line)) {
        out.push(line);
        i = lineEnd + 1;
        continue;
      }
      const imp = /^import\s+(.+?)\s+from\s+['"]([^'"]+)['"];?\s*$/.exec(line);
      if (imp) {
        const what = imp[1]!;
        const def = /^([A-Za-z_$][\w$]*)/.exec(what);
        if (def) imports.set(def[1]!, imp[2]!);
        i = lineEnd + 1;
        continue;
      }
      if (/^export\s/.test(line)) {
        notes.push(`export at line ${lineNo} dropped.`);
        i = lineEnd + 1;
        continue;
      }
      const lead = /^(\s*)<[A-Z]/.exec(line);
      if (lead) {
        const b = readComponent(text, i + lead[1]!.length);
        if (b) {
          blocks.push(renderComponent(b, lineNo));
          out.push('', TOKEN(blocks.length - 1), '');
          // Whatever follows the component on its last line stays.
          const restEnd = text.indexOf('\n', b.end);
          const rest = text.slice(b.end, restEnd === -1 ? text.length : restEnd);
          if (rest.trim()) out.push(rest);
          i = restEnd === -1 ? text.length : restEnd + 1;
          continue;
        }
      }
      // Inline components inside a line of text.
      let l = line;
      for (;;) {
        const at = l.search(/<[A-Z][\w.]*(?=[\s/>])/);
        if (at === -1) break;
        const b = readComponent(l, at);
        if (!b) break;
        const html = renderComponent(b, lineNo);
        inlines.push(html.startsWith('<div') ? html.replace(/^<div/, '<span').replace(/<\/div>$/, '</span>') : html);
        l = `${l.slice(0, at)}${INLINE_TOKEN(inlines.length - 1)}${l.slice(b.end)}`;
      }
      if (/\{[^}]*\}/.test(l.replace(/`[^`]*`/g, ''))) notes.push(`Expression at line ${lineNo} kept as text.`);
      out.push(l);
      i = lineEnd + 1;
    }
    text = out.join('\n');
  }

  // Rich text starts at h2 (the page title is the h1): a Markdown `#` heading becomes an h2.
  let html = md(text).replace(/<(\/?)h1(\b[^>]*)>/g, '<$1h2$2>');
  html = html.replace(new RegExp(`<p>\\s*${TOKEN(0).replace('0', '(\\d+)')}\\s*</p>`, 'g'), (_m, n: string) => blocks[Number(n)] ?? '');
  html = html.replace(new RegExp(TOKEN(0).replace('0', '(\\d+)'), 'g'), (_m, n: string) => blocks[Number(n)] ?? '');
  html = html.replace(new RegExp(INLINE_TOKEN(0).replace('0', '(\\d+)'), 'g'), (_m, n: string) => inlines[Number(n)] ?? '');
  // Images in Markdown and HTML.
  html = html.replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/g, (whole, a: string, src: string, b: string) => {
    if (src.startsWith('heopress-media:') || src.startsWith('heopress-local:') || /^(https?:)?\/\//i.test(src) || src.startsWith('data:')) return whole;
    const ref = opts.resolveImage(src.replace(/&amp;/g, '&'));
    if (!ref) {
      notes.push(`Image ${src} could not be found; left as is.`);
      return whole;
    }
    return `${a}${escapeHtml(ref)}${b}`;
  });
  return { html: html.trim(), notes: [...new Set(notes)], unknownComponents };
}
