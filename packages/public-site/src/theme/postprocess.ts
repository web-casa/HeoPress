import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import type { ThemeViewModel } from '@heopress/contracts/theme';
import { jsonLdText, type PageHead } from '@heopress/seo-geo';
import { ENGINE_LIMITS, safeUrl, type SlotRegistry } from './engine.ts';

/**
 * The final HTML of a theme render (HeoPress P06 tasks 2.2, 2.6, 2.7; design R15, R16, R28): every system
 * placeholder is checked against this render's registry — known nonce, right kind, exactly once, in a
 * live (non-inert) place — the page's own markup is checked for script vectors, and only then are the
 * placeholders replaced by what the system generates. A theme cannot rewrite the body, the SEO head,
 * a disclosure or JSON-LD, and cannot forge or copy a placeholder. Any violation fails the render
 * (the site's error page; fail closed).
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

class ThemeRuleError extends Error {
  readonly code = 'THEME_RULE';
}

/** What the system puts in place of the placeholders. */
export interface SystemContent {
  /** Sanitised rich text of the page's item (by item id). */
  bodies: Record<string, string>;
  /** Explicit sponsor disclosure is on for the site: sponsored items need a disclosure before their body or in their card. */
  disclosureRequired: boolean;
  /** The disclosure text of each sponsored item (by item id). */
  disclosures: Record<string, string>;
  /**
   * The page's head from the SEO data layer (HeoPress P07 task 1.2): what `{% seo_head %}` outputs. Without it,
   * the View Model's `seo` (title, description, canonical, robots).
   */
  head?: PageHead;
}

/**
 * A preview render (design R17, R29, R43): the page is served on the preview origin under `prefix`
 * (`/<site id>/`); links leaving it lose their `href`, external images and media go, and forms, frames,
 * plug-ins and prefetching links are removed — the draft cannot be carried away by the page itself.
 */
