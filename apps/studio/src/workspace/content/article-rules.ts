/** The article editor's pure rules (HeoPress P07a tasks 6.1, 6.4). */

export interface Heading {
  level: 2 | 3;
  text: string;
  index: number;
}

/** H2 / H3 of rich text, in order. */
export function outlineOf(html: string): Heading[] {
  const out: Heading[] = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll('h2, h3').forEach((el, index) => {
    const text = (el.textContent ?? '').trim();
    if (text) out.push({ level: el.tagName === 'H2' ? 2 : 3, text, index });
  });
  return out;
}

/** Description length hint (spec "描述过短"): under 80 short, over 160 long. */
export function descriptionHint(text: string): 'short' | 'long' | 'ok' {
  const n = [...text.trim()].length;
  return n < 80 ? 'short' : n > 160 ? 'long' : 'ok';
}

/** Same rule as the server's `isArticleCollection` (design §20). */
export function isArticleCollection(name: string, meta: unknown): boolean {
  const m = (meta && typeof meta === 'object' ? meta : {}) as { preset?: { key?: unknown }; studio?: { kind?: unknown } };
  if (m.studio?.kind === 'article') return true;
  return name === 'articles' && m.preset?.key === 'articles';
}
