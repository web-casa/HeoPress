import type { SiteIdentity } from '@heopress/contracts/schemas';
import { absoluteUrl } from './head.ts';
import type { IndexingResult, SeoPageType } from './indexing.ts';
import { ARTICLE_TYPES as ARTICLE_KIND, CORE_PAGE_FRAGMENTS, RESERVED_TYPES, typesOf, type MaterializedNode, type StructuredDataDiagnostic } from './contributions.ts';

/**
 * A page's structured data (HeoPress P07 tasks 2.4, 2.12; spec seo/page-metadata "结构化数据规则", "关联结构化数据图",
 * "站点身份"): one JSON-LD graph whose nodes refer to each other by stable `@id`s — the site's identity, the WebSite, the
 * WebPage, its breadcrumb and its article. Built only from what the site and the page say: a field nobody filled in is
 * left out, never made up. A page that is not indexable describes only the site (its identity and the WebSite).
 * Contributed nodes (the item's own, extensions', task 2.9) are merged last, through the final check (task 2.10).
 */

export type JsonLdNode = Record<string, unknown> & { '@type': string; '@id': string };

export interface JsonLdGraph {
  '@context': 'https://schema.org';
  '@graph': JsonLdNode[];
}

export interface StructuredDataPage {
  /** The page's own absolute address (its canonical). */
  url: string;
  title: string;
  description?: string | null;
  image?: string | null;
  publishedAt?: string | null;
  modifiedAt?: string | null;
  /** The item's collection (item pages): `articles` gets an article node. */
  collection?: string | null;
}

export interface StructuredDataInput {
  pageType: SeoPageType;
  indexing: IndexingResult;
  siteName: string;
  /** The site's home in the page's language, absolute: where the WebSite hangs. */
  homeUrl: string | null;
  /**
   * The site's own origin (its primary host, `https://example.com/`): where the one identity of every language hangs,
   * also under a language subdomain or domain. Absent: the home's origin.
   */
  siteOrigin?: string | null;
  locale: string;
  identity: SiteIdentity | null;
  /** The site's type (content settings): `news` → NewsArticle, `blog` → BlogPosting, otherwise Article. */
  siteType?: string | null;
  page?: StructuredDataPage | null;
  /** From the home to the page itself, in order (two or more entries make a BreadcrumbList). */
  breadcrumb?: Array<{ name: string; url: string }>;
  /** The article's author, when the item names a public one. */
  author?: { name: string; url?: string | null } | null;
  /**
   * The page's explicit questions and answers (the preset's `faq` field, task 2.4): the only source of a FAQPage —
   * never inferred from headings or text ending in a question mark.
   */
  faq?: Array<{ question: string; answer: string }>;
  /**
   * Contributed nodes, as the projection materialised them (`contributions.ts`): the site's (extensions' site nodes)
   * and the page's (the item's own structured data, extensions' item nodes). Their owner and identifier are the
   * core's; the final check decides which of them, and which of their properties, this page carries.
   */
  contributed?: MaterializedNode[];
  /**
   * Every host of the site (its domains, language domains included; the CMS's check of the site nodes): a site node's
   * reference to a node on any of them is a reference into the site — to its identity or its site nodes only.
   */
  siteHosts?: string[];
}

/** At most this many bytes of the page's own contributed nodes on one page, and as many of the site's; the rest is left out. */
const MAX_CONTRIBUTED_BYTES = 65_536;

/** At most this many questions in a FAQPage. */
const MAX_FAQ = 50;

const IDENTITY_TYPES: Record<SiteIdentity['kind'], string> = { organization: 'Organization', person: 'Person', local_business: 'LocalBusiness' };

/** Only the fields that hold something: an empty value is left out, not written as empty. */
function filled<T extends Record<string, unknown>>(node: T): T {
  return Object.fromEntries(
    Object.entries(node).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)),
  ) as T;
}

