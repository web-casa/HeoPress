import type { ThemeCard, ThemeFieldValue, ThemeItem, ThemePageType, ThemeViewModel } from '@heopress/contracts/theme';
import { defaultSeoSettings, sameLocale, type SiteIdentity, type SiteSeoSettings } from '@heopress/contracts/schemas';
import {
  absoluteUrl,
  decideIndexing,
  materializedNodes,
  pageHead,
  pageTypeOfCollection,
  structuredData,
  type DiscoveryPage,
  type IndexingResult,
  type MaterializedNode,
  type PageHead,
} from '@heopress/seo-geo';
import { plainFieldOf, withSponsoredRel, type SystemContent } from '@heopress/public-site';
import type { PublicExtensionRoute, PublicExtensions } from '@heopress/contracts/extensions';
import { escapeHtml } from './html';
import { markdownUrlOf } from './discovery';
import type { PublicItemRow } from './read-port';

/**
 * Page data for the theme (HeoPress P06 task 2.1): the View Model a template sees, built from the public
 * projection only, and the system content the post-processing puts in place of the system tags
 * (sanitised bodies, disclosure texts). Markup is never part of the View Model.
 */

export interface SiteInfo {
  name: string;
  defaultLanguage: string;
  settings: Record<string, unknown>;
  /** The public part of the site's SEO / GEO settings (P07 task 1.4): templates, indexing defaults, snippet directives. */
  seo?: SiteSeoSettings;
  /** Whom the site speaks for (P07 task 2.12): its structured data's identity node; null or absent when none is set. */
  identity?: SiteIdentity | null;
  /** The site's own origin (`https://<primary host>/`): where its identity hangs in every language. */
  origin?: string | null;
  /** The site nodes its extensions contribute to the structured data (P07 task 2.9), as the projection materialised them. */
  contributed?: MaterializedNode[];
  /** The routes, templates and components of the site's enabled plugins (P12 tasks 2.3–2.5). */
  extensions?: PublicExtensions;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A field as plain text (shared with the CMS's audit, P07 task 5.1: what the head says is compared there). */
const plainOf = plainFieldOf;

export function titleOf(row: Pick<PublicItemRow, 'data'>): string {
  return str(row.data.title) || str(row.data.name) || str(row.data.slug);
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * An item's explicit questions and answers: what the projection took from the preset's own `faq` field (by its preset
 * key; a site field that merely shares the name is not read).
 */
function faqOf(row: PublicItemRow | null): Array<{ question: string; answer: string }> {
  const rows = (row?.structured as { faq?: unknown } | undefined)?.faq;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const q = (r as Record<string, unknown> | null)?.question;
    const a = (r as Record<string, unknown> | null)?.answer;
    return typeof q === 'string' && typeof a === 'string' ? [{ question: q, answer: a }] : [];
  });
}

/** The nodes the projection materialised for the item's page: its own structured data and its extensions' (task 2.9). */
function contributedOf(row: PublicItemRow | null): MaterializedNode[] {
  return materializedNodes((row?.structured as { nodes?: unknown } | undefined)?.nodes);
}

function safeResolve(ref: string, base: string): string | null {
  try {
    return new URL(ref, base).toString();
  } catch {
    return null;
  }
}
const urlOf = (row: PublicItemRow): string => str((row.card as { url?: unknown }).url);

function toItem(row: PublicItemRow): ThemeItem {
  const fields: Record<string, ThemeFieldValue> = {};
  for (const [k, v] of Object.entries(row.data)) if (!row.richFields.includes(k)) fields[k] = v as ThemeFieldValue;
  return {
    id: row.itemId,
    collection: row.collection,
    title: titleOf(row),
    url: urlOf(row),
    locale: row.locale,
    publishedAt: iso(row.publishedAt),
    fields,
    sponsor: { sponsored: row.sponsored, name: row.sponsored ? row.sponsorName : null },
  };
}

function toCard(row: PublicItemRow): ThemeCard {
  return { id: row.itemId, title: titleOf(row), excerpt: str(row.data.excerpt), url: urlOf(row), publishedAt: iso(row.publishedAt), sponsored: row.sponsored };
}

/** A field as HTML: sanitised rich text as is (the projection lists it), anything else escaped. */
export function bodyHtml(row: PublicItemRow): string {
  const value = str(row.data.body);
  if (!value) return '';
  if (row.richFields.includes('body')) return value;
  return value
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export interface PageInput {
  type: ThemePageType;
  site: SiteInfo;
  locale: string;
  path: string;
  status: number;
  homeUrl: string;
  query?: string | null;
  item?: PublicItemRow | null;
  list?: PublicItemRow[];
  pagination?: { page: number; prevUrl: string | null; nextUrl: string | null } | null;
  alternates?: Array<{ locale: string; url: string }>;
  canonical?: string | null;
  /** The site's own hosts: a sponsored body's links elsewhere get rel="sponsored" when the site asks for it. */
  ownHosts?: string[];
  /** An item page's public category (its `primary_category`) and author: its breadcrumb and its article's author (P07 task 2.4). */
  related?: { category?: PublicItemRow | null; author?: PublicItemRow | null };
  /** The page's Markdown copy address is a real route's (P07 task 4.2): no copy declared. */
  markdownTaken?: boolean;
  /** The plugin route this page is (P12 task 2.3): rendered with its template (the theme's version first). */
  route?: PublicExtensionRoute | null;
}

/**
 * A list page's own address (spec seo/page-metadata "列表页收录规则"): page N of a list is canonical to itself,
 * never to the first page.
 */
export function pagedUrl(url: string | null | undefined, pageNo: number): string | null {
  if (!url) return null;
  return pageNo > 1 ? `${url}?page=${pageNo}` : url;
}

/**
 * A language home's canonical: the language's own address (`homeUrl`, on the site's canonical host), not the entry
 * host that answered (a language-entry domain answers it but is not its address); the resolved URL when the
 * language has no absolute address.
 */
export function homeCanonical(homeUrl: string, resolvedUrl: string | null | undefined, pageNo: number): string | null {
  return pagedUrl(/^https:\/\//.test(homeUrl) ? homeUrl : resolvedUrl, pageNo);
}

/**
 * The page's head (HeoPress P07 tasks 1.2, 2.1, 2.3, 2.8, 2.11), from `@heopress/seo-geo`: the indexing decision
 * from the site's SEO snapshot and the item's own setting, the templates, the absolute canonical.
 */
/**
 * `opts.jsonLd: false` (the discovery outputs, which read the indexing, description, canonical and alternates only):
 * the structured data is not built.
 */
export function pageHeadOf(p: PageInput, opts: { jsonLd?: boolean } = {}): PageHead {
  const settings = p.site.seo ?? defaultSeoSettings();
  const row = p.item ?? null;
  const data = row?.data ?? {};
  const indexing = indexingOf(p.site, p.type, row);
  const canonical = p.canonical ?? null;
  // The language's home, absolute: the root of the graph's identifiers (a relative home resolves against the page).
  const home = absoluteUrl(p.homeUrl) ?? (canonical ? absoluteUrl(safeResolve(p.homeUrl, canonical)) : null);
  const description = row ? plainOf(row, 'seo_description') || plainOf(row, 'excerpt') || plainOf(row, 'description') : null;
  const image = str((row?.card as { image?: unknown } | undefined)?.image) || null;
  const crumbOf = (r: PublicItemRow | null | undefined) => (r && urlOf(r) ? { name: titleOf(r), url: urlOf(r) } : null);
  const breadcrumb =
    row && canonical && home && (p.type === 'item' || p.type === 'taxonomy')
      ? [{ name: p.site.name, url: home }, ...(p.type === 'item' && crumbOf(p.related?.category) ? [crumbOf(p.related?.category)!] : []), { name: titleOf(row), url: canonical }]
      : [];
  // A page canonical to another address is a declared duplicate: like a page not indexed, its graph describes the site only.
  const override = absoluteUrl(data.canonical_url);
  const duplicate = !!override && !!canonical && override !== absoluteUrl(canonical);
  const jsonLd = opts.jsonLd === false ? null : structuredData({
    pageType: p.type,
    indexing,
    siteName: p.site.name,
    homeUrl: home,
    siteOrigin: p.site.origin ?? null,
    locale: p.locale,
    identity: p.site.identity ?? null,
    siteType: typeof p.site.settings.siteType === 'string' ? p.site.settings.siteType : null,
    page:
      p.type === 'home'
        ? { url: canonical ?? home ?? '', title: p.site.name }
        : p.route?.kind === 'list' && canonical
          ? { url: canonical, title: p.route.title, collection: p.route.collection }
        : row && canonical && !duplicate
          ? { url: canonical, title: titleOf(row), description, image, publishedAt: iso(row.publishedAt), modifiedAt: iso(row.contentModifiedAt), collection: row.collection }
          : null,
    breadcrumb,
    author: p.related?.author ? { name: titleOf(p.related.author), url: urlOf(p.related.author) || null } : null,
    faq: faqOf(row),
    // The final check decides what of them this page carries (P07 task 2.10).
    contributed: [...contributedOf(row), ...(p.site.contributed ?? [])],
  });
  return pageHead({
    jsonLd,
    settings,
    siteName: p.site.name,
    pageType: p.type,
    locale: p.locale,
    url: p.canonical ?? null,
    title: row ? titleOf(row) : p.route?.kind === 'list' ? p.route.title : p.type === 'search' && p.query ? p.query : p.type === 'error' ? String(p.status) : '',
    seoTitle: data.seo_title,
    description,
    canonicalUrl: data.canonical_url,
    image,
    publishedAt: row ? iso(row.publishedAt) : null,
    // The real content time (P07 task 2.5): a re-render or a theme change never moves it.
    modifiedAt: row ? iso(row.contentModifiedAt) : null,
    indexing,
    // hreflang only on an indexable page (P07 task 2.2): the projection lists indexable members only, x-default included.
    alternates: indexing.indexable ? (p.alternates ?? []) : [],
    feeds: feedsOf(p.site, p.locale, home),
    // An article's or page's Markdown copy (P07 task 4.2): `pageHead` declares it only when the page is indexable and
    // canonical to itself.
    markdown: row && p.type === 'item' && p.canonical && !p.markdownTaken ? markdownUrlOf(p.canonical) : null,
  });
}

/**
 * The page's language feeds (P07 task 3.3): on the host of the language's home, `/feed.xml` and `/atom.xml` for the
 * site's default language, `/feed.<locale>.xml` and `/atom.<locale>.xml` for another (`discovery-plan.ts`).
 */
function feedsOf(site: SiteInfo, locale: string, home: string | null): Array<{ type: 'rss' | 'atom'; url: string; title: string }> {
  if (!home) return [];
  const origin = new URL(home).origin;
  const suffix = sameLocale(locale, site.defaultLanguage) ? '' : `.${locale}`;
  return [
    { type: 'rss', url: `${origin}/feed${suffix}.xml`, title: site.name },
    { type: 'atom', url: `${origin}/atom${suffix}.xml`, title: site.name },
  ];
}

/** The one indexing decision of a page (P07 tasks 2.3, 2.6): its head and every discovery output ask this. */
function indexingOf(site: SiteInfo, type: ThemePageType, row: PublicItemRow | null): IndexingResult {
  return decideIndexing({ settings: site.seo ?? defaultSeoSettings(), pageType: type, collection: row?.collection ?? null, itemRobots: row?.seoRobots });
}

/**
 * An item page as the discovery outputs see it (P07 task 2.6; spec seo/page-metadata "统一收录资格"): the same indexing
 * decision and the same description as its head, the published snapshot's real content time (task 2.5), and its
 * indexable language alternates (the projection lists those only). The sitemap, the feeds and `llms.txt` take their
 * entries from this through `@heopress/seo-geo` (`sitemapEntry`, `feedEntry`, `llmsEntry`): none for a page that is not indexable.
 */
export function discoveryPageOf(site: SiteInfo, row: PublicItemRow, alternates: Array<{ locale: string; url: string }> = []): DiscoveryPage {
  const page: PageInput = { type: pageTypeOfCollection(row.collection), site, locale: row.locale, path: row.path, status: 200, homeUrl: '', item: row, canonical: urlOf(row) || null, alternates };
  const head = pageHeadOf(page, { jsonLd: false });
  return {
    url: urlOf(row),
    title: titleOf(row),
    description: head.description,
    publishedAt: iso(row.publishedAt),
    modifiedAt: iso(row.contentModifiedAt),
    indexing: indexingOf(site, page.type, row),
    canonical: head.canonical,
    alternates: head.alternates,
  };
}

export function buildPage(p: PageInput): { vm: ThemeViewModel; system: SystemContent } {
  const item = p.item ? toItem(p.item) : null;
  const list = (p.list ?? []).map(toCard);
  const locales = Array.isArray(p.site.settings.availableLocales) ? (p.site.settings.availableLocales as string[]) : [p.site.defaultLanguage];
  const head = pageHeadOf(p);
  const vm: ThemeViewModel = {
    site: { name: p.site.name, locale: p.locale, locales, homeUrl: p.homeUrl },
    page: { type: p.type, locale: p.locale, path: p.path, status: p.status, query: p.query ?? null },
    item,
    list,
    pagination: p.pagination ?? null,
    // The theme's language switch: the languages, not the x-default entry.
    alternates: (p.alternates ?? []).filter((a) => a.locale !== 'x-default'),
    nav: [{ label: p.site.name, url: p.homeUrl }],
    seo: { title: head.title, description: head.description, canonical: head.canonical, robots: head.robots },
    route: p.route ? { namespace: p.route.namespace, id: p.route.id, kind: p.route.kind, template: p.route.template, title: p.route.title } : null,
  };
  const disclosures: Record<string, string> = {};
  if (p.item?.sponsored) disclosures[p.item.itemId] = p.item.sponsorName ? `Sponsored by ${p.item.sponsorName}` : 'Sponsored';
  for (const row of p.list ?? []) if (row.sponsored) disclosures[row.itemId] = row.sponsorName ? `Sponsored by ${row.sponsorName}` : 'Sponsored';
  const system: SystemContent = {
    bodies: p.item
      ? { [p.item.itemId]: p.item.sponsored && p.site.settings.sponsorRel === true ? withSponsoredRel(bodyHtml(p.item), p.ownHosts ?? []) : bodyHtml(p.item) }
      : {},
    disclosureRequired: p.site.settings.sponsorDisclosure === true,
    disclosures,
    head,
  };
  return { vm, system };
}