export interface PreviewPolicy {
  /** The preview origin, `https://preview.example.com`. */
  origin: string;
  /** The preview's path on it, `/<site id>/`. */
  prefix: string;
  /** Origins images and media may come from besides the preview itself (the media host). */
  media: string[];
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data', 'background', 'ping', 'manifest', 'xlink:href', 'longdesc', 'codebase']);
const FORBIDDEN_ELEMENTS = new Set(['base', 'frame', 'frameset']);
/** SVG / MathML elements that set attributes at run time (an `href` to `javascript:` included): refused. */
const ANIMATION_ELEMENTS = new Set(['animate', 'set', 'animatemotion', 'animatetransform', 'animatecolor', 'discard']);
const HTML_NS = 'http://www.w3.org/1999/xhtml';
/** The only attributes a system placeholder element carries. */
const SLOT_ATTRS: Record<string, string[]> = { meta: ['content', 'name'], 'heopress-slot': ['data-n'], article: ['data-heopress-card'] };

/** Where a link really goes (origin + path, no query or fragment, no trailing slash), or null. */
function destination(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;
const isElement = (n: Node): n is Element => 'tagName' in n;

function children(n: Node): Node[] {
  const own = 'childNodes' in n ? (n.childNodes as Node[]) : [];
  // A <template>'s content is a separate fragment: walked too (and inert).
  const content = isElement(n) && n.tagName === 'template' ? ((n as unknown as { content: ParentNode }).content.childNodes as Node[]) : [];
  return [...own, ...content];
}

interface Found {
  nonce: string;
  kind: string;
  el: Element;
  order: number;
  inert: boolean;
  inHead: boolean;
  card: Element | null;
}

/** What a theme's own JSON-LD is told (P07; spec seo/page-metadata "主题直接输出 JSON-LD"): use a contribution instead. */
const CONTRIBUTE_INSTEAD = "a theme cannot output JSON-LD: the system writes the page's structured data; use a structured-data contribution instead (an item's structured_data field, or an extension's StructuredDataContribution)";

function fail(message: string): never {
  throw new ThemeRuleError(message);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}


function checkUrl(el: Element, name: string, value: string): void {
  const candidates = name === 'srcset' ? value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '') : [value];
  for (const url of candidates) {
    if (url === '' || url === '#') continue;
    if (safeUrl(url) === '#') fail(`<${el.tagName} ${name}>: URL scheme not allowed`);
  }
}

function seoHtml(vm: ThemeViewModel, head?: PageHead): string {
  if (head) return headHtml(head, vm.site.name);
  const parts = [`<title>${escapeHtml(vm.seo.title || vm.site.name)}</title>`];
  if (vm.seo.description) parts.push(`<meta name="description" content="${escapeHtml(vm.seo.description)}">`);
  if (vm.seo.canonical) parts.push(`<link rel="canonical" href="${escapeHtml(safeUrl(vm.seo.canonical))}">`);
  if (vm.seo.robots) parts.push(`<meta name="robots" content="${escapeHtml(vm.seo.robots)}">`);
  for (const a of vm.alternates) parts.push(`<link rel="alternate" hreflang="${escapeHtml(a.locale)}" href="${escapeHtml(safeUrl(a.url))}">`);
  return parts.join('');
}

/** The head the SEO data layer describes, as markup (every value escaped; URLs checked). */
/** Whether a `type` attribute names a media type (case and parameters aside, as browsers read it). */
function isMediaType(value: string | undefined, type: string): boolean {
  return (value ?? '').split(';')[0]!.trim().toLowerCase() === type;
}

function headHtml(head: PageHead, siteName: string): string {
  const parts = [`<title>${escapeHtml(head.title || siteName)}</title>`];
  if (head.description) parts.push(`<meta name="description" content="${escapeHtml(head.description)}">`);
  if (head.canonical) parts.push(`<link rel="canonical" href="${escapeHtml(safeUrl(head.canonical))}">`);
  if (head.robots) parts.push(`<meta name="robots" content="${escapeHtml(head.robots)}">`);
  for (const a of head.alternates) parts.push(`<link rel="alternate" hreflang="${escapeHtml(a.locale)}" href="${escapeHtml(safeUrl(a.url))}">`);
  // The page's Markdown copy (P07 task 4.2).
  if (head.markdown) parts.push(`<link rel="alternate" type="text/markdown" href="${escapeHtml(safeUrl(head.markdown))}">`);
  // The language's feeds (P07 task 3.3).
  for (const f of head.feeds ?? []) {
    parts.push(`<link rel="alternate" type="${f.type === 'atom' ? 'application/atom+xml' : 'application/rss+xml'}" title="${escapeHtml(f.title)}" href="${escapeHtml(safeUrl(f.url))}">`);
  }
  for (const m of head.meta) {
    const content = m.property === 'og:url' || m.property === 'og:image' ? safeUrl(m.content) : m.content;
    parts.push(m.property ? `<meta property="${escapeHtml(m.property)}" content="${escapeHtml(content)}">` : `<meta name="${escapeHtml(m.name ?? '')}" content="${escapeHtml(content)}">`);
  }
  // The page's one structured-data graph (P07): JSON whose `<`, `>` and `&` are escaped, so it cannot end the script.
  if (head.jsonLd) parts.push(`<script type="application/ld+json">${jsonLdText(head.jsonLd)}</script>`);
  return parts.join('');
}

function replaceWith(target: Element, html: string, context: Element): void {
  const fragment = parseFragment(context as ParentNode, html, {}) as unknown as ParentNode;
  const parent = target.parentNode as ParentNode;
  const at = parent.childNodes.indexOf(target as never);
  const nodes = fragment.childNodes as Node[];
  for (const n of nodes) (n as { parentNode: ParentNode | null }).parentNode = parent;
  parent.childNodes.splice(at, 1, ...(nodes as never[]));
}

const PREVIEW_REMOVED = new Set(['form', 'iframe', 'object', 'embed', 'portal', 'applet', 'frame', 'frameset']);
const PREVIEW_MEDIA = new Set(['img', 'source', 'video', 'audio', 'track', 'input', 'image', 'picture']);
const HINT_REL = /\b(prefetch|preload|modulepreload|dns-prefetch|preconnect|prerender)\b/;

/** CSS that can make the browser fetch something (or hide that it does, by escapes). */
const CSS_FETCH = /url\s*\(|image-set|@import|\\|expression\s*\(/i;
const URL_BEARING = new Set([...URL_ATTRS, 'srcset', 'imagesrcset']);

/** The images and media the system's own content (the item's sanitised body) names: the only ones fetched from a media origin. */
function systemMedia(system: SystemContent, resolve: (v: string) => URL | null): Set<string> {
  const urls = new Set<string>();
  const walk = (n: Node) => {
    if (isElement(n)) {
      for (const a of n.attrs) {
        const name = a.name.toLowerCase();
        const values = name === 'srcset' ? a.value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '') : name === 'src' || name === 'poster' ? [a.value] : [];
        for (const v of values) {
          const u = v ? resolve(v) : null;
          if (u) urls.add(u.href);
        }
      }
    }
    for (const c of children(n)) walk(c);
  };
  for (const html of Object.values(system.bodies)) walk(parseFragment(html) as unknown as Node);
  return urls;
}

/**
 * Remove from a preview page what could navigate or send the draft elsewhere (R29). A resource may come
 * from the preview itself, or from a media origin only when the system's content names that exact URL
 * (a theme cannot build a media URL out of draft data); CSS that fetches is removed.
 */
function stripForPreview(doc: Node, policy: PreviewPolicy, system: SystemContent): void {
  const page = `${policy.origin}${policy.prefix}view`;
  const resolve = (value: string): URL | null => {
    try {
      return new URL(value.trim(), page);
    } catch {
      return null;
    }
  };
  const inPreview = (u: URL | null) => !!u && u.origin === policy.origin && u.pathname.startsWith(policy.prefix);
  const named = systemMedia(system, resolve);
  const resourceOk = (value: string) => {
    if (!value.trim()) return true;
    const u = resolve(value);
    return inPreview(u) || (!!u && policy.media.includes(u.origin) && named.has(u.href));
  };
  const urlsOk = (name: string, value: string) =>
    name === 'srcset' || name === 'imagesrcset' ? value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '').every(resourceOk) : resourceOk(value);
  const text = (el: Element) => children(el).map((c) => ('value' in c ? (c as { value: string }).value : '')).join('');
  const walk = (n: Node): void => {
    for (const c of children(n)) {
      if (!isElement(c)) continue;
      const tag = c.tagName.toLowerCase();
      const rel = (attr(c, 'rel') ?? '').toLowerCase();
      const remove =
        PREVIEW_REMOVED.has(tag) ||
        (tag === 'style' && CSS_FETCH.test(text(c))) ||
        (tag === 'link' && (HINT_REL.test(rel) || !resourceOk(attr(c, 'href') ?? ''))) ||
        (PREVIEW_MEDIA.has(tag) && c.attrs.some((a) => URL_BEARING.has(a.name.toLowerCase()) && !urlsOk(a.name.toLowerCase(), a.value)));
      if (remove) {
        const parent = c.parentNode as ParentNode | null;
        if (parent) parent.childNodes.splice(parent.childNodes.indexOf(c as never), 1);
        continue;
      }
      c.attrs = c.attrs.filter((a) => {
        const name = a.name.toLowerCase();
        if (name === 'ping' || name === 'formaction' || name === 'action') return false;
        if (name === 'style') return !CSS_FETCH.test(a.value);
        if ((tag === 'a' || tag === 'area') && (name === 'href' || name === 'xlink:href')) return a.value.trim().startsWith('#') || inPreview(resolve(a.value));
        // Any other URL (an SVG <use>, a `background`, `data`, `cite`…): the preview's own or a named medium only.
        if (URL_BEARING.has(name)) return urlsOk(name, a.value);
        return true;
      });
      walk(c);
    }
  };
  walk(doc);
}

/**
 * The theme's markup read by a browser without scripting (HeoPress P07 task 2.4; Codex review of batch 5b-1): `<noscript>`
 * content is markup then, so a JSON-LD script inside one is refused like any other (the main parse reads it as text).
 */
function refuseNoscriptJsonLd(html: string): void {
  if (!/<noscript/i.test(html)) return;
  const walk = (n: Node): void => {
    if (isElement(n) && n.tagName === 'script' && isMediaType(attr(n, 'type'), 'application/ld+json')) {
      fail(CONTRIBUTE_INSTEAD);
    }
    // `<template>` content included (`children` reads it too).
    for (const c of children(n)) walk(c);
  };
  walk(parse(html, { scriptingEnabled: false }) as unknown as Node);
}

export function postprocess(
  html: string,
  slots: SlotRegistry,
  vm: ThemeViewModel,
  system: SystemContent,
  opts: { preview?: PreviewPolicy } = {},
): string {
  const doc = parse(html);
  refuseNoscriptJsonLd(html);
  const found: Found[] = [];
  const seen = new Set<string>();
  let order = 0;
  let head: Element | null = null;

  const visit = (n: Node, ctx: { inert: boolean; inHead: boolean; card: Element | null }): void => {
    if (!isElement(n)) return;
    const el = n;
    order++;
    if (el.tagName === 'head') head = el;
    if (FORBIDDEN_ELEMENTS.has(el.tagName)) fail(`<${el.tagName}> is not allowed`);
    if (ANIMATION_ELEMENTS.has(el.tagName.toLowerCase())) fail(`<${el.tagName}> is not allowed`);
    if (el.tagName === 'meta' && (attr(el, 'http-equiv') ?? '').toLowerCase() === 'refresh') fail('<meta http-equiv="refresh"> is not allowed');
    if (el.tagName === 'iframe' && attr(el, 'srcdoc') !== undefined) fail('<iframe srcdoc> is not allowed');

    // System placeholders.
    let slot: { kind: string; nonce: string; id?: string } | null = null;
    if (el.tagName === 'meta' && attr(el, 'name') === 'heopress-slot') {
      const m = /^seo:([0-9a-f]{24})$/.exec(attr(el, 'content') ?? '');
      if (!m) fail('malformed system slot');
      slot = { kind: 'seo', nonce: m[1]! };
    } else if (el.tagName === 'heopress-slot') {
      const m = /^(body|disclosure):([0-9a-f]{24})$/.exec(attr(el, 'data-n') ?? '');
      if (!m) fail('malformed system slot');
      slot = { kind: m[1]!, nonce: m[2]! };
    } else if (el.tagName === 'script' && isMediaType(attr(el, 'type'), 'application/heopress-slot')) {
      // No system tag writes one any more (P07): never a placeholder.
      fail('malformed system slot');
    } else if (el.tagName === 'script' && isMediaType(attr(el, 'type'), 'application/ld+json')) {
      // HeoPress P07 task 2.4: the page's structured data is the system's one graph; a theme does not add its own.
      fail(CONTRIBUTE_INSTEAD);
    } else if (attr(el, 'data-heopress-card') !== undefined) {
      const m = /^(.*):([0-9a-f]{24})$/.exec(attr(el, 'data-heopress-card')!);
      if (!m || el.tagName !== 'article') fail('malformed card');
      slot = { kind: 'card', nonce: m[2]!, id: m[1]! };
    } else if (attr(el, 'data-n') !== undefined && el.tagName.includes('heopress')) {
      fail('malformed system slot');
    }

    // Every element, a placeholder included: no script vectors (R15, at run time as well).
    for (const a of el.attrs) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on')) fail(`<${el.tagName} ${a.name}>: event handler attributes are not allowed`);
      if (name === 'srcset' || URL_ATTRS.has(name)) checkUrl(el, name, a.value);
      if (!slot && name.startsWith('data-heopress')) fail('system attribute in theme markup');
    }

    if (slot) {
      // A placeholder is exactly what the system tag wrote: its one attribute set, HTML, empty, not nested.
      const allowed = SLOT_ATTRS[el.tagName] ?? [];
      if (el.attrs.map((a) => a.name).sort().join(',') !== allowed.join(',')) fail(`${slot.kind} slot with foreign attributes`);
      if (el.namespaceURI !== HTML_NS) fail(`${slot.kind} slot inside SVG or MathML`);
      if (slot.kind === 'body' || slot.kind === 'disclosure') {
        if (el.childNodes.length) fail(`${slot.kind} slot with content`);
      }
      if (slot.kind === 'card' && ctx.card) fail('a card inside a card');
      const entry = slots.get(slot.nonce);
      if (!entry || entry.kind !== slot.kind || (slot.id !== undefined && entry.id !== slot.id)) fail(`${slot.kind} slot not produced by this render`);
      if (seen.has(slot.nonce)) fail(`${slot.kind} slot repeated`);
      seen.add(slot.nonce);
      found.push({ nonce: slot.nonce, kind: slot.kind, el, order, inert: ctx.inert, inHead: ctx.inHead, card: ctx.card });
    }

    const inert =
      ctx.inert || el.tagName === 'template' || el.tagName === 'noscript' || attr(el, 'hidden') !== undefined || attr(el, 'inert') !== undefined;
    const next = { inert, inHead: ctx.inHead || el.tagName === 'head', card: slot?.kind === 'card' ? el : ctx.card };
    for (const c of children(el)) visit(c, next);
  };
  for (const c of children(doc as unknown as Node)) visit(c, { inert: false, inHead: false, card: null });

