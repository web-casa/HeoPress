import { randomBytes } from 'node:crypto';
import { Context, Liquid, Tag, type FS, TokenKind, Tokenizer, toPromise, toValue, type Emitter, type TagToken, type Template, type TopLevelToken, Value } from 'liquidjs';

import { assertViewModel } from './validate.ts';
/**
 * The template engine of a theme version (HeoPress P06 tasks 2.2, 2.6; design §3, R2, R16, R27, R28).
 *
 *   - Only the version's own templates exist (an in-memory map: no file system, nothing outside the
 *     version, no `..`); partial names must be string literals (checked before publication).
 *   - Output is HTML-escaped; strict variables and filters; own properties only (no prototype chain);
 *     parse, render-time and memory limits.
 *   - Tags and filters are allow-listed: the others are replaced by ones that fail.
 *   - Markup never comes from data: the system tags emit placeholders bound to this render's nonce,
 *     which `postprocess` checks and replaces with what the system generates.
 *
 * Imports use explicit `.ts` paths: the rendering worker loads this module directly (Node type stripping).
 */

export const ENGINE_LIMITS = {
  /** Template source size, characters (each template and each render). */
  parseLimit: 200_000,
  /** Render time inside the engine, ms (the pool also enforces a wall-clock timeout). */
  renderLimit: 500,
  /** Allocated string / array memory, bytes-ish (liquidjs' own accounting). */
  memoryLimit: 8_000_000,
  /** Final HTML size, bytes. */
  maxOutputBytes: 2_000_000,
  /** Characters one render may write, its output and every capture together (checked as they are written). */
  maxRenderChars: 4_000_000,
} as const;

/** `echo` and `cycle` are not here: they write their value without the output escaping `{{ }}` gets. */
export const ALLOWED_TAGS = new Set(['assign', 'capture', 'case', 'comment', '#', 'decrement', 'increment', 'for', 'break', 'continue', 'if', 'unless', 'include', 'render']);
export const SYSTEM_TAGS = new Set(['seo_head', 'item_body', 'sponsor_disclosure', 'card']);

/** Filters a template may use: none returns markup the escaping would let through. */
export const ALLOWED_FILTERS = new Set([
  'escape', 'escape_once', 'strip_html', 'abs', 'at_least', 'at_most', 'ceil', 'divided_by', 'floor', 'minus', 'plus', 'modulo', 'times', 'round',
  'url_decode', 'url_encode', 'cgi_escape', 'uri_escape', 'slugify', 'join', 'last', 'first', 'reverse', 'sort', 'sort_natural', 'size', 'map', 'sum',
  'compact', 'concat', 'slice', 'where', 'reject', 'uniq', 'date', 'date_to_xmlschema', 'date_to_rfc822', 'date_to_string', 'date_to_long_string',
  'append', 'prepend', 'lstrip', 'downcase', 'upcase', 'remove', 'remove_first', 'remove_last', 'rstrip', 'split', 'strip', 'strip_newlines',
  'squish', 'capitalize', 'replace', 'replace_first', 'replace_last', 'truncate', 'truncatewords', 'normalize_whitespace', 'number_of_words',
  'array_to_sentence_string', 'default', 'to_integer', 'url', 'asset_url',
]);

/** A template name: a lowercase relative path without dots or an extension (`partials/top`). */
export const TEMPLATE_NAME = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

/** Longest string a filter argument or result may be (beyond the engine's memory limit). */
const MAX_FILTER_STRING = 100_000;
/** Longest array a filter may take or return. */
const MAX_FILTER_ARRAY = 10_000;
/** Largest value a `capture` may hold, characters. */
const MAX_CAPTURE = 200_000;

/**
 * Property names that lead into JavaScript internals (the loop object is a class instance, so its
 * prototype is reachable) and dynamic `[variable]` access (which could spell them at run time): refused
 * in any Liquid expression, before publication and again when an engine is built. Read from the Liquid
 * tokens (so quotes and comments are understood); a name inside a string literal is only refused as a
 * `['…']` key.
 */
const FORBIDDEN_NAMES = new Set([
  '__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'valueOf',
]);

/**
 * What is wrong with one Liquid expression, scanned character by character (strings understood): an
 * identifier that names a JavaScript internal, a `[...]` key that is not a number or a string literal
 * (a variable key could spell an internal at run time), or a string-literal key naming one.
 */
