import { TokenKind, Tokenizer, type TagToken, type TopLevelToken } from 'liquidjs';
import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { THEME_PAGE_TYPES, THEME_ROOTS, THEME_VIEW_MODEL_SCHEMA } from '@heopress/contracts/theme';
import { ALLOWED_FILTERS, ALLOWED_TAGS, SYSTEM_TAGS, createThemeEngine, forbiddenPath, TEMPLATE_NAME, type ThemeAsset } from './engine.ts';

/**
 * Static checks of a theme version before publication (HeoPress P06 tasks 2.2, 2.4, 7.1; design R15, R27,
 * R36; spec "读取契约外数据", "缺少 SEO 插槽", "引入其他主题的模板"). On the composed source of each page
 * template (partials inlined, string-literal names only, depth 8, no cycles), every Liquid output and tag is
 * replaced by a marker and the result parsed as HTML; a marker's place decides:
 *
 *   - outputs: text is fine; an attribute value only when quoted, never `on*`, `style` or `srcdoc`, and a
 *     URL attribute's output must end with the `url` filter; never in a tag or attribute name, a comment,
 *     or the raw text of `<script>`, `<style>`, `<noscript>`, `<iframe>`, `<xmp>`;
 *   - tags (control flow, assign, system tags…): text only; and every branch of a control structure is
 *     context-neutral — all its markers are text in the same parent element (no half tags, no element
 *     opened in one branch and closed in another, no branch inside a script);
 *   - only allow-listed tags and filters; variables only from the View Model (`site.name`, not `site.secret`);
 *   - every page template outputs `{% seo_head %}`; the item template `{% item_body %}`.
 *
 * Not executed: every branch is checked, taken or not.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export interface ThemeIssue {
  template: string;
  message: string;
}

const MAX_DEPTH = 8;
/** Composition limits: an acyclic chain of partials can still multiply (each including the next many times). */
const MAX_COMPOSED_CHARS = 1_000_000;
const MAX_INLINES = 500;
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const ANIMATION_ELEMENTS = new Set(['animate', 'set', 'animatemotion', 'animatetransform', 'animatecolor', 'discard']);
/** Elements whose content is text up to their end tag: a control structure there could close them. */
const RCDATA = new Set(['title', 'textarea']);
const RAW_TEXT = new Set(['script', 'style', 'noscript', 'iframe', 'xmp', 'noembed', 'noframes', 'plaintext']);
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'cite', 'data', 'background', 'ping', 'manifest', 'xlink:href', 'longdesc', 'codebase']);
const BLOCKS: Record<string, { branches: string[]; end: string }> = {
  if: { branches: ['elsif', 'else'], end: 'endif' },
  unless: { branches: ['elsif', 'else'], end: 'endunless' },
  case: { branches: ['when', 'else'], end: 'endcase' },
  for: { branches: ['else'], end: 'endfor' },
  capture: { branches: [], end: 'endcapture' },
  card: { branches: [], end: 'endcard' },
};
const STRUCTURAL = new Set(['elsif', 'else', 'when', 'endif', 'endunless', 'endcase', 'endfor', 'endcapture', 'endcard', 'endcomment']);
const REQUIRED_TEMPLATES = [...THEME_PAGE_TYPES];

const isTag = (t: TopLevelToken): t is TagToken => t.kind === TokenKind.Tag;
const isOutput = (t: TopLevelToken) => t.kind === TokenKind.Output;

/** The filter names of an expression `x | f: a | g` (pipes inside quotes ignored). */
export function filterNames(expression: string): string[] {
  const names: string[] = [];
  let quote: string | null = null;
  let segmentStart = -1;
  for (let i = 0; i <= expression.length; i++) {
    const c = expression[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '|' || c === undefined) {
      if (segmentStart >= 0) {
        const m = /^\s*([\w-]+)/.exec(expression.slice(segmentStart, i));
        names.push(m ? m[1]! : '');
      }
      segmentStart = c === '|' ? i + 1 : -1;
    }
  }
  return names;
}

function tokenize(source: string, name: string): TopLevelToken[] {
  return new Tokenizer(source, undefined, `${name}.liquid`).readTopLevelTokens();
}