  // Every placeholder this render produced appears exactly once (copied or swallowed → fail).
  for (const nonce of slots.keys()) if (!seen.has(nonce)) fail(`${slots.get(nonce)!.kind} slot missing from the output (captured, escaped or dropped)`);

  const of = (kind: string) => found.filter((f) => f.kind === kind);
  const seo = of('seo');
  if (seo.length !== 1) fail('the page must output {% seo_head %} exactly once');
  if (!seo[0]!.inHead || seo[0]!.inert) fail('{% seo_head %} must be inside <head>');
  for (const f of found) {
    if (f.kind !== 'seo' && (f.inHead || f.inert)) fail(`${f.kind} slot in an inert place or in <head>`);
  }

  // The item page: its body exactly once; a sponsored item's disclosure before it when required.
  const item = vm.item;
  const bodies = of('body');
  if (vm.page.type === 'item') {
    if (!item) fail('item page without an item');
    if (bodies.length !== 1 || slots.get(bodies[0]!.nonce)!.id !== item.id) fail('the item page must output {% item_body %} exactly once');
    if (system.disclosureRequired && item.sponsor.sponsored) {
      const d = of('disclosure').find((f) => slots.get(f.nonce)!.id === item.id && !f.card);
      if (!d) fail('sponsored item: {% sponsor_disclosure item %} is required');
      if (d.order > bodies[0]!.order) fail('sponsored item: the disclosure must come before the body');
    }
  } else if (bodies.length) {
    fail('{% item_body %} outside an item page');
  }