function expressionProblem(expr: string): boolean {
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === '"' || c === "'") {
      const close = expr.indexOf(c, i + 1);
      i = close < 0 ? expr.length : close + 1;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      while (j < expr.length && /\s/.test(expr[j]!)) j++;
      const k = expr[j];
      if (k === '"' || k === "'") {
        const close = expr.indexOf(k, j + 1);
        if (close < 0 || FORBIDDEN_NAMES.has(expr.slice(j + 1, close).trim())) return true;
        i = close + 1;
        continue;
      }
      // Only a whole integer literal (`[0]`, `[-1]`): `[0k]` is a variable name to liquidjs.
      const num = /^-?\d+\s*\]/.exec(expr.slice(j));
      if (!num) return true;
      i = j + num[0].length;
      continue;
    }
    // Identifiers (Unicode letters included: liquidjs accepts them).
    const m = /^[\p{L}\p{N}_$-]+/u.exec(expr.slice(i));
    if (m) {
      if (FORBIDDEN_NAMES.has(m[0])) return true;
      i += m[0].length;
      continue;
    }
    i++;
  }
  return false;
}

/** The first Liquid expression of a template that uses a forbidden property path, if any. */
export function forbiddenPath(source: string): string | null {
  let tokens: TopLevelToken[];
  try {
    tokens = new Tokenizer(source).readTopLevelTokens();
  } catch {
    return null; // a syntax error is reported by the parse itself
  }
  let inComment = 0;
  for (const t of tokens) {
    let expr: string;
    if (t.kind === TokenKind.Tag) {
      const tag = t as TagToken;
      if (tag.name === 'comment') inComment++;
      else if (tag.name === 'endcomment') inComment = Math.max(0, inComment - 1);
      if (inComment || tag.name === '#' || tag.name === 'comment' || tag.name === 'endcomment') continue;
      expr = tag.args;
    } else if (t.kind === TokenKind.Output) {
      if (inComment) continue;
      expr = (t as unknown as { content: string }).content;
    } else continue;
    if (expressionProblem(expr)) return t.getText();
  }
  return null;
}

function checkFilterValue(name: string, v: unknown): void {
  if (typeof v === 'string' && v.length > MAX_FILTER_STRING) throw new Error(`filter "${name}": string too long`);
  if (Array.isArray(v) && v.length > MAX_FILTER_ARRAY) throw new Error(`filter "${name}": array too long`);
}

/** What a system tag stood for in this render: `postprocess` checks and replaces it. */
interface SlotEntry {
  kind: 'seo' | 'body' | 'disclosure' | 'card';
  /** The item (body, disclosure, card). */
  id?: string;
  /** The value to serialise (json). */
  value?: unknown;
}

export type SlotRegistry = Map<string, SlotEntry>;

/** One render's state, found from any context of that render (render-tag contexts share `globals`). */
interface RenderState {
  slots: SlotRegistry;
  /** Characters written so far: output and captures. */
  chars: number;
}
const renders = new WeakMap<object, RenderState>();

function stateOf(ctx: Context): RenderState {
  const state = renders.get(ctx.globals as object);
  if (!state) throw new Error('system tag outside a theme render');
  return state;
}

function registryOf(ctx: Context): SlotRegistry {
  return stateOf(ctx).slots;
}

/** Output or a capture, counted against the render's budget before it is kept. */
class BoundedEmitter implements Emitter {
  buffer = '';
  private readonly state: RenderState;
  // A plain field, not a parameter property: the worker loads this file with Node's type stripping.
  constructor(state: RenderState) {
    this.state = state;
  }
  write(html: unknown): void {
    const v = toValue(html);
    const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : Array.isArray(v) ? v.map((x) => String(toValue(x) ?? '')).join('') : String(v);
    this.state.chars += s.length;
    if (this.state.chars > ENGINE_LIMITS.maxRenderChars) throw new Error('render output limit exceeded');
    this.buffer += s;
  }
}

function newNonce(): string {
  return randomBytes(12).toString('hex');
}

function slot(ctx: Context, entry: SlotEntry): string {
  const nonce = newNonce();
  registryOf(ctx).set(nonce, entry);
  return nonce;
}