/** The partial named by an include / render tag, when it is a string literal. */
function partialName(tag: TagToken): string | null {
  const m = /^\s*(['"])([^'"]+)\1/.exec(tag.args);
  return m ? m[2]! : null;
}

/** Names bound by `render 'x', a: b, c: d` / `include 'x', a: b` / `with x as y`, as assignments to keep the composed source meaningful. */
function bindings(tag: TagToken): string {
  const rest = tag.args.replace(/^\s*(['"])[^'"]+\1\s*/, '');
  const out: string[] = [];
  for (const m of rest.matchAll(/([A-Za-z_][\w-]*)\s*:\s*((?:'[^']*'|"[^"]*"|[^,'"])+)/g)) out.push(`{% assign ${m[1]} = ${m[2]!.trim()} %}`);
  const as = /(with|for)\s+([^\s,]+)\s+as\s+([A-Za-z_][\w-]*)/.exec(rest);
  // `for list as c`: c is one element (`| first` keeps that meaning for the path checks).
  if (as) out.push(as[1] === 'for' ? `{% assign ${as[3]} = ${as[2]} | first %}` : `{% assign ${as[3]} = ${as[2]} %}`);
  return out.join('');
}

interface Composed {
  source: string;
  issues: string[];
}

/** Inlining budget of one page template. */
interface Budget {
  inlines: number;
  chars: number;
}

/**
 * The template with its partials inlined (literal names only, existing, depth ≤ 8, no cycle, bounded
 * expansion). Where the include tags themselves sit is checked per template (`checkIncludePlacement`).
 */
function compose(templates: Record<string, string>, name: string, stack: string[] = [], budget: Budget = { inlines: 0, chars: 0 }): Composed {
  const issues: string[] = [];
  if (stack.includes(name)) return { source: '', issues: [`partial cycle: ${[...stack, name].join(' → ')}`] };
  if (stack.length > MAX_DEPTH) return { source: '', issues: [`partials nested deeper than ${MAX_DEPTH}`] };
  const source = templates[name]!;
  let tokens: TopLevelToken[];
  try {
    tokens = tokenize(source, name);
  } catch (err) {
    return { source: '', issues: [`syntax: ${(err as Error).message}`] };
  }
  let out = '';
  let last = 0;
  for (const t of tokens) {
    if (!isTag(t) || (t.name !== 'include' && t.name !== 'render')) continue;
    const partial = partialName(t);
    if (!partial) {
      issues.push(`{% ${t.name} %} needs a string literal template name: ${t.getText()}`);
      continue;
    }
    if (!(partial in templates)) {
      issues.push(`{% ${t.name} '${partial}' %}: no such template in this theme version`);
      continue;
    }
    if (++budget.inlines > MAX_INLINES) return { source: '', issues: [`more than ${MAX_INLINES} partial inclusions`] };
    const inner = compose(templates, partial, [...stack, name], budget);
    issues.push(...inner.issues);
    if (inner.issues.length) return { source: '', issues };
    // The tag's whitespace control stays where it was (Codex review of batch 5b-1): an empty comment carrying each trim,
    // so the composed page trims the whitespace beside the partial as rendering does.
    const trimBefore = t.trimLeft ? '{%- comment %}{% endcomment %}' : '';
    const trimAfter = t.trimRight ? '{% comment %}{% endcomment -%}' : '';
    out += source.slice(last, t.begin) + trimBefore + bindings(t) + inner.source + trimAfter;
    last = t.end;
    budget.chars += inner.source.length;
    if (budget.chars > MAX_COMPOSED_CHARS) return { source: '', issues: [`partials expand to more than ${MAX_COMPOSED_CHARS} characters`] };
  }
  return { source: out + source.slice(last), issues };
}

interface SchemaNode {
  type?: string | readonly string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  oneOf?: readonly SchemaNode[];
}

const ROOT_SCHEMA = THEME_VIEW_MODEL_SCHEMA as unknown as SchemaNode;
const FORLOOP = new Set(['index', 'index0', 'rindex', 'rindex0', 'first', 'last', 'length', 'name']);

/** Whether `segments` (after the root) is a path of `node`: properties, array items (`0`, `first`, `last`), `size`. */
function pathOk(node: SchemaNode | undefined, segments: string[]): boolean {
  let n = node;
  for (let i = 0; i < segments.length; i++) {
    if (!n) return false;
    if (n.oneOf) n = n.oneOf.find((o) => o.properties || o.items || o.type === 'object') ?? n.oneOf[0];
    const s = segments[i]!;
    if (s === '*') {
      // An array of the values reached so far (made by `map`).
      n = { items: n };
      continue;
    }
    if (s === 'size') return i === segments.length - 1;
    if (n!.items) {
      if (/^-?\d+$/.test(s) || s === 'first' || s === 'last' || s === '[]') {
        n = n!.items;
        continue;
      }
      return false;
    }
    if (n!.properties) {
      if (!Object.prototype.hasOwnProperty.call(n!.properties, s)) return false;
      n = n!.properties[s];
      continue;
    }
    // A free object (item.fields): any key below it.
    return n!.type === 'object';
  }
  return true;
}

/** Filters that keep a value's shape (an array stays an array of the same elements); `default` adds its fallback's. */
const SAME_SHAPE = new Set(['default', 'sort', 'sort_natural', 'reverse', 'uniq', 'where', 'reject', 'compact', 'slice', 'concat']);
/** Filters that take one element of an array. */
const ELEMENT = new Set(['first', 'last', 'find']);
/** Filters whose first argument names a property of each element. */
const PROPERTY_ARG = new Set(['map', 'where', 'reject', 'sort', 'sort_natural', 'sum', 'uniq', 'group_by', 'find', 'find_index', 'has']);

const PATH = /^([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*|\[\d+\])*)$/;
const splitPath = (p: string) => p.replace(/\[(\d+)\]/g, '.$1').split('.');

interface FilterCall {
  name: string;
  /** The first argument when it is a string literal. */
  literal: string | null;
  /** The first argument as written. */
  raw: string | null;
}

/** Split at a separator outside quotes. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === sep || c === undefined) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return parts;
}

/** `base | f: 'a', b | g` → the base and each filter with its first argument. */
function parseExpression(expr: string): { base: string; filters: FilterCall[] } {
  const [base = '', ...rest] = splitTop(expr, '|');
  return {
    base: base.trim(),
    filters: rest.map((f) => {
      const m = /^\s*([\w-]+)\s*(?::([\s\S]*))?$/.exec(f);
      const raw = m?.[2] !== undefined ? (splitTop(m[2], ',')[0] ?? '').trim() : null;
      const lit = raw ? /^(['"])([\s\S]*)\1$/.exec(raw) : null;
      return { name: m?.[1] ?? '', literal: lit ? lit[2]! : null, raw };
    }),
  };
}

/**
 * Shapes are View Model paths: `[]` stands for "an element of" (`list.[]`), a trailing `*` for "an array
 * of these" (what `map` makes). The element path of a shape:
 */
const elementOf = (shape: string[]) => (shape[shape.length - 1] === '*' ? shape.slice(0, -1) : [...shape, '[]']);

/**
 * Every shape an expression's value may have, following its filters (calling `onProperty` for each
 * property a filter reads of each element); empty when it is not a View Model value (a literal, a
 * scalar result).
 */
function shapesOf(expr: string, onProperty?: (path: string[], label: string) => void, depth = 0): string[][] {
  const { base, filters } = parseExpression(expr);
  let shapes: string[][] = PATH.test(base) ? [splitPath(base)] : [];
  // No early exit: a later `default:` can bring a View Model value even after a literal or a scalar filter.
  for (const f of filters) {
    if (PROPERTY_ARG.has(f.name) && f.literal && onProperty) {
      for (const sh of shapes) onProperty([...elementOf(sh), ...f.literal.split('.')], `${base} | ${f.name}: '${f.literal}'`);
    }
    if (f.name === 'default' && f.raw && depth < 4) shapes = [...shapes, ...shapesOf(f.raw, onProperty, depth + 1)];
    else if (f.name === 'map' && f.literal) shapes = shapes.map((sh) => [...elementOf(sh), ...f.literal!.split('.'), '*']);
    else if (ELEMENT.has(f.name)) shapes = shapes.map(elementOf);
    else if (!SAME_SHAPE.has(f.name)) shapes = [];
  }
  return shapes;
}

/**
 * Local names bound to View Model paths: `for c in list` → an element of list, `assign t = item.sponsor |
 * default: item.fields` → both, include parameters (as assignments). Flow-insensitive: a name bound
 * several times must be valid under every binding.
 */
function aliasesOf(composed: string): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  const add = (name: string, shapes: string[][]) => {
    if (shapes.length) out.set(name, [...(out.get(name) ?? []), ...shapes]);
  };
  let tokens: TopLevelToken[] = [];
  try {
    tokens = tokenize(composed, 'composed');
  } catch {
    return out;
  }
  for (const t of tokens) {
    if (!isTag(t)) continue;
    if (t.name === 'for') {
      const m = /^\s*([A-Za-z_][\w-]*)\s+in\s+(.+?)(\s+(limit|offset|reversed)\b.*)?$/.exec(t.args);
      if (m) add(m[1]!, shapesOf(m[2]!).map(elementOf));
    } else if (t.name === 'assign') {
      const m = /^\s*([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(t.args);
      if (m) add(m[1]!, shapesOf(m[2]!));
    }
  }
  return out;
}

/** Every View Model path the page reads, checked whole against the contract (R19 spec "读取契约外数据"). */
function checkPaths(engine: ReturnType<typeof createThemeEngine>, page: string, composed: string): string[] {
  const issues: string[] = [];
  const aliases = aliasesOf(composed);
  /** Expand an alias root to View Model paths (null: a local that is not a View Model path — a counter, a capture, a literal). */
  const expand = (segments: string[], depth = 0): string[][] | null => {
    const [root, ...rest] = segments;
    if ((THEME_ROOTS as readonly string[]).includes(root!)) return [segments];
    const bound = aliases.get(root!);
    if (!bound || depth > 10) return null;
    const out: string[][] = [];
    for (const b of bound) {
      const e = expand([...b, ...rest], depth + 1);
      if (e) out.push(...e);
    }
    return out.length ? out : null;
  };
  const check = (label: string, segments: string[]) => {
    if (segments[0] === 'forloop') {
      if (segments.length > 1 && !FORLOOP.has(segments[1]!)) issues.push(`variable "${label}" is not in the page data contract`);
      return;
    }
    const paths = expand(segments);
    if (paths === null) return;
    // Every binding the name may have (flow-insensitive): each must allow the path.
    if (!paths.every((p) => pathOk(ROOT_SCHEMA.properties![p[0]!], p.slice(1)))) issues.push(`variable "${label}" is not in the page data contract`);
  };
  try {
    const analysis = engine.analyzeSync(engine.parseFileSync(page));
    const unknownGlobals = new Set(Object.keys(analysis.globals).filter((g) => !(THEME_ROOTS as readonly string[]).includes(g) && g !== 'forloop'));
    for (const [name, vars] of Object.entries(analysis.variables)) {
      for (const v of vars) {
        if (unknownGlobals.has(name)) {
          issues.push(`variable "${v.toString()}" is not in the page data contract`);
          continue;
        }
        const segments = v.segments.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '?'));
        if (segments.includes('?')) continue;
        check(v.toString(), segments);
      }
    }
  } catch (err) {
    issues.push(`syntax: ${(err as Error).message}`);
  }
  // Filters that read a property of each element (`list | reverse | map: 'secret'`), in every expression.
  let tokens: TopLevelToken[] = [];
  try {
    tokens = tokenize(composed, page);
  } catch {
    // reported elsewhere
  }
  for (const t of tokens) {
    const expr = isOutput(t) ? (t as unknown as { content: string }).content : isTag(t) ? t.args.replace(/^\s*[A-Za-z_][\w-]*\s*=\s*/, '').replace(/^\s*[A-Za-z_][\w-]*\s+in\s+/, '') : '';
    if (expr.includes('|')) shapesOf(expr, (path, label) => check(label, path));
  }
  return [...new Set(issues)];
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements whose end tag HTML may imply (closed by a sibling start tag or by their parent's end tag). */
const OPTIONAL_END = new Set(['li', 'p', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'rt', 'rp', 'rb', 'rtc']);
/** SVG elements whose content is HTML again (HTML integration points). */
const SVG_INTEGRATION = new Set(['foreignobject', 'desc', 'title']);
/** MathML text integration points: HTML content, except <mglyph> and <malignmark>, which stay MathML. */
const MATHML_TEXT = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);

/** Whether a foreign element's children are HTML (HTML integration points, per the HTML parsing rules). */
function htmlInside(name: string, tag: string): boolean {
  if (SVG_INTEGRATION.has(name) || MATHML_TEXT.has(name)) return true;
  // <annotation-xml>: only with an HTML encoding. Asked of the HTML parser itself (decoding, case and
  // spacing exactly as it reads them): does a <div> inside it come out as HTML?
  if (name === 'annotation-xml') {
    const math = parseFragment(`<math>${tag.endsWith('/') ? tag.slice(0, -1) : tag}><div></div></annotation-xml></math>`).childNodes[0] as Element | undefined;
    const annotation = math?.childNodes?.[0] as Element | undefined;
    const probe = annotation?.childNodes?.[0] as Element | undefined;
    return probe?.tagName === 'div' && probe.namespaceURI === HTML_NS;
  }
  return false;
}
/** Start tags that close an open <p>. */
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const SIBLINGS: Record<string, string[]> = { li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], td: ['td', 'th'], th: ['td', 'th'], tr: ['tr'], option: ['option', 'optgroup'], optgroup: ['optgroup'], rt: ['rt', 'rp'], rp: ['rt', 'rp'] };

/**
 * Whether a branch body (Liquid already replaced by markers) is a balanced HTML fragment on its own: every
 * end tag closes an element the branch opened (end tags HTML implies are allowed), every element it opens
 * is closed in it, no comment or raw text left open. Inside SVG / MathML, `/>` closes and HTML void names
 * mean nothing. Returns what is wrong, or null.
 */
function unbalanced(body: string): string | null {
  const stack: Array<{ name: string; foreign: boolean }> = [];
  const foreign = () => stack.length > 0 && stack[stack.length - 1]!.foreign;
  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf('<', i);
    if (lt < 0) break;
    if (body.startsWith('<!--', lt)) {
      const end = body.indexOf('-->', lt + 4);
      if (end < 0) return 'opens a comment';
      i = end + 3;
      continue;
    }
    const m = /^<(\/?)([A-Za-z][\w:-]*)/.exec(body.slice(lt));
    if (!m) {
      i = lt + 1;
      continue;
    }
    // The tag's end, outside quoted attribute values.
    let j = lt + m[0].length;
    let quote: string | null = null;
    for (; j < body.length; j++) {
      const c = body[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= body.length) return `has an unfinished tag <${m[1]}${m[2]}`;
    const name = m[2]!.toLowerCase();
    const inForeign = foreign();
    if (m[1]) {
      // Close it, along with open elements whose end HTML implies.
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at < 0 || stack.slice(at + 1).some((e) => e.foreign || !OPTIONAL_END.has(e.name))) return `closes </${name}> it did not open`;
      stack.length = at;
    } else {
      if (!inForeign) {
        const top = stack[stack.length - 1];
        if (top && OPTIONAL_END.has(top.name) && ((SIBLINGS[top.name] ?? []).includes(name) || (top.name === 'p' && CLOSES_P.has(name)))) stack.pop();
      }
      // The element's own namespace: foreign inside SVG / MathML, <svg> / <math> themselves, and <mglyph> /
      // <malignmark> right inside a MathML text element.
      const parent = stack[stack.length - 1];
      const isForeign = inForeign || name === 'svg' || name === 'math' || (!!parent && MATHML_TEXT.has(parent.name) && (name === 'mglyph' || name === 'malignmark'));
      const selfClosing = isForeign && body[j - 1] === '/';
      if (!selfClosing && !(!isForeign && VOID_ELEMENTS.has(name))) {
        // `foreign` is the namespace of its children: HTML again below an integration point.
        stack.push({ name, foreign: isForeign && !htmlInside(name, body.slice(lt, j)) });
        if (!inForeign && (RAW_TEXT.has(name) || RCDATA.has(name))) {
          const close = body.toLowerCase().indexOf(`</${name}`, j + 1);
          if (close < 0) return `opens <${name}> without closing it`;
          i = close;
          continue;
        }
      }
    }
    i = j + 1;
  }
  return stack.length ? `leaves <${stack[stack.length - 1]!.name}> open` : null;
}

/** Context checks of one composed page template. */
function checkContexts(composed: string): string[] {
  const issues: string[] = [];
  let tokens: TopLevelToken[];
  try {
    tokens = tokenize(composed, 'composed');
  } catch (err) {
    return [`syntax: ${(err as Error).message}`];
  }

  // Skeleton: each output / tag becomes a marker of letters and digits (legal in names, so misplacements show).
  type Mark = { kind: 'out' | 'tag'; token: TopLevelToken; text: string; filters: string[]; start: number; end: number };
  const marks: Mark[] = [];
  let skeleton = '';
  let inComment = 0;
  for (const t of tokens) {
    if (isTag(t) && (t.name === 'comment' || t.name === 'endcomment')) {
      inComment += t.name === 'comment' ? 1 : -1;
      continue;
    }
    if (inComment > 0 || (isTag(t) && t.name === '#')) continue;
    if (t.kind === TokenKind.HTML) {
      skeleton += t.getText();
      continue;
    }
    const isOut = isOutput(t) || (isTag(t) && t.name === 'echo');
    const text = t.getText();
    const expr = isOutput(t) ? (t as unknown as { content: string }).content : isTag(t) ? t.args : '';
    const marker = `hpq${marks.length}q`;
    marks.push({ kind: isOut ? 'out' : 'tag', token: t, text, filters: filterNames(expr), start: skeleton.length, end: skeleton.length + marker.length });
    skeleton += marker;
  }

  // Tags and filters.
  for (const m of marks) {
    if (isTag(m.token)) {
      const name = m.token.name;
      if (name === 'json_ld') {
        // HeoPress P07 task 2.4: the page's structured data is the system's one graph; a theme does not add its own.
        issues.push(`{% json_ld %} is not available any more: the system writes the page's structured data (one graph); use a structured-data contribution instead (an item's structured_data field, or an extension's StructuredDataContribution): ${m.text}`);
      } else if (!ALLOWED_TAGS.has(name) && !SYSTEM_TAGS.has(name) && !STRUCTURAL.has(name)) issues.push(`tag "${name}" is not allowed: ${m.text}`);
    }
    for (const f of m.filters) if (!ALLOWED_FILTERS.has(f)) issues.push(`filter "${f}" is not allowed: ${m.text}`);
  }

  // Where each marker landed.
  const doc = parse(skeleton, { sourceCodeLocationInfo: true });
  const where = new Map<number, { text: boolean; parent: Node | null }>();
  const MARK = /hpq(\d+)q/g;

  const visit = (n: Node, parent: Node | null) => {
    const name = (n as { nodeName: string }).nodeName;
    if (name === '#text' || name === '#comment') {
      const value = (n as { data?: string; value?: string }).value ?? (n as { data?: string }).data ?? '';
      const p = parent as Element | null;
      const raw = p && 'tagName' in p && RAW_TEXT.has(p.tagName);
      for (const m of value.matchAll(MARK)) {
        const i = Number(m[1]);
        const mark = marks[i]!;
        if (name === '#comment') issues.push(`Liquid inside an HTML comment: ${mark.text}`);
        else if (raw) issues.push(`Liquid inside <${p!.tagName}>: ${mark.text}`);
        else if (mark.kind === 'tag' && p && 'tagName' in p && RCDATA.has(p.tagName)) issues.push(`Liquid tags inside <${p.tagName}>: ${mark.text}`);
        else where.set(i, { text: true, parent });
      }
    } else if (name === '#documentType') {
      const d = n as { name?: string; publicId?: string; systemId?: string };
      for (const m of `${d.name ?? ''} ${d.publicId ?? ''} ${d.systemId ?? ''}`.matchAll(MARK)) issues.push(`Liquid inside the doctype: ${marks[Number(m[1])]!.text}`);
    } else if ('tagName' in n) {
      const el = n as Element;
      if (ANIMATION_ELEMENTS.has(el.tagName.toLowerCase())) issues.push(`<${el.tagName}> is not allowed`);
      for (const m of el.tagName.matchAll(MARK)) issues.push(`Liquid in a tag name: ${marks[Number(m[1])]!.text}`);
      for (const a of el.attrs) {
        for (const m of a.name.matchAll(MARK)) issues.push(`Liquid in an attribute name: ${marks[Number(m[1])]!.text}`);
        for (const m of a.value.matchAll(MARK)) {
          const i = Number(m[1]);
          const mark = marks[i]!;
          where.set(i, { text: false, parent: el });
          if (el.namespaceURI !== HTML_NS) {
            issues.push(`output in an SVG or MathML attribute is not allowed: ${mark.text}`);
            continue;
          }
          if (mark.kind === 'tag') {
            issues.push(`Liquid tag inside the attribute "${a.name}": ${mark.text}`);
            continue;
          }
          const attrName = a.name.toLowerCase();
          if (attrName.startsWith('on') || attrName === 'style' || attrName === 'srcdoc') {
            issues.push(`output in the "${a.name}" attribute is not allowed: ${mark.text}`);
            continue;
          }
          const loc = el.sourceCodeLocation?.attrs?.[a.name];
          const raw = loc ? skeleton.slice(loc.startOffset, loc.endOffset) : '';
          const quote = /^[^=]*=\s*(["'])/.exec(raw);
          if (!quote) issues.push(`output in an unquoted attribute value: <${el.tagName} ${a.name}=…>: ${mark.text}`);
          const isUrl = URL_ATTRS.has(attrName) || (el.tagName === 'meta' && attrName === 'content' && /refresh/i.test(el.attrs.find((x) => x.name === 'http-equiv')?.value ?? ''));
          const last = mark.filters[mark.filters.length - 1];
          if (isUrl && last !== 'url' && last !== 'asset_url') issues.push(`output in the URL attribute "${a.name}" must end with the url filter: ${mark.text}`);
        }
      }
    }
    const kids = [...(('childNodes' in n ? n.childNodes : []) as Node[]), ...(('tagName' in n && (n as Element).tagName === 'template' ? ((n as unknown as { content: { childNodes: Node[] } }).content.childNodes) : []) as Node[])];
    for (const c of kids) visit(c, n);
  };
  visit(doc as unknown as Node, null);
  marks.forEach((m, i) => {
    if (!where.has(i) && !issues.some((x) => x.endsWith(m.text))) issues.push(`Liquid in a place HTML drops: ${m.text}`);
  });
  for (const [i, w] of where) if (!w.text && marks[i]!.kind === 'tag' && !issues.some((x) => x.endsWith(marks[i]!.text))) issues.push(`Liquid tag outside text: ${marks[i]!.text}`);

  // Control structures: every marker of one structure is text in the same parent (R36).
  const stack: Array<{ name: string; marks: number[] }> = [];
  marks.forEach((m, i) => {
    if (!isTag(m.token)) return;
    const name = m.token.name;
    if (BLOCKS[name]) stack.push({ name, marks: [i] });
    else if (STRUCTURAL.has(name) && name !== 'endcomment') {
      const top = stack[stack.length - 1];
      if (!top) return;
      top.marks.push(i);
      if (name === BLOCKS[top.name]!.end) {
        stack.pop();
        const parents = new Set(top.marks.map((k) => where.get(k)?.parent ?? null));
        const allText = top.marks.every((k) => where.get(k)?.text);
        if (!allText || parents.size !== 1) issues.push(`{% ${top.name} %} is not context-neutral: its branches open or close elements, or sit in different places: ${marks[top.marks[0]!]!.text}`);
        // And each branch on its own: its tags balanced, nothing closed that it did not open (R36).
        for (let k = 0; k + 1 < top.marks.length; k++) {
          const body = skeleton.slice(marks[top.marks[k]!]!.end, marks[top.marks[k + 1]!]!.start);
          const problem = unbalanced(body);
          if (problem) issues.push(`{% ${top.name} %} is not context-neutral: a branch ${problem}: ${marks[top.marks[0]!]!.text}`);
        }
      }
    }
  });
  return issues;
}

/**
 * Include / render tags only in text (R27): checked on each template by itself — composition replaces
 * the tags by the partial's source, after which an include inside an attribute could not be seen.
 */
function checkIncludePlacement(source: string, name: string): string[] {
  let tokens: TopLevelToken[];
  try {
    tokens = tokenize(source, name);
  } catch {
    return [];
  }
  let skeleton = '';
  const includes = new Map<number, string>();
  tokens.forEach((t, i) => {
    if (t.kind === TokenKind.HTML) skeleton += t.getText();
    else if (isTag(t) && (t.name === 'include' || t.name === 'render')) {
      includes.set(i, t.getText());
      skeleton += `hpr${i}r`;
    } else skeleton += 'x';
  });
  const issues: string[] = [];
  const seen = new Set<number>();
  const MARK = /hpr(\d+)r/g;
  const visit = (n: Node, parent: Node | null) => {
    const kind = (n as { nodeName: string }).nodeName;
    if (kind === '#text' || kind === '#comment') {
      const p = parent as Element | null;
      const value = (n as { value?: string; data?: string }).value ?? (n as { data?: string }).data ?? '';
      for (const m of value.matchAll(MARK)) {
        seen.add(Number(m[1]));
        if (kind === '#comment' || (p && 'tagName' in p && (RAW_TEXT.has(p.tagName) || RCDATA.has(p.tagName)))) issues.push(`include / render outside text: ${includes.get(Number(m[1]))}`);
      }
    } else if ('tagName' in n) {
      const el = n as Element;
      const names = [el.tagName, ...el.attrs.flatMap((a) => [a.name, a.value])].join(' ');
      for (const m of names.matchAll(MARK)) {
        seen.add(Number(m[1]));
        issues.push(`include / render outside text: ${includes.get(Number(m[1]))}`);
      }
    }
    const kids = [...(('childNodes' in n ? n.childNodes : []) as Node[]), ...(('tagName' in n && (n as Element).tagName === 'template' ? ((n as unknown as { content: { childNodes: Node[] } }).content.childNodes) : []) as Node[])];
    for (const c of kids) visit(c, n);
  };
  visit(parse(skeleton) as unknown as Node, null);
  for (const [i, text] of includes) if (!seen.has(i)) issues.push(`include / render outside text: ${text}`);
  return issues;
}

/** Liquid in the page skeleton: a word no media type is, so a computed value shows. */
const LIQUID_OUTPUT = 'heopress-liquid-output';

/**
 * The `<script>` elements of a composed page in every branch (HeoPress P07 task 2.4; Codex review of batch 5b-1):
 * the page's Liquid comments dropped, every other tag removed (so all branches stand side by side), each output a
 * marker word — then parsed as HTML, as the browser and the post-processing read it (adjacent attributes, character
 * references, a start tag assembled across partials, and HTML comments and `<textarea>` text that are no element,
 * all as they really are; `<noscript>` content as markup too). A script whose `type` the template computes is refused (a script's kind is written out);
 * one whose type is JSON-LD is refused: the page's structured data is the system's. The rendered page is checked
 * again after post-processing.
 */
function checkScriptTypes(composed: string, page: string): string[] {
  let tokens: TopLevelToken[];
  try {
    tokens = tokenize(composed, page);
  } catch {
    return []; // reported by the syntax checks
  }
  let skeleton = '';
  let inComment = 0;
  // Whitespace control (`{%-`, `-%}`, `{{-`, `-}}`; greedy, Liquid's default): the whitespace beside the tag goes, as
  // it does when rendering — a comment in a type (`application/  {%- comment -%}{%- endcomment -%}ld+json`) included.
  let trimNext = false;
  for (const t of tokens) {
    if (t.kind === TokenKind.HTML) {
      if (inComment > 0) continue;
      skeleton += trimNext ? t.getText().replace(/^\s+/, '') : t.getText();
      trimNext = false;
      continue;
    }
    const d = t as unknown as { trimLeft?: boolean; trimRight?: boolean };
    if (inComment === 0 && d.trimLeft) skeleton = skeleton.replace(/\s+$/, '');
    if (isTag(t) && t.name === 'comment') inComment++;
    else if (isTag(t) && t.name === 'endcomment') inComment = Math.max(0, inComment - 1);
    else if (inComment > 0) continue;
    // Output: the marker, which shows a computed value. Any other tag: nothing, so markup split around a tag
    // (`<scr{% if x %}{% endif %}ipt`) reads as the browser gets it, and a tag inside a type leaves its branches' text.
    else if (isOutput(t) || (isTag(t) && t.name === 'echo')) skeleton += LIQUID_OUTPUT;
    if (inComment === 0) trimNext = !!d.trimRight;
  }
  const out: string[] = [];
  const walk = (n: DefaultTreeAdapterMap['node']) => {
    const el = n as DefaultTreeAdapterMap['element'];
    if (el.tagName === 'script') {
      const type = el.attrs.find((a) => a.name === 'type')?.value;
      if (type !== undefined && type.includes(LIQUID_OUTPUT)) out.push("a <script>'s type is computed: write it out");
      else if (type !== undefined && type.split(';')[0]!.trim().toLowerCase() === 'application/ld+json') {
        out.push("a theme cannot output JSON-LD: the system writes the page's structured data; use a structured-data contribution instead (an item's structured_data field, or an extension's StructuredDataContribution)");
      }
    }
    for (const c of (el.childNodes ?? []) as DefaultTreeAdapterMap['node'][]) walk(c);
    const content = (n as DefaultTreeAdapterMap['template']).content;
    if (content) for (const c of content.childNodes as DefaultTreeAdapterMap['node'][]) walk(c);
  };
  // Parsed as a browser without scripting reads it as well (Codex review of batch 5b-1): `<noscript>` content is markup
  // then, so a script inside one is a script.
  walk(parse(skeleton) as unknown as DefaultTreeAdapterMap['node']);
  walk(parse(skeleton, { scriptingEnabled: false }) as unknown as DefaultTreeAdapterMap['node']);
  return [...new Set(out)];
}

/** Every issue of a theme version (empty: it may be published, as far as the static checks go). */
export function checkTheme(templates: Record<string, string>, assets: ThemeAsset[] = []): ThemeIssue[] {
  const issues: ThemeIssue[] = [];
  for (const name of REQUIRED_TEMPLATES) if (!(name in templates)) issues.push({ template: name, message: 'required template missing' });
  for (const name of Object.keys(templates)) {
    if (!TEMPLATE_NAME.test(name)) issues.push({ template: name, message: 'template names are lowercase paths without dots or extensions' });
    const bad = forbiddenPath(templates[name]!);
    if (bad) issues.push({ template: name, message: `property path not allowed: ${bad}` });
    for (const message of checkIncludePlacement(templates[name]!, name)) issues.push({ template: name, message });
  }
  if (issues.some((i) => i.message.startsWith('property path not allowed') || i.message.startsWith('template names are'))) return issues;
  const engine = createThemeEngine(templates, { id: 'check', assets });
  // Every asset a template names exists in this version (`'css/site.css' | asset_url`).
  const paths = new Set(assets.map((a) => a.path));
  for (const [name, source] of Object.entries(templates)) {
    for (const m of source.matchAll(/(['"])([^'"]*)\1\s*\|\s*asset_url\b/g)) {
      if (!paths.has(m[2]!)) issues.push({ template: name, message: `asset_url: no asset "${m[2]}" in this theme version` });
    }
    if (/\|\s*asset_url\b/.test(source.replace(/(['"])[^'"]*\1\s*\|\s*asset_url\b/g, ''))) {
      issues.push({ template: name, message: 'asset_url takes a string literal asset path' });
    }
  }
  for (const page of REQUIRED_TEMPLATES) {
    if (!(page in templates)) continue;
    const composed = compose(templates, page);
    for (const message of composed.issues) issues.push({ template: page, message });
    if (composed.issues.length) continue;
    for (const message of checkContexts(composed.source)) issues.push({ template: page, message });
    for (const message of checkScriptTypes(composed.source, page)) issues.push({ template: page, message });
    let tags: TopLevelToken[] = [];
    try {
      tags = tokenize(composed.source, page).filter(isTag);
    } catch {
      // reported above
    }
    const count = (n: string) => tags.filter((t) => (t as TagToken).name === n).length;
    if (count('seo_head') !== 1) issues.push({ template: page, message: 'must output {% seo_head %} exactly once (in <head>)' });
    if (page === 'item' && count('item_body') !== 1) issues.push({ template: page, message: 'must output {% item_body %} exactly once' });
    // Variables: only the View Model's, whole paths (liquidjs' static analysis follows partials and scopes).
    for (const message of checkPaths(engine, page, composed.source)) issues.push({ template: page, message });
  }
  return issues;
}