  // Lists: every link to a sponsored card's URL is inside that card; its card carries the disclosure.
  // Relative links resolve against the page itself, as a browser does (<base> is refused).
  const pageUrl = destination(vm.page.path, vm.site.homeUrl) ?? vm.site.homeUrl;
  const base = `${pageUrl}${vm.page.path.endsWith('/') ? '/' : ''}`;
  const sponsoredCards = new Map(vm.list.filter((c) => c.sponsored).map((c) => [c.id, c]));
  const cards = of('card');
  for (const card of cards) {
    const id = slots.get(card.nonce)!.id!;
    if (!sponsoredCards.has(id) || !system.disclosureRequired) continue;
    const inside = of('disclosure').filter((f) => f.card === card.el && slots.get(f.nonce)!.id === id);
    if (inside.length !== 1) fail(`sponsored card ${id}: exactly one {% sponsor_disclosure %} is required inside it`);
  }
  const linksTo = (url: string) => {
    const out: Array<{ el: Element; card: Element | null }> = [];
    const walk = (n: Node, card: Element | null) => {
      if (!isElement(n)) return;
      const c = attr(n, 'data-heopress-card') !== undefined ? n : card;
      const href = n.tagName === 'a' || n.tagName === 'area' ? attr(n, 'href') : undefined;
      if (href !== undefined && destination(href, base) === url) out.push({ el: n, card: c });
      for (const ch of children(n)) walk(ch, c);
    };
    for (const ch of children(doc as unknown as Node)) walk(ch, null);
    return out;
  };
  for (const [id, card] of sponsoredCards) {
    const target = destination(card.url, base);
    for (const link of target ? linksTo(target) : []) {
      const container = cards.find((c) => c.el === link.card);
      if (!container || slots.get(container.nonce)!.id !== id) fail(`a link to sponsored item ${id} outside its {% card %}`);
    }
  }