/** The site's identity node: Organization, Person or LocalBusiness, from what the site filled in. */
/** `origin`: the site's absolute root (`https://example.com/`), where the identity's `@id` hangs. */
export function identityNode(identity: SiteIdentity, origin: string): JsonLdNode {
  const root = origin;
  const type = IDENTITY_TYPES[identity.kind];
  const logo = absoluteUrl(identity.logo);
  const address = filled({ '@type': 'PostalAddress', ...identity.address });
  return filled({
    '@type': type,
    '@id': `${root}#identity`,
    name: identity.name,
    // The site is the identity's own address (a fact, not a guess); a person's picture is an image, not a logo.
    url: root,
    ...(identity.kind === 'person' ? { image: logo } : { logo: logo ? { '@type': 'ImageObject', url: logo } : null }),
    email: identity.email,
    telephone: identity.telephone,
    address: Object.keys(address).length > 1 ? address : null,
    sameAs: identity.sameAs,
  }) as JsonLdNode;
}

const ARTICLE_TYPES: Record<string, string> = { news: 'NewsArticle', blog: 'BlogPosting' };

export function structuredData(input: StructuredDataInput): JsonLdGraph | null {
  return structuredDataReport(input).graph;
}

/**
 * The page's graph, what the final check removed from what was contributed (its diagnostics), and the contributed
 * entries it kept (in order: the projection stores those only).
 */
export function structuredDataReport(input: StructuredDataInput): { graph: JsonLdGraph | null; diagnostics: StructuredDataDiagnostic[]; kept: MaterializedNode[] } {
  const diagnostics: StructuredDataDiagnostic[] = [];
  const kept: MaterializedNode[] = [];
  const graph = coreGraph(input, diagnostics, kept);
  return { graph, diagnostics, kept };
}


function coreGraph(input: StructuredDataInput, diagnostics: StructuredDataDiagnostic[], kept: MaterializedNode[]): JsonLdGraph | null {
  const root = absoluteUrl(input.homeUrl);
  // No absolute home: no stable identifiers to hang a graph from.
  if (!root) return null;
  const nodes: JsonLdNode[] = [];
  // One identity for every language of the site: it hangs from the origin, the WebSite from the language's home.
  const origin = new URL('/', absoluteUrl(input.siteOrigin) ?? root).toString();
  const identityId = input.identity ? `${origin}#identity` : null;
  if (input.identity) nodes.push(identityNode(input.identity, origin));
  const websiteId = `${root}#website`;
  nodes.push(
    filled({
      '@type': 'WebSite',
      '@id': websiteId,
      url: root,
      name: input.siteName,
      inLanguage: input.locale,
      publisher: identityId ? { '@id': identityId } : null,
    }) as JsonLdNode,
  );
  // Not indexable: the site only (spec "不可收录页面").
  const page = input.page;
  const url = page ? absoluteUrl(page.url) : null;
  if (!input.indexing.indexable || !page || !url || input.pageType === 'search' || input.pageType === 'error') {
    // The final check (spec "贡献方夹带正文", "不可收录页面"): nothing contributed is carried by a page that is not indexable.
    for (const n of input.contributed ?? []) diagnostics.push({ code: 'ineligible-node', source: n.source, node: n.fragment, message: `#${n.fragment} is not output: the page is not indexable` });
    return { '@context': 'https://schema.org', '@graph': nodes };
  }

  const webPageId = `${url}#webpage`;
  const crumbs = (input.breadcrumb ?? []).map((c) => ({ name: c.name, url: absoluteUrl(c.url) })).filter((c): c is { name: string; url: string } => !!c.name && !!c.url);
  const breadcrumbId = crumbs.length >= 2 ? `${url}#breadcrumb` : null;
  const image = absoluteUrl(page.image);
  // The page's primary image: one node, referred to by the page and its article.
  const imageId = image ? `${url}#primaryimage` : null;
  const isItem = input.pageType === 'item';
  nodes.push(
    filled({
      '@type': input.pageType === 'taxonomy' ? 'CollectionPage' : 'WebPage',
      '@id': webPageId,
      url,
      name: page.title,
      description: page.description,
      isPartOf: { '@id': websiteId },
      inLanguage: input.locale,
      breadcrumb: breadcrumbId ? { '@id': breadcrumbId } : null,
      primaryImageOfPage: imageId ? { '@id': imageId } : null,
      datePublished: isItem ? page.publishedAt : null,
      dateModified: isItem ? page.modifiedAt : null,
      about: input.pageType === 'home' && identityId ? { '@id': identityId } : null,
    }) as JsonLdNode,
  );
  if (imageId) nodes.push({ '@type': 'ImageObject', '@id': imageId, url: image!, contentUrl: image! });
  if (breadcrumbId) {
    nodes.push({
      '@type': 'BreadcrumbList',
      '@id': breadcrumbId,
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })),
    });
  }
  if (isItem && page.collection === 'articles') {
    const authorUrl = absoluteUrl(input.author?.url);
    const author = input.author?.name
      ? filled({ '@type': 'Person', name: input.author.name, url: authorUrl })
      : // A personal site's articles are its person's, unless an author says otherwise.
        input.identity?.kind === 'person' && identityId
        ? { '@id': identityId }
        : null;
    nodes.push(
      filled({
        '@type': ARTICLE_TYPES[input.siteType ?? ''] ?? 'Article',
        '@id': `${url}#article`,
        headline: page.title.length > 110 ? `${page.title.slice(0, 109)}…` : page.title,
        description: page.description,
        image: imageId ? { '@id': imageId } : null,
        datePublished: page.publishedAt,
        dateModified: page.modifiedAt,
        author,
        publisher: identityId ? { '@id': identityId } : null,
        mainEntityOfPage: { '@id': webPageId },
        inLanguage: input.locale,
      }) as JsonLdNode,
    );
  }
  const faq = (input.faq ?? [])
    .map((q) => ({ question: (q.question ?? '').replace(/\s+/g, ' ').trim(), answer: (q.answer ?? '').trim() }))
    .filter((q) => q.question && q.answer)
    .slice(0, MAX_FAQ);
  if (faq.length && isItem) {
    nodes.push({
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      isPartOf: { '@id': webPageId },
      inLanguage: input.locale,
      mainEntity: faq.map((q) => ({ '@type': 'Question', name: q.question, acceptedAnswer: { '@type': 'Answer', text: q.answer } })),
    });
  }
  mergeContributed(nodes, input.contributed ?? [], { url, origin, root, webPageId, siteHosts: input.siteHosts ?? [] }, diagnostics, kept);
  return { '@context': 'https://schema.org', '@graph': nodes };
}