/** `{{ x | url }}`: http(s), mailto, or a site-relative URL; anything else becomes `#`. */
export function safeUrl(value: unknown): string {
  const s = String(value ?? '').trim();
  // Browsers drop tabs and newlines inside URLs (`java\tscript:`) and read `\` as `/`.
  const n = s.replace(/[\t\n\r]/g, '');
  if (n === '') return '#';
  if (/^(https?:|mailto:)/i.test(n)) return s;
  if (/^[/\\]/.test(n)) return /^[/\\][/\\]/.test(n) ? '#' : s;
  if (/^[?#]/.test(n)) return s;
  // Relative without a scheme (`foo/bar`): a colon before any slash would be one.
  return /^[^/?#\\]*:/.test(n) ? '#' : s;
}

function idOf(value: unknown): string {
  const id = value && typeof value === 'object' ? (value as { id?: unknown }).id : undefined;
  if (typeof id !== 'string' || id === '') throw new Error('this tag needs an item or a card (with an id)');
  return id;
}

class SeoHeadTag extends Tag {
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    emitter.write(`<meta name="heopress-slot" content="seo:${slot(ctx, { kind: 'seo' })}">`);
  }
}

class ItemBodyTag extends Tag {
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const item = ctx.getSync(['item']);
    emitter.write(`<heopress-slot data-n="body:${slot(ctx, { kind: 'body', id: idOf(item) })}"></heopress-slot>`);
  }
}

/** Tags taking one value argument: `{% sponsor_disclosure item %}`. */
abstract class ValueTag extends Tag {
  protected readonly value: Value;
  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(token, remainTokens, liquid);
    if (!token.args.trim()) throw new Error(`{% ${token.name} %} needs an argument`);
    this.value = new Value(token.args, liquid);
  }
  *arguments(): Generator<Value> {
    yield this.value;
  }
}

class SponsorDisclosureTag extends ValueTag {
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const target = yield this.value.value(ctx, false);
    emitter.write(`<heopress-slot data-n="disclosure:${slot(ctx, { kind: 'disclosure', id: idOf(target) })}"></heopress-slot>`);
  }
}


/** `{% card item %}…{% endcard %}`: the container a list entry's links and disclosure must be in. */
class CardTag extends Tag {
  private readonly value: Value;
  private readonly body: Template[] = [];
  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(token, remainTokens, liquid);
    if (!token.args.trim()) throw new Error('{% card %} needs an argument');
    this.value = new Value(token.args, liquid);
    const stream = liquid.parser
      .parseStream(remainTokens)
      .on('tag:endcard', () => stream.stop())
      .on('template', (tpl: Template) => this.body.push(tpl))
      .on('end', () => {
        throw new Error('{% card %} without {% endcard %}');
      });
    stream.start();
  }
  *arguments(): Generator<Value> {
    yield this.value;
  }
  // eslint-disable-next-line require-yield
  *children(): Generator<unknown, Template[]> {
    return this.body;
  }
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const target = yield this.value.value(ctx, false);
    const id = idOf(target);
    emitter.write(`<article data-heopress-card="${escapeAttr(id)}:${slot(ctx, { kind: 'card', id })}">`);
    yield this.liquid.renderer.renderTemplates(this.body, ctx, emitter);
    emitter.write('</article>');
  }
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function refusedTag(name: string) {
  return class extends Tag {
    constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
      super(token, remainTokens, liquid);
      throw new Error(`tag "${name}" is not allowed in themes`);
    }
    *render(): Generator<unknown, void, unknown> {
      // never reached
    }
  };
}

/** A Liquid engine over one theme version's templates (`name` → source, names without `.liquid`). */
/** An asset of a theme version, as its manifest lists it. */
export interface ThemeAsset {
  path: string;
  sha256: string;
  contentType: string;
  size: number;
}

/**
 * The URL of an asset: version- and content-addressed, so it can be cached for ever. `base`: `/_theme/` on
 * the public site, the preview's own authenticated path on the preview origin (R43).
 */
export function assetUrl(versionId: string, asset: ThemeAsset, base = '/_theme/'): string {
  const ext = asset.path.slice(asset.path.lastIndexOf('.') + 1);
  return `${base}${encodeURIComponent(versionId)}/${asset.sha256}.${ext}`;
}

/**
 * The templates of one version as liquidjs' file system: a name is looked up exactly as written — never
 * joined to a directory or normalised (`partials/../home` is not `home`), never read from disk — and a
 * name that is not a template name finds nothing.
 */
function versionFs(templates: Record<string, string>): FS {
  const sources = new Map(Object.entries(templates).map(([name, source]) => [`${name}.liquid`, source]));
  const read = (file: string) => {
    const source = sources.get(file);
    if (source === undefined) throw new Error(`ENOENT: no template "${file}" in this theme version`);
    return source;
  };
  return {
    exists: async (file) => sources.has(file),
    existsSync: (file) => sources.has(file),
    readFile: async (file) => read(file),
    readFileSync: read,
    resolve: (_dir, file, ext) => (TEMPLATE_NAME.test(file) ? `${file}${ext}` : '\u0000'),
  };
}