  // Replace, now that everything checked out.
  for (const f of found) {
    const entry = slots.get(f.nonce)!;
    if (f.kind === 'seo') replaceWith(f.el, seoHtml(vm, system.head), head ?? f.el);
    else if (f.kind === 'body') replaceWith(f.el, `<div class="heopress-body">${system.bodies[entry.id!] ?? ''}</div>`, f.el.parentNode as Element);
    else if (f.kind === 'disclosure') {
      const text = system.disclosures[entry.id!];
      const show = system.disclosureRequired && text !== undefined && (sponsoredCards.has(entry.id!) || (item !== null && item.id === entry.id && item.sponsor.sponsored));
      replaceWith(f.el, show ? `<aside class="heopress-disclosure" role="note">${escapeHtml(text)}</aside>` : '', f.el.parentNode as Element);
    } else if (f.kind === 'card') {
      f.el.attrs = f.el.attrs.map((a) => (a.name === 'data-heopress-card' ? { name: a.name, value: entry.id! } : a));
    }
  }
  // After the replacement: the item's body is stripped as well.
  if (opts.preview) stripForPreview(doc as unknown as Node, opts.preview, system);
  const out = serialize(doc);
  if (Buffer.byteLength(out) > ENGINE_LIMITS.maxOutputBytes) fail('output too large');
  return out;
}
