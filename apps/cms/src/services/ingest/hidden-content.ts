import type { HiddenContentEvidence } from '@heopress/database';

/**
 * Hidden content (HeoPress P08 task 2.6; spec ingest/crawling "隐藏内容标记").
 *
 * Text a reader does not see but a model would read is evidence, not content. Before extraction this pass finds and
 * removes, recording where and what:
 *
 * - `hidden_attribute`, `aria_hidden` — `hidden`, `aria-hidden="true"` elements carrying text;
 * - `css_hidden` — `display:none`, `visibility:hidden`, `opacity:0`, `clip`/`clip-path` to nothing, set inline or by a
 *   simple selector (`.class`, `#id`, tag) in the page's `<style>` blocks;
 * - `offscreen` — absolutely / fixed positioned far off the page, or a large negative `text-indent`;
 * - `tiny_font` — `font-size` of 2px / 0.15em / 15% or less;
 * - `same_color` — text colour equal to its own background colour, when both are set on the element or an ancestor
 *   (only inline / `<style>` colours are known: no layout engine);
 * - `comment_instruction` — HTML comments that address a model (every comment is removed; only these are recorded);
 * - `model_instruction` — visible blocks addressed to a model ("ignore previous instructions", "AI assistant: …");
 * - `invisible_chars` — zero-width, bidi-control, soft-hyphen and Unicode tag characters (stripped from the text).
 *
 * The DOM is any WHATWG-like document (linkedom in production).
 */

/** Minimal DOM surface used here (linkedom's types do not line up with lib.dom's). */
interface El {
  tagName: string;
  textContent: string | null;
  parentElement: El | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  remove(): void;
  children: ArrayLike<El>;
  id: string;
  className: string;
}
interface DocLike {
  documentElement: El;
  body: El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
  createTreeWalker?: unknown;
}
interface NodeLike {
  nodeType: number;
  nodeValue: string | null;
  childNodes: ArrayLike<NodeLike>;
  parentNode: { removeChild(n: NodeLike): void } | null;
}

const EXCERPT = 200;
const cut = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > EXCERPT ? `${t.slice(0, EXCERPT)}…` : t;
};

/** Zero-width, bidi controls, word joiners, BOM, soft hyphen, Unicode tag characters. */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

/** Text addressed to a model rather than to a reader. */
const MODEL_INSTRUCTION: RegExp[] = [
  /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b[^.]{0,20}\b(instructions?|prompts?|rules)\b/i,
  /^\W*(note|message|instructions?)\s+(to|for)\s+(the\s+)?(ai|llm|language models?|assistants?|chatbots?|crawlers?)\b/i,
  /^\W*(ai|llm|chatgpt|claude|gemini|copilot|language model)(\s+(assistant|model|agent))?\s*[:：]/i,
  /^\W*(assistant|system)\s*[:：]\s*\S/i,
  /\byou are (an? )?(ai|large language model|language model|llm|chatbot)\b/i,
  /\bif you are (an? )?(ai|llm|language model|assistant|bot)\b/i,
  /(ai|人工智能|大模型|语言模型|智能)\s*助手\s*[，,:：]?\s*请/i,
  /(请|务必)?忽略(之前|以上|前面|先前)的?(所有)?(指令|提示|要求)/,
  /^\W*(人工智能|大模型|语言模型)\s*[:：]/,
];

export function isModelInstruction(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return MODEL_INSTRUCTION.some((r) => r.test(t));
}

function pathOf(el: El): string {
  const parts: string[] = [];
  for (let e: El | null = el, depth = 0; e && depth < 6; e = e.parentElement, depth++) {
    const tag = e.tagName.toLowerCase();
    if (tag === 'html') break;
    const id = e.id ? `#${e.id}` : '';
    const cls = !id && typeof e.className === 'string' && e.className.trim() ? `.${e.className.trim().split(/\s+/)[0]}` : '';
    parts.unshift(`${tag}${id}${cls}`);
  }
  return parts.join(' > ') || 'html';
}

