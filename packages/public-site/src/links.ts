import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

/**
 * The links and anchors of sanitised rich text (HeoPress P07 tasks 5.1, 5.3; spec seo/link-graph): what the link graph
 * records of a page and what the audit checks a fragment against. Pure: the HTML is the projection's sanitised rich text.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const isElement = (n: Node): n is Element => 'tagName' in n;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? null;

export interface FoundLink {
  /** The `href` as written. */
  href: string;
  /** Absolute, without its fragment. */
  url: string;
  /** The fragment, decoded, without `#`; null when none (or empty). */
  fragment: string | null;
  /** The link's text, whitespace collapsed. */
  text: string;
  /** Its place among the links found (0-based). */
  position: number;
}

function textOf(n: Node): string {
  if (n.nodeName === '#text') return (n as DefaultTreeAdapterMap['textNode']).value;
  return isElement(n) ? n.childNodes.map(textOf).join('') : '';
}

function walk(nodes: Node[], visit: (el: Element) => void): void {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    visit(n);
    walk(n.childNodes, visit);
  }
}

function decodedFragment(hash: string): string | null {
  if (hash.length <= 1) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}

/** The `http(s)` links of `html` (`<a href>`), absolute against `base`; others (mail, scripts, unparsable) are left out. */
export function linksOf(html: string, base: string): FoundLink[] {
  const out: FoundLink[] = [];
  walk(parseFragment(html).childNodes as Node[], (el) => {
    if (el.tagName !== 'a') return;
    const href = attr(el, 'href')?.trim();
    if (!href) return;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    const fragment = decodedFragment(u.hash);
    u.hash = '';
    out.push({ href, url: u.toString(), fragment, text: textOf(el).replace(/\s+/g, ' ').trim(), position: out.length });
  });
  return out;
}

/** The anchors a fragment can name in `html`: every `id`, and the `name` of an `<a>`. */
export function anchorsOf(html: string): Set<string> {
  const out = new Set<string>();
  walk(parseFragment(html).childNodes as Node[], (el) => {
    const id = attr(el, 'id');
    if (id) out.add(id);
    const name = el.tagName === 'a' ? attr(el, 'name') : null;
    if (name) out.add(name);
  });
  return out;
}