const isRef = (v: unknown): v is { '@id': string } => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { '@id'?: unknown })['@id'] === 'string';

/** Every reference inside a value, made absolute against `base` (`#name` → `<base>#name`). */
function absoluteRefs(value: unknown, base: string): unknown {
  if (isRef(value)) return value['@id'].startsWith('#') ? { '@id': `${base}${value['@id']}` } : value;
  if (Array.isArray(value)) return value.map((v) => absoluteRefs(v, base));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, absoluteRefs(v, base)]));
  return value;
}

/** The value without its references that `dangling` says go nowhere; `undefined` when nothing is left. */
function withoutDangling(value: unknown, dangling: (id: string) => boolean, removed: string[]): unknown {
  if (isRef(value)) {
    if (!dangling(value['@id'])) return value;
    removed.push(value['@id']);
    return undefined;
  }
  if (Array.isArray(value)) {
    const out = value.map((v) => withoutDangling(v, dangling, removed)).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).flatMap(([k, v]) => {
      const w = withoutDangling(v, dangling, removed);
      return w === undefined ? [] : [[k, w] as const];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

/**
 * The final check (P07 task 2.10; spec "关联结构化数据图"), run when everything is merged: the core decides each
 * contributed node's identifier (a fragment of the page's address, or of the site's origin for a site node) and
 * owner; a site node carries no item's values; a node of a type only the core writes (a page, the site, a
 * breadcrumb, or one the page already has: its article), a node whose identifier is taken, and what is past the size
 * limit are left out; references to nodes that are not in the graph are removed. Each removal leaves a diagnostic.
 * The page refers to its own contributed nodes (`about`).
 */
function mergeContributed(
  nodes: JsonLdNode[],
  contributed: MaterializedNode[],
  at: { url: string; origin: string; root: string; webPageId: string; siteHosts: string[] },
  diagnostics: StructuredDataDiagnostic[],
  kept: MaterializedNode[],
): void {
  if (contributed.length === 0) return;
  const taken = new Set(nodes.map((n) => n['@id']));
  // Types the page already has a node of (its article, its FAQ): a second one is a conflict. The identity and the
  // primary image are not "the page's kind" of node — a contributed Organization or ImageObject is its own node.
  const coreTypes = new Set(nodes.filter((n) => !n['@id'].endsWith('#identity') && !n['@id'].endsWith('#primaryimage')).map((n) => n['@type']));
  // One article per page: the core's, or else the first contributed one.
  let hasArticle = [...coreTypes].some((t) => ARTICLE_KIND.has(t));
  const removedIds = new Set<string>();
  const added: Array<{ full: JsonLdNode; from: MaterializedNode }> = [];
  const about: Array<{ '@id': string }> = [];
  // One budget for the page's own nodes and one for the site's: each is checked where it is materialised (the item, the
  // site), so what the projection stores and reports is what the page outputs (Codex review of batch 5c).
  const budget = { page: MAX_CONTRIBUTED_BYTES, site: MAX_CONTRIBUTED_BYTES };
  for (const c of contributed) {
    const base = c.owner === 'site' ? at.origin : at.url;
    const id = `${base}#${c.fragment}`;
    const label = `#${c.fragment}`;
    // A site node's identifier is one the core gave an extension's site contribution, never one of the page's.
    // A node left out takes its references with it — unless an earlier node holds that identifier (a duplicate).
    const leftOut = () => {
      if (!taken.has(id)) removedIds.add(id);
    };
    if (c.owner === 'site' ? !c.fragment.startsWith('ext-') : (CORE_PAGE_FRAGMENTS as readonly string[]).includes(c.fragment)) {
      diagnostics.push({ code: 'id-conflict', source: c.source, node: c.fragment, message: `${label} is the system's: left out` });
      leftOut();
      continue;
    }
    const node: Record<string, unknown> = { ...c.node };
    const types = typesOf(node);
    if (!types) {
      diagnostics.push({ code: 'invalid-node', source: c.source, node: c.fragment, message: `${label} has no schema.org @type: left out` });
      leftOut();
      continue;
    }
    // The article kind counts as one type: a page with its own article takes no other article of any subtype, and a
    // site node is never an article (each article page has its own).
    const conflict = types.find((t) => RESERVED_TYPES.has(t) || coreTypes.has(t) || (ARTICLE_KIND.has(t) && (c.owner === 'site' || hasArticle)));
    if (conflict) {
      diagnostics.push({ code: 'reserved-type', source: c.source, node: c.fragment, message: `${label}: ${c.owner === 'site' ? 'a site node cannot be' : 'the page already has'} its ${conflict}; left out` });
      leftOut();
      continue;
    }
    if (taken.has(id)) {
      diagnostics.push({ code: 'id-conflict', source: c.source, node: c.fragment, message: `${label} names a node the page already has: left out` });
      continue;
    }
    // A site node is the same on every page: an item's value in it would carry that item's content elsewhere.
    if (c.owner === 'site') {
      for (const f of c.itemFields ?? []) {
        if (!(f in node) || f === '@type') continue;
        delete node[f];
        diagnostics.push({ code: 'site-node-item-field', source: c.source, node: c.fragment, message: `${label}: ${f} came from an item; removed from the site node` });
      }
    }
    const full = { '@id': id, ...(absoluteRefs(node, base) as Record<string, unknown>) } as JsonLdNode;
    full['@type'] = node['@type'] as string;
    const size = new TextEncoder().encode(JSON.stringify(full)).length;
    if (size > budget[c.owner]) {
      diagnostics.push({ code: 'too-large', source: c.source, node: c.fragment, message: `${label}: the page's contributed structured data is past its size limit; left out` });
      leftOut();
      continue;
    }
    budget[c.owner] -= size;
    taken.add(id);
    added.push({ full, from: c });
    if (types.some((t) => ARTICLE_KIND.has(t))) hasArticle = true;
    if (c.owner === 'page') about.push({ '@id': id });
  }
  // References to nodes left out, or to parts of this page (or of the site's origin) the graph does not have. A site
  // node is the same on every page of every language: of the site's nodes it may name the identity and the site's
  // other nodes only — not a page's, nor the WebSite (which hangs from each language's home) — so what it keeps never
  // depends on the page it is on.
  const local = (ref: string) => [at.url, at.origin, at.root].some((b) => ref.startsWith(`${b}#`));
  // Host names compared as DNS names: lower case, without the root's trailing dot.
  const parse = (ref: string): URL | null => {
    try {
      return new URL(ref);
    } catch {
      return null;
    }
  };
  const nameOf = (hostname: string) => hostname.toLowerCase().replace(/\.$/, '');
  const siteHosts = new Set([nameOf(parse(at.origin)?.hostname ?? ''), ...at.siteHosts.map((h) => nameOf(h.replace(/:\d+$/, '')))]);
  /**
   * A reference to a node of the site — an address with a fragment whose host name is one of the site's: the fragment
   * when it is on the site's root exactly as the site serves it (https, its default port, no path, no query: where the
   * identity and the site nodes hang); `''` for any other (a page's node, another scheme or port — never retargeted to
   * the root, Codex review of batch 5c); null for a reference outside the site.
   */
  const siteFragment = (ref: string): string | null => {
    const u = parse(ref);
    if (!u || !u.hash || !siteHosts.has(nameOf(u.hostname))) return null;
    return u.protocol === 'https:' && u.port === '' && u.pathname === '/' && !u.search ? u.hash.slice(1) : '';
  };
  const siteTargets = new Set(
    [...nodes.filter((n) => n['@id'] === `${at.origin}#identity`), ...added.filter((a) => a.from.owner === 'site').map((a) => a.full)].map((n) => n['@id'].slice(n['@id'].indexOf('#') + 1)),
  );
  // A site node's references into the site, relative (`#name`): whichever host serves the page, they name its nodes.
  const relative = (value: unknown): unknown => {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as { '@id'?: unknown })['@id'] === 'string') {
      const f = siteFragment((value as { '@id': string })['@id']);
      return f ? { '@id': `#${f}` } : value;
    }
    if (Array.isArray(value)) return value.map(relative);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relative(v)]));
    return value;
  };
  for (const { full: n, from } of added) {
    const dangling = (ref: string) => {
      if (removedIds.has(ref)) return true;
      if (from.owner === 'page') return local(ref) && !taken.has(ref);
      // A site node: a node of the site other than those it may name (on any of its hosts).
      const f = siteFragment(ref);
      return f !== null && (f === '' || !siteTargets.has(f));
    };
    const removed: string[] = [];
    const { '@id': id, '@type': type, ...rest } = n;
    const clean = (withoutDangling(rest, dangling, removed) ?? {}) as Record<string, unknown>;
    for (const r of removed) diagnostics.push({ code: 'dangling-reference', source: from.source, node: from.fragment, message: `${id}: the reference to ${r} goes nowhere; removed` });
    // What is kept is the node as output (the dangling references and a site node's item values gone; a page node's
    // references absolute, a site node's references into the site relative): stored as such, it passes the page's own
    // check unchanged, on every host of the site.
    const stored = from.owner === 'site' ? (relative(clean) as Record<string, unknown>) : clean;
    const output = from.owner === 'site' ? (absoluteRefs(stored, at.origin) as Record<string, unknown>) : clean;
    nodes.push({ '@id': id, '@type': type, ...output } as JsonLdNode);
    kept.push({ ...from, node: { '@type': type, ...stored } });
  }
  if (about.length) {
    const page = nodes.find((n) => n['@id'] === at.webPageId);
    if (page) {
      const prior = page.about ? (Array.isArray(page.about) ? page.about : [page.about]) : [];
      page.about = [...prior, ...about];
    }
  }
}

/**
 * A graph as the text of a `<script type="application/ld+json">` element: JSON with `<`, `>`, `&` and the line
 * separators escaped, so no value can end the script or the document around it.
 */
export function jsonLdText(graph: JsonLdGraph): string {
  return JSON.stringify(graph)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}