interface Decls {
  [prop: string]: string;
}

function parseDecls(style: string): Decls {
  const out: Decls = {};
  for (const part of style.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim().toLowerCase().replace(/\s*!important$/, '');
  }
  return out;
}

function px(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(-?\d*\.?\d+)(px|em|rem|%|pt)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'em':
    case 'rem':
      return n * 16;
    case '%':
      return (n / 100) * 16;
    case 'pt':
      return n * (4 / 3);
    default:
      return n;
  }
}

function normColor(c: string | undefined): string | null {
  if (!c) return null;
  const v = c.replace(/\s+/g, '').toLowerCase();
  const named: Record<string, string> = { white: '#ffffff', black: '#000000', '#fff': '#ffffff', '#000': '#000000' };
  if (named[v]) return named[v]!;
  const rgb = /^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/.exec(v);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return 'transparent';
    return `#${[rgb[1], rgb[2], rgb[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
  }
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return v;
}

/** Why these declarations hide text, or null. */
function hiddenBy(d: Decls): HiddenContentEvidence['kind'] | null {
  if (d.display === 'none' || d.visibility === 'hidden' || d.visibility === 'collapse') return 'css_hidden';
  if (d.opacity !== undefined && Number(d.opacity) === 0) return 'css_hidden';
  if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(d.clip ?? '') || /inset\(\s*(50|100)%/.test(d['clip-path'] ?? '')) return 'css_hidden';
  if ((d.width === '0' || d.width === '0px' || d.height === '0' || d.height === '0px') && d.overflow === 'hidden') return 'css_hidden';
  const size = px(d['font-size']);
  if (size !== null && size <= 2) return 'tiny_font';
  if (d.position === 'absolute' || d.position === 'fixed') {
    for (const side of ['left', 'top', 'right']) {
      const v = px(d[side]);
      if (v !== null && v <= -500) return 'offscreen';
    }
  }
  const indent = px(d['text-indent']);
  if (indent !== null && indent <= -500) return 'offscreen';
  return null;
}

/** Rules from the page's own `<style>` blocks, for simple selectors only. */
function styleRules(doc: DocLike): Array<{ selector: string; decls: Decls }> {
  const out: Array<{ selector: string; decls: Decls }> = [];
  const styles = Array.from(doc.querySelectorAll('style'));
  for (const s of styles) {
    const css = (s.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const decls = parseDecls(m[2]!);
      for (const sel of m[1]!.split(',').map((x) => x.trim())) {
        if (/^([a-z][a-z0-9-]*)?([.#][A-Za-z_][\w-]*)*$/i.test(sel) && sel) out.push({ selector: sel, decls });
      }
    }
  }
  return out;
}

/**
 * Find hidden content in `doc`, remove it, and return the evidence. Mutates the document: run it before extraction.
 */
export function stripHiddenContent(doc: DocLike): HiddenContentEvidence[] {
  const evidence: HiddenContentEvidence[] = [];
  const root = doc.body ?? doc.documentElement;

  // 1. Comments: all removed; those addressing a model recorded.
  const walk = (node: NodeLike, visit: (n: NodeLike) => void) => {
    for (const child of Array.from(node.childNodes)) {
      visit(child);
      walk(child, visit);
    }
  };
  const comments: NodeLike[] = [];
  walk(doc.documentElement as unknown as NodeLike, (n) => {
    if (n.nodeType === 8) comments.push(n);
  });
  for (const c of comments) {
    const text = c.nodeValue ?? '';
    if (isModelInstruction(text) || /\b(ai|llm|assistant|model|crawler)s?\b.{0,60}\b(must|should|please|recommend)\b/i.test(text)) {
      evidence.push({ kind: 'comment_instruction', location: 'comment', excerpt: cut(text) });
    }
    c.parentNode?.removeChild(c);
  }

  // 2. Elements hidden by attributes or styles (stylesheet rules resolved per element first).
  const sheet = new Map<El, Decls>();
  for (const rule of styleRules(doc)) {
    let matched: El[] = [];
    try {
      matched = Array.from(doc.querySelectorAll(rule.selector));
    } catch {
      continue;
    }
    for (const el of matched) sheet.set(el, { ...(sheet.get(el) ?? {}), ...rule.decls });
  }
  const declsOf = (el: El): Decls => ({ ...(sheet.get(el) ?? {}), ...parseDecls(el.getAttribute('style') ?? '') });
  const colorsOf = (el: El): { color: string | null; background: string | null } => {
    let color: string | null = null;
    let background: string | null = null;
    for (let e: El | null = el; e && (!color || !background); e = e.parentElement) {
      const d = declsOf(e);
      color ??= normColor(d.color);
      background ??= normColor(d['background-color'] ?? (d.background && /^(#|rgb|[a-z]+$)/.test(d.background) ? d.background : undefined));
    }
    return { color, background };
  };

  const toRemove: Array<{ el: El; kind: HiddenContentEvidence['kind'] }> = [];
  const elements = Array.from(doc.querySelectorAll('body *'));
  const removed = new Set<El>();
  const insideRemoved = (el: El) => {
    for (let e: El | null = el.parentElement; e; e = e.parentElement) if (removed.has(e)) return true;
    return false;
  };
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue;
    const text = (el.textContent ?? '').trim();
    if (!text) continue;
    let kind: HiddenContentEvidence['kind'] | null = null;
    if (el.hasAttribute('hidden')) kind = 'hidden_attribute';
    else if ((el.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true') kind = 'aria_hidden';
    else {
      const d = declsOf(el);
      kind = hiddenBy(d);
      if (!kind && (d.color || d['background-color'] || d.background)) {
        const { color, background } = colorsOf(el);
        if (color && background && color === background) kind = 'same_color';
      }
    }
    if (kind) {
      removed.add(el);
      if (!insideRemoved(el)) toRemove.push({ el, kind });
    }
  }
  for (const { el, kind } of toRemove) {
    evidence.push({ kind, location: pathOf(el), excerpt: cut(el.textContent ?? '') });
    el.remove();
  }

  // 3. Visible blocks addressed to a model.
  const blocks = Array.from(doc.querySelectorAll('body p, body li, body div, body span, body blockquote, body h1, body h2, body h3, body h4, body h5, body h6, body td, body small'));
  for (const el of blocks) {
    const text = el.textContent ?? '';
    if (text.length > 600 || !el.parentElement) continue;
    // Leaf-ish blocks only: a container is judged by its children.
    const childBlocks = Array.from(el.children).some((c) => /^(p|div|li|ul|ol|blockquote|section|article|table)$/i.test(c.tagName));
    if (childBlocks) continue;
    if (isModelInstruction(text.replace(INVISIBLE, ''))) {
      evidence.push({ kind: 'model_instruction', location: pathOf(el), excerpt: cut(text) });
      el.remove();
    }
  }

  // 4. Invisible characters in the remaining text.
  const textNodes: NodeLike[] = [];
  walk(root as unknown as NodeLike, (n) => {
    if (n.nodeType === 3) textNodes.push(n);
  });
  let invisibleCount = 0;
  const codes = new Set<string>();
  for (const n of textNodes) {
    const v = n.nodeValue ?? '';
    const found = v.match(INVISIBLE);
    if (!found) continue;
    invisibleCount += found.length;
    for (const ch of found) codes.add(`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    n.nodeValue = v.replace(INVISIBLE, '');
  }
  // Tag characters can spell out a hidden message: record it decoded.
  if (invisibleCount) evidence.push({ kind: 'invisible_chars', location: 'text', excerpt: cut(`${invisibleCount} characters: ${[...codes].join(' ')}`) });
  return evidence;
}

/** Strip invisible characters from a string (titles, metadata). */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, '');
}
