/**
 * @heopress/astro-kit (HeoPress P11 task 3.6; spec rendering/astro-engine "主题为标准 Astro 组件包"; Apache-2.0, ADR-0008).
 *
 * An Astro theme is a standard Astro component package whose entry component receives one page of the page data
 * contract as its `page` prop. Its data comes from that prop only (no fetch, no environment, no CMS interface); the
 * system's own content is placed with this kit's components, which output it exactly as the Classic engine does:
 *
 *   - `SeoHead` in `<head>`: title, description, canonical, robots, hreflang, feeds, Markdown copy and the one JSON-LD graph;
 *   - `ItemBody` on an item page: the sanitised body (`rel="sponsored"` already applied when the site asks for it);
 *   - `SponsorDisclosure` before a sponsored item's body and inside a sponsored card;
 *   - `Card` around each card of a list (every link to a sponsored item stays inside its card).
 *
 * The build checks the output: a sponsored page without its disclosure, or a link to a sponsored item outside its card,
 * fails the build when the site has disclosure on (the previous version keeps being served).
 */
export type { PageDataPage, PageDataSnapshot } from '@heopress/contracts/page-data';
export type { ThemeCard, ThemeItem, ThemeViewModel } from '@heopress/contracts/theme';

/** The disclosure text of item `id` on this page, when the site requires one and the item is sponsored. */
export function disclosureOf(page: { disclosureRequired: boolean; disclosures: Record<string, string> }, id: string): string | null {
  if (!page.disclosureRequired) return null;
  return page.disclosures[id] ?? null;
}

/** A URL a theme may put in `href`/`src` (the Classic `url` filter's rule): anything else becomes `#`. */
export function safeUrl(value: unknown): string {
  const s = String(value ?? '').trim();
  const n = s.replace(/[\t\n\r]/g, '');
  if (n === '') return '#';
  if (/^(https?:|mailto:)/i.test(n)) return s;
  if (/^[/\\]/.test(n)) return /^[/\\][/\\]/.test(n) ? '#' : s;
  if (/^[?#]/.test(n)) return s;
  return /^[^/?#\\]*:/.test(n) ? '#' : s;
}
