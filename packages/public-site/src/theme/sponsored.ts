import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';

/**
 * `rel="sponsored"` on the external links of a sponsored item's body (HeoPress P06 task 2.7; ADR-0016;
 * spec "赞助披露与链接属性"): applied by the renderer to the sanitised body before it replaces the body
 * placeholder, so a theme cannot remove it. A link is external when it is absolute (http, https or
 * protocol-relative) and its host is none of the site's own hosts.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

/** Stands for the page's own host when resolving relative links (they stay on the site). */
const PAGE_HOST = 'page.heopress.invalid';

export function withSponsoredRel(html: string, ownHosts: readonly string[]): string {
  const own = new Set(ownHosts.map((h) => h.toLowerCase()));
  const fragment = parseFragment(html) as unknown as { childNodes: Node[] };
  const visit = (n: Node) => {
    if ('tagName' in n) {
      const el = n as Element;
      if (el.tagName === 'a' || el.tagName === 'area') {
        const href = el.attrs.find((a) => a.name === 'href')?.value;
        // Parsed as a browser parses it (the WHATWG URL rules drop tabs and newlines, trim controls): what
        // the browser navigates to decides, not how the attribute is spelled.
        let host: string | null = null;
        if (href !== undefined) {
          try {
            const u = new URL(href, `https://${PAGE_HOST}/`);
            if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== PAGE_HOST) host = u.hostname.toLowerCase();
          } catch {
            host = null;
          }
        }
        if (host && !own.has(host)) {
          const rel = el.attrs.find((a) => a.name === 'rel');
          const tokens = new Set((rel?.value ?? '').split(/\s+/).filter(Boolean));
          tokens.add('sponsored');
          if (rel) rel.value = [...tokens].join(' ');
          else el.attrs.push({ name: 'rel', value: [...tokens].join(' ') });
        }
      }
    }
    for (const c of ('childNodes' in n ? (n.childNodes as Node[]) : [])) visit(c);
  };
  for (const c of fragment.childNodes) visit(c);
  return serialize(fragment as never);
}