export function createThemeEngine(
  templates: Record<string, string>,
  version: { id: string; assets: ThemeAsset[]; assetBase?: string } = { id: 'none', assets: [] },
): Liquid {
  const liquid = new Liquid({
    fs: versionFs(templates),
    root: [''],
    // Names are never resolved against the including template's directory.
    relativeReference: false,
    extname: '.liquid',
    strictVariables: true,
    // `{% if item.fields.x %}` and `| default:` on a field the item does not have: false / null, not an error.
    lenientIf: true,
    strictFilters: true,
    ownPropertyOnly: true,
    jsTruthy: false,
    dynamicPartials: true,
    outputEscape: 'escape',
    parseLimit: ENGINE_LIMITS.parseLimit,
    renderLimit: ENGINE_LIMITS.renderLimit,
    memoryLimit: ENGINE_LIMITS.memoryLimit,
    cache: true,
  });
  for (const [name, source] of Object.entries(templates)) {
    // Names are what partials are looked up by: no `..`, no absolute path, nothing but this version's map.
    if (!TEMPLATE_NAME.test(name)) throw new Error(`template "${name}": template names are lowercase paths without dots or extensions`);
    const bad = forbiddenPath(source);
    if (bad) throw new Error(`template "${name}": property path not allowed: ${bad}`);
  }
  for (const name of Object.keys(liquid.tags)) if (!ALLOWED_TAGS.has(name)) liquid.registerTag(name, refusedTag(name));
  // `capture`: bounded, so a discarded capture cannot allocate without limit.
  const Capture = liquid.tags.capture as unknown as new (...a: unknown[]) => Tag & { variable: string; templates: Template[] };
  liquid.registerTag(
    'capture',
    class extends Capture {
      *render(ctx: Context): Generator<unknown, void, unknown> {
        // Written into a counted buffer (shared budget with the page), not allocated first and checked after.
        const emitter = new BoundedEmitter(stateOf(ctx));
        yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
        if (emitter.buffer.length > MAX_CAPTURE) throw new Error('capture too large');
        (ctx.bottom() as Record<string, unknown>)[this.variable] = emitter.buffer;
      }
    } as never,
  );
  for (const name of Object.keys(liquid.filters)) {
    if (ALLOWED_FILTERS.has(name)) {
      const original = liquid.filters[name]!;
      liquid.registerFilter(name, function (this: unknown, ...args: unknown[]) {
        for (const a of args) checkFilterValue(name, a);
        const out = (original as (...a: unknown[]) => unknown).apply(this, args);
        checkFilterValue(name, out);
        return out;
      });
    } else {
      liquid.registerFilter(name, () => {
        throw new Error(`filter "${name}" is not allowed in themes`);
      });
    }
  }
  // `{{ 'css/site.css' | asset_url }}`: an asset of this version, or an error (checked before publication).
  const byPath = new Map(version.assets.map((a) => [a.path, a]));
  liquid.registerFilter('asset_url', (v: unknown) => {
    const asset = typeof v === 'string' ? byPath.get(v) : undefined;
    if (!asset) throw new Error(`asset_url: no asset "${String(v)}" in this theme version`);
    return assetUrl(version.id, asset, version.assetBase);
  });
  liquid.registerFilter('url', (v: unknown) => {
    if (v !== null && v !== undefined && typeof v !== 'string' && typeof v !== 'number') throw new Error('filter "url": expects a string');
    checkFilterValue('url', v);
    return safeUrl(v);
  });
  liquid.registerTag('seo_head', SeoHeadTag);
  liquid.registerTag('item_body', ItemBodyTag);
  liquid.registerTag('sponsor_disclosure', SponsorDisclosureTag);
  liquid.registerTag('card', CardTag);
  return liquid;
}

/**
 * Render `entry` with the View Model as the only data. Returns the HTML with system placeholders and
 * the registry of this render's nonces (`postprocess` replaces them).
 */
export async function renderTemplate(
  liquid: Liquid,
  entry: string,
  viewModel: object,
  opts: { renderLimitMs?: number } = {},
): Promise<{ html: string; slots: SlotRegistry }> {
  const state: RenderState = { slots: new Map(), chars: 0 };
  const globals = {};
  renders.set(globals, state);
  // A deep copy of plain JSON: nothing but data reaches the template.
  const scope = JSON.parse(JSON.stringify(viewModel)) as object;
  // Only data the theme contract describes — checked on the copy the template gets (a toJSON or a
  // non-enumerable field cannot change it after the check): no request, database or secret.
  assertViewModel(scope);
  const templates = liquid.parseFileSync(entry);
  const ctx = new Context(scope, liquid.options, { globals, renderLimit: opts.renderLimitMs ?? ENGINE_LIMITS.renderLimit }, { liquid });
  const emitter = new BoundedEmitter(state);
  await toPromise(liquid.renderer.renderTemplates(templates, ctx, emitter));
  const html = emitter.buffer;
  if (Buffer.byteLength(html) > ENGINE_LIMITS.maxOutputBytes) throw new Error('output too large');
  return { html, slots: state.slots };
}
