import { and, asc, eq, inArray, isNull, lte, notInArray, sql } from 'drizzle-orm';
import sanitizeHtml from 'sanitize-html';
import {
  collections,
  contentRoutes,
  extensions,
  fields,
  items,
  projectionRebuilds,
  publicAlternates,
  publicHosts,
  publicItems,
  publicPathMemory,
  publicSites,
  routeTombstones,
  siteContentSettings,
  siteSeoSettings,
  siteIdentity,
  siteDomains,
  siteRenderVersions,
  sites,
  translationGroupMembers,
  translationGroups,
  type Database,
} from '@heopress/database';
import { isTransaction, retryTransaction, runSiteTransaction, setBeforeCommitHook, withSiteScope, type SiteTransaction } from '../rls-transaction';
import { publicUrlOf } from '@heopress/public-site';
import { loadSpace } from './site-rules';
import { lockContentSettingsShared } from './content-routes';
import { MembershipChangedError, withMembershipRetry } from './translation-groups';
import { publicSeoSnapshot } from './seo-settings-service';
import { effectiveSeoSettings, effectiveSiteIdentity, type SiteIdentity, type SiteSeoSettings } from '@heopress/contracts/schemas';
import {
  absoluteUrl,
  appliesTo,
  decideIndexing,
  itemStructuredData,
  materializeContribution,
  normalizedContent,
  pageTypeOfCollection,
  STRUCTURED_DATA_CAPABILITY,
  structuredDataReport,
  validContributions,
  type MaterializedNode,
  type StructuredDataContribution,
  type StructuredDataDiagnostic,
} from '@heopress/seo-geo';
import { createHash } from 'node:crypto';
import { publicExtensionsOfSite } from '../extensions/content-extensions';

/**
 * Maintaining the public projection (HeoPress P06 task 1.2; design R1, R13, R14, R19, R22, R25, R26).
 *
 * Every transaction that changed a table the public output derives from calls
 * `flushPublicProjection(tx)` before committing (`runSiteTransaction` does it for its callers):
 * it takes the transaction's change records and refreshes what they touch —
 *
 *   - items and routes → that item's projection row, its "ever public" path, a tombstone when a
 *     once-public item was deleted, and the language switch of its translation group (old and new
 *     groups, every viewing site);
 *   - redirects → the site's render version (redirects are read through a view), and the
 *     tombstones their sources now cover;
 *   - members and groups → the language switch of the groups involved (old and new);
 *   - content settings, sites, domains, collections, fields → the whole site, and the language
 *     switch of every cross-site group it is in (another site stores this site's URLs).
 *
 * Every site whose projection rows changed gets its render version raised in the same
 * transaction. Fields are public by default-deny rules (design R19).
 */

type Tx = SiteTransaction;

/** Raised when the sanitiser's rules change: projections built by an older one are rebuilt. */
// 2: short videos in articles (ADR-0020).
const SANITIZER_VERSION = 2;

// ---------- public fields (design R19) ----------

interface FieldDef {
  name: string;
  type: string;
  interface: string;
  hidden: boolean;
  encrypted: boolean;
  classification: string;
  options: Record<string, unknown>;
}

/** Interfaces whose values may be published, and how. Anything else (user, hash, code, …) is not. */
const SCALAR_INTERFACES = new Set(['input', 'textarea', 'slug', 'select-dropdown', 'select-radio', 'toggle', 'datetime', 'number', 'slider', 'rating', 'color', 'file', 'select-dropdown-m2o', 'markdown']);
const RICH_TEXT = 'wysiwyg';

/**
 * Storage types whose values may be published at all, whatever the editor interface says (design R19):
 * not `hash`, `geometry`, `alias` or any type added later. Structured types (`json`, `csv`) still pass
 * only through the interface rules below.
 */
const PUBLIC_TYPES = new Set(['string', 'text', 'integer', 'bigInteger', 'decimal', 'boolean', 'date', 'datetime', 'time', 'timestamp', 'uuid', 'json', 'csv']);

function isPublicField(f: FieldDef): boolean {
  return !f.hidden && !f.encrypted && f.classification === 'none' && PUBLIC_TYPES.has(f.type);
}

/** The value of a field as the public may see it, or `undefined` (not public). */
function publicValue(f: FieldDef, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (f.interface === RICH_TEXT) return typeof value === 'string' ? sanitizeRichText(value) : undefined;
  if (SCALAR_INTERFACES.has(f.interface)) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
  }
  // Relation id lists (`tags` with `itemsOf`): ids only.
  if (f.interface === 'tags' && typeof f.options?.itemsOf === 'string') {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
  }
  // Short multilingual values `{ <locale>: { name, description? } }`: strings only.
  if (f.interface === 'translations') {
    if (typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, Record<string, string>> = {};
    for (const [locale, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const kept = Object.fromEntries(Object.entries(entry as Record<string, unknown>).filter(([k, v]) => (k === 'name' || k === 'description') && typeof v === 'string'));
      out[locale] = kept as Record<string, string>;
    }
    return out;
  }
  // Repeaters: rows filtered by their declared sub-fields (the same rules, recursively).
  if (f.interface === 'repeater') {
    const subs = Array.isArray(f.options?.fields) ? (f.options.fields as Array<Record<string, unknown>>) : [];
    if (!Array.isArray(value) || subs.length === 0) return undefined;
    const subDefs: FieldDef[] = subs
      .filter((s) => typeof s.field === 'string' || typeof s.name === 'string')
      .map((s) => ({
        name: String(s.field ?? s.name),
        type: String(s.type ?? 'string'),
        interface: String((s.meta as Record<string, unknown> | undefined)?.interface ?? s.interface ?? 'input'),
        hidden: s.hidden === true,
        encrypted: s.encrypted === true,
        classification: typeof s.classification === 'string' ? s.classification : 'none',
        options: ((s.meta as Record<string, unknown> | undefined)?.options ?? s.options ?? {}) as Record<string, unknown>,
      }));
    return value.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map((r) => filterData(subDefs, r as Record<string, unknown>));
  }
  // Anything else structured is public only when declared so as a whole.
  if (f.options?.public === true) return value;
  return undefined;
}

/** Only declared, public fields; undeclared keys are dropped. */
function filterData(defs: FieldDef[], data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of defs) {
    if (!isPublicField(f) || !(f.name in data)) continue;
    const v = publicValue(f, data[f.name]);
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

/**
 * The rich text a public page may carry: an allow-list of elements and attributes, safe URL schemes. `keepAttributes`
 * (the site importer, P12 task 6.4): attributes kept on top of the public ones, per element — what is stored may
 * carry more than a public page shows, never anything executable.
 */
export function sanitizeRichText(html: string, keepAttributes: Record<string, string[]> = {}): string {
  const base: Record<string, string[]> = {
    a: ['href', 'title', 'rel', 'target'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    // A video plays only when the reader asks: no autoplay, no script hooks.
    video: ['src', 'controls', 'preload', 'poster', 'width', 'height', 'playsinline', 'title'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    '*': ['data-block-id', 'lang', 'dir'],
  };
  for (const [tag, attrs] of Object.entries(keepAttributes)) base[tag] = [...(base[tag] ?? []), ...attrs];
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'hr', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'mark', 'small',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'span', 'div',
      'video',
    ],
    allowedAttributes: base,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href', 'src', 'poster'],
    allowProtocolRelative: false,
    transformTags: {
      // A link opened in a new tab never gets the opener.
      a: (tagName, attribs) => ({ tagName, attribs: attribs.target === '_blank' ? { ...attribs, rel: mergeRel(attribs.rel, ['noopener', 'noreferrer']) } : attribs }),
    },
  });
}

function mergeRel(rel: string | undefined, add: string[]): string {
  const set = new Set((rel ?? '').split(/\s+/).filter(Boolean));
  for (const r of add) set.add(r);
  return [...set].join(' ');
}

// ---------- reading what an item's projection derives from ----------

async function fieldDefs(tx: Tx, collectionId: string): Promise<FieldDef[]> {
  const rows = await tx
    .select({
      name: fields.name,
      type: fields.type,
      interface: fields.interface,
      hidden: fields.hidden,
      encrypted: fields.encrypted,
      classification: fields.classification,
      options: fields.options,
    })
    .from(fields)
    .where(eq(fields.collectionId, collectionId));
  return rows.map((r) => ({ ...r, options: (r.options ?? {}) as Record<string, unknown> }));
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The card a list shows, from the filtered data only (design R19). */
function cardOf(data: Record<string, unknown>, url: string | null, publishedAt: Date | null, sponsored: boolean): Record<string, unknown> {
  return {
    title: asString(data.title) ?? asString(data.name) ?? '',
    excerpt: asString(data.excerpt) ?? asString(data.seo_description) ?? asString(data.description) ?? '',
    image: asString(data.seo_image),
    url,
    publishedAt: publishedAt?.toISOString() ?? null,
    sponsored,
  };
}

/** Whether the item is internal-only in its group (never public). */
async function isInternalOnly(tx: Tx, siteId: string, itemId: string): Promise<boolean> {
  const [m] = await tx
    .select({ internal: translationGroupMembers.internalOnly })
    .from(translationGroupMembers)
    .where(and(eq(translationGroupMembers.siteId, siteId), eq(translationGroupMembers.itemId, itemId)));
  return m?.internal ?? false;
}

/**
 * Raise the render version of each site. Versions come from one sequence (migration 0038): they only grow
 * and never repeat, even for a site deleted and created again under the same id (they key the page cache).
 */
async function bumpVersions(tx: Tx, siteIds: Iterable<string>): Promise<void> {
  for (const siteId of [...new Set(siteIds)].sort()) {
    // A site deleted in this transaction has nothing left to version.
    await withSiteScope(tx, siteId, () =>
      tx.execute(sql`
        INSERT INTO ${siteRenderVersions} (site_id, version)
        SELECT ${siteId}, nextval('heopress_render_version_seq') FROM ${sites} WHERE ${sites.id} = ${siteId}
        ON CONFLICT (site_id) DO UPDATE SET version = nextval('heopress_render_version_seq')`),
    );
  }
}

// ---------- items ----------

interface ItemSource {
  id: string;
  collection: string;
  data: unknown;
  number: number | null;
  publishedAt: Date | null;
  updatedAt: Date;
}

/**
 * The structured data extensions contribute to a site (P07 task 2.9; contract `StructuredDataContribution`): from each
 * extension enabled on the site and granted `seo:structured-data`, its checked contributions — the item ones, applied
 * per item with the contribution's fingerprint, and the site ones, materialised once. In the site's scope.
 */
interface SiteContributions {
  item: Array<{ extKey: string; contribution: StructuredDataContribution; fingerprint: string }>;
  site: MaterializedNode[];
  diagnostics: StructuredDataDiagnostic[];
}

async function siteContributions(tx: Tx, siteId: string): Promise<SiteContributions> {
  const rows = await tx
    .select({ id: extensions.id, key: extensions.key, name: extensions.name, version: extensions.version, manifest: extensions.manifest, capabilities: extensions.capabilities })
    .from(extensions)
    .where(and(eq(extensions.siteId, siteId), eq(extensions.enabled, true)));
  const out: SiteContributions = { item: [], site: [], diagnostics: [] };
  // Extension keys are not unique: a second extension with a key already seen would name the same nodes — it is left out.
  const seen = new Set<string>();
  for (const row of rows.map((r) => ({ ...r, extKey: r.key || r.name })).sort((a, b) => (a.extKey < b.extKey ? -1 : a.extKey > b.extKey ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const declared = (row.manifest as { structuredData?: unknown } | null)?.structuredData;
    if (declared === undefined) continue;
    if (seen.has(row.extKey)) {
      out.diagnostics.push({ code: 'id-conflict', source: `extension:${row.extKey}`, message: 'another enabled extension has the same key: its structured data is not used' });
      continue;
    }
    seen.add(row.extKey);
    const granted = Array.isArray(row.capabilities) && (row.capabilities as unknown[]).includes(STRUCTURED_DATA_CAPABILITY);
    if (!granted) {
      out.diagnostics.push({ code: 'invalid-contribution', source: `extension:${row.extKey}`, message: `not granted ${STRUCTURED_DATA_CAPABILITY}: its structured data is not used` });
      continue;
    }
    const { contributions, diagnostics } = validContributions(row.extKey, declared);
    out.diagnostics.push(...diagnostics);
    for (const c of contributions) {
      const fingerprint = createHash('sha256').update(stableJson({ extension: row.extKey, version: row.version, contribution: c })).digest('hex').slice(0, 32);
      if (c.scope === 'item') {
        out.item.push({ extKey: row.extKey, contribution: c, fingerprint });
        continue;
      }
      const m = materializeContribution(row.extKey, c, fingerprint, null);
      out.diagnostics.push(...m.diagnostics);
      if (m.node) out.site.push(m.node);
    }
  }
  // The site nodes through the final check once, as every indexable page shows them (they may name only the site's
  // identity and other site nodes, by relative references, so the result is the same on every page of every language
  // and every host): only what it keeps is
  // used — by the site row, the report and each item's own check — as it outputs it (P07 task 2.10, Codex review of
  // batch 5c). Without a domain the site's origin is a placeholder: the site is not served then, and a domain added
  // refreshes the whole site.
  if (out.site.length) {
    const domains = await tx
      .select({ hostname: siteDomains.hostname, isPrimary: siteDomains.isPrimary })
      .from(siteDomains)
      .where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active')));
    const host = domains.find((d) => d.isPrimary)?.hostname ?? domains.map((d) => d.hostname).sort()[0];
    const origin = `https://${host ?? 'site.invalid'}/`;
    const [identityRow] = await tx.select({ identity: siteIdentity.identity }).from(siteIdentity).where(eq(siteIdentity.siteId, siteId));
    const report = structuredDataReport({
      pageType: 'item',
      // As an indexable page shows them, whichever kind of page that is (a site whose item pages are not indexed still
      // has an indexable home): the indexing of a particular page decides nothing here.
      indexing: { indexable: true, follow: true, robots: '', decidedBy: 'system' },
      siteName: '',
      homeUrl: origin,
      siteOrigin: origin,
      locale: '',
      identity: effectiveSiteIdentity(identityRow?.identity),
      page: { url: `${origin}heopress-structured-data-check/`, title: 'x', collection: 'pages' },
      contributed: out.site,
      // Every host of the site (language domains included): a reference to a node on any of them is into the site.
      siteHosts: domains.map((d) => d.hostname),
    });
    out.diagnostics.push(...report.diagnostics);
    out.site = report.kept;
  }
  return out;
}

const NO_CONTRIBUTIONS: SiteContributions = { item: [], site: [], diagnostics: [] };

/** What an item's structured data is built against: the site's contributions, SEO settings and type. */
interface StructuredContext {
  contributions: SiteContributions;
  seo: SiteSeoSettings | null;
  siteType: string | null;
  /** The site's identity (whether there is one decides whether it is a reference target) and its origin (its primary host). */
  identity?: SiteIdentity | null;
  origin?: string | null;
}

async function structuredContext(tx: Tx, siteId: string): Promise<StructuredContext> {
  const [settings] = await tx.select({ siteType: siteContentSettings.siteType }).from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
  const [identityRow] = await tx.select({ identity: siteIdentity.identity }).from(siteIdentity).where(eq(siteIdentity.siteId, siteId));
  const [primary] = await tx
    .select({ hostname: siteDomains.hostname })
    .from(siteDomains)
    .where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active'), eq(siteDomains.isPrimary, true)));
  return {
    contributions: await siteContributions(tx, siteId),
    seo: await seoSettingsOf(tx, siteId),
    siteType: settings?.siteType ?? 'blog',
    identity: effectiveSiteIdentity(identityRow?.identity),
    origin: primary ? `https://${primary.hostname}/` : null,
  };
}

/** A preset field of the item's collection, found by its preset key (whatever the site named it). */
function presetField(defs: FieldDef[], key: string): FieldDef | undefined {
  return defs.find((f) => {
    const preset = (f.options as { preset?: { name?: unknown; key?: unknown } }).preset;
    return preset?.name === 'site-network' && preset.key === key;
  });
}

/** Diagnostics once each (the same removal is reported once). */
function distinctDiagnostics(list: StructuredDataDiagnostic[]): StructuredDataDiagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const k = `${d.code}|${d.source}|${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The item's structured-data inputs the system vouches for (P07 tasks 2.4, 2.9; Codex review of batch 5b-2): the
 * explicit questions and answers of the preset's own `faq` field — found by its preset key, whatever the site named
 * it; a site field that only shares the name is not it — from the public data (so the field's own visibility
 * applies); the item's own JSON-LD (the preset's `structured_data` field, a field the public may see) and the item
 * contributions of the site's extensions, checked and materialised as nodes of the page (`nodes`), with what was left
 * out of them (`diagnostics`: also what the final check will leave out on the page — a type the page already has, an
 * identifier taken, the page not being indexable).
 */
function structuredOf(
  defs: FieldDef[],
  raw: Record<string, unknown>,
  data: Record<string, unknown>,
  page: { collection: string; url: string | null; home: string | null; seoRobots: string | null; image: string | null },
  ctx: StructuredContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const faqField = presetField(defs, 'faq');
  const rows = faqField ? data[faqField.name] : undefined;
  const faq = Array.isArray(rows)
    ? rows.flatMap((r) => {
        const q = (r as Record<string, unknown> | null)?.question;
        const a = (r as Record<string, unknown> | null)?.answer;
        return typeof q === 'string' && typeof a === 'string' ? [{ question: q, answer: a }] : [];
      })
    : [];
  if (faq.length) out.faq = faq;
  const nodes: MaterializedNode[] = [];
  const diagnostics: StructuredDataDiagnostic[] = [];
  const customField = presetField(defs, 'structured_data');
  const custom = customField && isPublicField(customField) ? raw[customField.name] : undefined;
  if (typeof custom === 'string' && custom.trim()) {
    const r = itemStructuredData(custom, page.url);
    nodes.push(...r.nodes);
    diagnostics.push(...r.diagnostics);
  }
  for (const { extKey, contribution, fingerprint } of ctx.contributions.item) {
    if (!appliesTo(contribution, page.collection)) continue;
    const m = materializeContribution(extKey, contribution, fingerprint, data);
    diagnostics.push(...m.diagnostics);
    if (m.node) nodes.push(m.node);
  }
  if (nodes.length) {
    // The final check as the page will run it (its type, its own nodes, its indexing, the site's identity and origin,
    // its image and breadcrumb): what it will leave out, reported here. The page's own check is what holds.
    if (page.url && ctx.seo) {
      const pageType = pageTypeOfCollection(page.collection);
      const decided = decideIndexing({ settings: ctx.seo, pageType, collection: page.collection, itemRobots: page.seoRobots });
      // A page canonical to another address is a declared duplicate: like a page not indexed, it carries nothing
      // contributed (the rule of the page's own graph, `site-classic` view model).
      const override = absoluteUrl(data.canonical_url);
      const duplicate = !!override && override !== absoluteUrl(page.url);
      const indexing = duplicate ? { ...decided, indexable: false } : decided;
      const home = page.home && /^https?:\/\//.test(page.home) ? page.home : new URL('/', page.url).toString();
      const report = structuredDataReport({
        pageType,
        indexing,
        siteName: '',
        homeUrl: home,
        siteOrigin: ctx.origin ?? null,
        locale: '',
        identity: ctx.identity ?? null,
        siteType: ctx.siteType,
        page: { url: page.url, title: 'x', collection: page.collection, image: page.image },
        breadcrumb: [{ name: 'home', url: home }, { name: 'page', url: page.url }],
        faq,
        // With the site's nodes, as the page merges them: a reference from the item's nodes to one of them is kept.
        contributed: [...nodes, ...ctx.contributions.site],
      });
      // Only what it keeps is stored — within the page's size limit, measured as the page measures it, after the
      // conflicts are left out, as it outputs it (Codex review of batch 5c): the page's own check runs again on what
      // is stored. What it says about the site's nodes is the site's report, not this item's.
      const own = report.kept.filter((n) => n.owner === 'page');
      if (own.length) out.nodes = own;
      const siteFragments = new Set(ctx.contributions.site.map((n) => n.fragment));
      // (Site and page fragments never coincide: an extension's site and item contributions have different keys, and an
      // item's own fragments never start with `ext-`.)
      diagnostics.push(...report.diagnostics.filter((d) => !(d.node && siteFragments.has(d.node))));
    }
    // No public address (or no settings): the page carries none of them, so none is stored.
  }
  if (diagnostics.length) out.diagnostics = distinctDiagnostics(diagnostics);
  return out;
}

/**
 * JSON with object keys in order (P07, Codex review of batch 5b-2): PostgreSQL's JSONB keeps its own key order, so a
 * value read back compares equal to the same value built in another order — an unchanged row is not rewritten.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** An item's projection row: its public fields only (design R19), from its data and its route. */
function projectedRow(
  siteId: string,
  row: ItemSource,
  route: { locale: string; path: string; url: string | null; home?: string | null },
  defs: FieldDef[],
  ctx: StructuredContext = { contributions: NO_CONTRIBUTIONS, seo: null, siteType: null },
) {
  const raw = (row.data ?? {}) as Record<string, unknown>;
  const data = filterData(defs, raw);
  const seoRobots = asString(raw.seo_robots);
  // The only values the renderer may output as markup: sanitised rich text (everything else is escaped).
  const richFields = defs.filter((f) => f.interface === RICH_TEXT && typeof data[f.name] === 'string').map((f) => f.name).sort();
  const sponsored = data.sponsored === true;
  return {
    itemId: row.id,
    siteId,
    collection: row.collection,
    locale: route.locale,
    path: route.path,
    number: row.number,
    data,
    card: cardOf(data, route.url, row.publishedAt, sponsored),
    sponsored,
    sponsorName: sponsored ? asString(data.sponsor_name) : null,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    sanitizer: SANITIZER_VERSION,
    richFields,
    // The item's own indexing setting, public field or not (P07 task 2.8: the renderer decides with the site's settings).
    seoRobots,
    structured: structuredOf(defs, raw, data, { collection: row.collection, url: route.url, home: route.home ?? null, seoRobots, image: asString(data.seo_image) }, ctx),
  };
}

export type PreviewItemRow = ReturnType<typeof projectedRow>;

/**
 * The SHA-256 of a projected row's normalised content (P07 task 2.5): the content title (never `seo_title`), the
 * excerpt (or a taxonomy's description, an author's biography), the sanitised rich-text bodies in field order and a
 * plain-text `body`.
 * SEO fields, the canonical, relations, the route and every other field are not content.
 */
function plainBodyHtml(body: string): string {
  const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body.split(/\n{2,}/).map((p) => `<p>${escape(p)}</p>`).join('');
}

function contentHashOf(row: Pick<PreviewItemRow, 'data' | 'richFields' | 'sanitizer'>): string {
  const data = row.data;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const normalized = normalizedContent({
    title: text(data.title) || text(data.name),
    excerpt: text(data.excerpt) || text(data.description) || text(data.bio),
    bodies: [
      ...row.richFields.map((f) => text(data[f])),
      // A plain-text body is the page's body too (rendered as escaped paragraphs): its paragraphs are its blocks.
      ...(!row.richFields.includes('body') && text(data.body) ? [plainBodyHtml(text(data.body))] : []),
    ],
  });
  // Labelled with the sanitiser that produced this row's data (an older row keeps its own), not the current one.
  return `${hashFormat(row.sanitizer)}:${createHash('sha256').update(normalized).digest('hex')}`;
}

/**
 * The format of a content hash: the normalisation's version and the sanitiser's (whose output it reads). A hash of
 * another format — a row from before task 2.5 (null) or from an older normalisation or sanitiser — is adopted without
 * moving the time: a change of the rules is not a change of the content (Codex review of batch 4b).
 */
const CONTENT_NORMALIZATION_VERSION = 2;
const hashFormat = (sanitizer: number): string => `c${CONTENT_NORMALIZATION_VERSION}.s${sanitizer}`;
const CURRENT_HASH = new RegExp(`^c${CONTENT_NORMALIZATION_VERSION}\\.s${SANITIZER_VERSION}:[0-9a-f]{64}$`);
const sameFormat = (hash: string | null): boolean => hash !== null && CURRENT_HASH.test(hash);

/**
 * When the content of a row last changed (P07 task 2.5): kept while the hash stays (a re-render, a republish of the
 * same content, an SEO or route change), adopted with the hash unknown (a row from before task 2.5), the publication
 * time on first entry, and the time of the change — never before the publication — otherwise (an item coming back
 * whose last public content is unknown included). `prior` is the current row or, for an item coming back, the memory
 * of its last public content. A time kept is never earlier than the publication.
 */
function contentModifiedAt(
  prior: { contentHash: string | null; contentModifiedAt: Date | null } | undefined,
  hash: string,
  publishedAt: Date | null,
  now: Date,
): Date {
  const kept = prior?.contentModifiedAt && (prior.contentHash === hash || !sameFormat(prior.contentHash)) ? prior.contentModifiedAt : null;
  // No prior row: a first publication. A prior without a time is the memory of an item unpublished before task 2.5:
  // its content then is unknown, so coming back counts as a change.
  // A change moves the time forward, even within the same millisecond or with the clock set back.
  const changedAt = prior?.contentModifiedAt && now <= prior.contentModifiedAt ? new Date(prior.contentModifiedAt.getTime() + 1) : now;
  const at = kept ?? (prior ? changedAt : (publishedAt ?? now));
  // A publication date moved later than the content's time (set by hand) carries it along: modified is never before published.
  return publishedAt && publishedAt > at ? publishedAt : at;
}

/**
 * A draft's page data for a preview (P06 task 4.3; design R7, R43): built by the projection's own rules
 * (public fields only, sanitised rich text) whatever the item's status, and written nowhere. Null when
 * the item does not exist in the collection, is deleted, or its collection is hidden. In `tx`'s site scope.
 */
export async function previewItemRow(
  tx: Tx,
  siteId: string,
  collection: string,
  itemId: string,
  /** Fields the viewer may read besides (`*`: all); the projection's rules still apply. */
  readable: string[] = ['*'],
  /** P10 branch preview: the branch's data in place of the item's (the same projection rules apply). */
  data?: Record<string, unknown>,
): Promise<PreviewItemRow | null> {
  const [row] = await tx
    .select({
      id: items.id,
      collectionId: items.collectionId,
      collection: collections.name,
      data: items.data,
      number: items.number,
      publishedAt: items.publishedAt,
      updatedAt: items.updatedAt,
    })
    .from(items)
    .innerJoin(collections, eq(collections.id, items.collectionId))
    .where(and(eq(items.siteId, siteId), eq(items.id, itemId), eq(collections.name, collection), isNull(items.deletedAt), eq(collections.hidden, false)));
  if (!row) return null;
  const [route] = await tx.select().from(contentRoutes).where(and(eq(contentRoutes.siteId, siteId), eq(contentRoutes.itemId, itemId)));
  const space = await loadSpace(tx, siteId);
  const locale = route?.locale ?? space.defaultLocale;
  // A draft may have no route yet: no public address to show.
  const place = route ? { locale, path: route.path, url: publicUrlOf(space, locale, route.path), home: publicUrlOf(space, locale, '/') } : { locale, path: '', url: null };
  const defs = (await fieldDefs(tx, row.collectionId)).filter((f) => readable.includes('*') || readable.includes(f.name));
  return projectedRow(siteId, data ? { ...row, data } : row, place, defs, await structuredContext(tx, siteId));
}

/**
 * Refresh the projection rows of items of one site (in that site's scope). `deleted` names the items
 * whose rows go because the item itself was deleted: a once-public one leaves a tombstone. Returns
 * whether anything changed.
 */
async function refreshItemsOfSite(tx: Tx, siteId: string, itemIds: string[], deleted: Set<string>): Promise<boolean> {
  if (itemIds.length === 0) return false;
  return withSiteScope(tx, siteId, async () => {
    const space = await loadSpace(tx, siteId);
    const rows = await tx
      .select({
        id: items.id,
        collectionId: items.collectionId,
        collection: collections.name,
        collectionHidden: collections.hidden,
        status: items.status,
        data: items.data,
        deletedAt: items.deletedAt,
        number: items.number,
        publishedAt: items.publishedAt,
        updatedAt: items.updatedAt,
      })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(items.siteId, siteId), inArray(items.id, itemIds)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const routes = new Map(
      (await tx.select().from(contentRoutes).where(and(eq(contentRoutes.siteId, siteId), inArray(contentRoutes.itemId, itemIds)))).map((r) => [r.itemId, r]),
    );
    const current = new Map((await tx.select().from(publicItems).where(and(eq(publicItems.siteId, siteId), inArray(publicItems.itemId, itemIds)))).map((r) => [r.itemId, r]));
    const remembered = new Map(
      (await tx.select().from(publicPathMemory).where(and(eq(publicPathMemory.siteId, siteId), inArray(publicPathMemory.itemId, itemIds)))).map((r) => [r.itemId, r]),
    );
    const now = new Date();
    const defsCache = new Map<string, FieldDef[]>();
    let structured: StructuredContext | null = null;
    let changed = false;
    for (const itemId of itemIds) {
      const row = byId.get(itemId);
      const route = routes.get(itemId);
      const isPublic = !!row && row.status === 'published' && !row.deletedAt && !row.collectionHidden && !!route && !(await isInternalOnly(tx, siteId, itemId));
      const before = current.get(itemId);
      if (!isPublic) {
        if (before) {
          // A row from before task 2.5 leaving: its content's hash goes to the memory first, so a draft edit and a
          // republish compare against what was public (Codex review of batch 4b).
          if (!sameFormat(before.contentHash)) {
            await tx
              .update(publicPathMemory)
              .set({ contentHash: contentHashOf(before), contentModifiedAt: before.contentModifiedAt })
              .where(and(eq(publicPathMemory.siteId, siteId), eq(publicPathMemory.itemId, itemId)));
          }
          await tx.delete(publicItems).where(eq(publicItems.itemId, itemId));
          changed = true;
        }
        // A deleted item that was ever public leaves a 410 on its last public path (design R22).
        if ((deleted.has(itemId) || !row || row.deletedAt) ) {
          const [memory] = await tx.select().from(publicPathMemory).where(eq(publicPathMemory.itemId, itemId));
          if (memory) {
            await tx
              .insert(routeTombstones)
              .values({ siteId, locale: memory.locale, path: memory.path, itemId })
              .onConflictDoUpdate({ target: [routeTombstones.siteId, routeTombstones.locale, routeTombstones.path], set: { itemId, deletedAt: new Date() } });
            await tx.delete(publicPathMemory).where(eq(publicPathMemory.itemId, itemId));
            changed = true;
          }
        }
        continue;
      }
      if (!defsCache.has(row.collectionId)) defsCache.set(row.collectionId, await fieldDefs(tx, row.collectionId));
      structured ??= await structuredContext(tx, siteId);
      const projected = projectedRow(siteId, row, { locale: route.locale, path: route.path, url: publicUrlOf(space, route.locale, route.path), home: publicUrlOf(space, route.locale, '/') }, defsCache.get(row.collectionId)!, structured);
      const contentHash = contentHashOf(projected);
      const next = { ...projected, contentHash, contentModifiedAt: contentModifiedAt(before ?? remembered.get(itemId), contentHash, projected.publishedAt, now) };
      const same =
        before &&
        before.locale === next.locale &&
        before.path === next.path &&
        before.collection === next.collection &&
        before.number === next.number &&
        before.sponsored === next.sponsored &&
        before.sponsorName === next.sponsorName &&
        (before.publishedAt?.getTime() ?? null) === (next.publishedAt?.getTime() ?? null) &&
        before.sanitizer === next.sanitizer &&
        before.richFields.join(',') === next.richFields.join(',') &&
        before.seoRobots === next.seoRobots &&
        before.contentHash === next.contentHash &&
        stableJson(before.structured) === stableJson(next.structured) &&
        before.contentModifiedAt?.getTime() === next.contentModifiedAt.getTime() &&
        stableJson(before.data) === stableJson(next.data) &&
        stableJson(before.card) === stableJson(next.card);
      if (!same) {
        await tx.insert(publicItems).values(next).onConflictDoUpdate({ target: publicItems.itemId, set: next });
        changed = true;
      }
      // Its path is live: no tombstone there; remember it as its last public path, and its content's time.
      await tx.delete(routeTombstones).where(and(eq(routeTombstones.siteId, siteId), eq(routeTombstones.locale, route.locale), eq(routeTombstones.path, route.path)));
      const memory = { locale: route.locale, path: route.path, contentHash, contentModifiedAt: next.contentModifiedAt };
      await tx
        .insert(publicPathMemory)
        .values({ itemId, siteId, ...memory })
        .onConflictDoUpdate({ target: publicPathMemory.itemId, set: memory });
    }
    return changed;
  });
}

// ---------- indexing (P07 task 2.2) ----------

/** A site's SEO / GEO settings with their defaults, read in that site's scope. */
export async function seoSettingsOf(tx: Tx, siteId: string): Promise<SiteSeoSettings> {
  const [row] = await tx.select({ settings: siteSeoSettings.settings }).from(siteSeoSettings).where(eq(siteSeoSettings.siteId, siteId));
  return effectiveSeoSettings(row?.settings);
}

/**
 * Whether a public item's page is indexable on its site: the decision the rendering service makes for the page
 * (`@heopress/seo-geo`), from the same inputs — the site's settings and the item's own setting.
 */
export function publicItemIndexable(settings: SiteSeoSettings, row: { collection: string; seoRobots: string | null }): boolean {
  return decideIndexing({ settings, pageType: pageTypeOfCollection(row.collection), collection: row.collection, itemRobots: row.seoRobots }).indexable;
}

// ---------- language switch (design R14) ----------

/**
 * The language switch of every member of the groups, as each member site shows it. Returns sites changed.
 * `hints` names sites from whose scope a group is visible (its owner and member sites, from the change
 * records): under row-level security a group the writing site just left is no longer visible from it.
 */
async function refreshGroups(
  tx: Tx,
  groupIds: Iterable<string>,
  alsoItems: Map<string, string> = new Map(),
  hints: Map<string, Set<string>> = new Map(),
): Promise<Set<string>> {
  const changedSites = new Set<string>();
  const ids = [...new Set(groupIds)].filter(Boolean).sort();
  // Items whose group is gone (removed member, dissolved group): their rows are emptied.
  const handled = new Set<string>();
  for (const groupId of ids) {
    // The group's sites: from any site that can see it (the caller's scope, else its owner or a member site).
    const read = () => tx.select().from(translationGroups).where(eq(translationGroups.id, groupId));
    let [group] = await read();
    for (const site of [...(hints.get(groupId) ?? [])].sort()) {
      if (group) break;
      [group] = await withSiteScope(tx, site, read);
    }
    if (!group) continue;
    // Every member site's settings row, shared, in site order (the lock order): a concurrent change of
    // another site's switch commits before this reads it, or waits until this commits (Codex review).
    const settled = new Set(group.siteIds);
    for (const siteId of [...settled].sort()) await withSiteScope(tx, siteId, () => lockContentSettingsShared(tx, siteId));
    // Then the group row (groups in ID order, after the settings — the order of every group write): two
    // refreshes of one group — a site's SEO settings and a member's publication or indexing, written at
    // the same time — run one after the other, the later reading what the earlier committed, so the last
    // one to commit stores the final state (P07 Codex review of batch 4a). What it stores is read only now.
    const [locked] = await withSiteScope(tx, group.siteId, () => tx.select().from(translationGroups).where(eq(translationGroups.id, groupId)).for('update'));
    if (!locked) continue;
    // A site joined while this waited: its settings were not locked first, and are never locked after the group
    // (that order could deadlock with a writer of that site's settings) — the transaction starts over.
    if (locked.siteIds.some((s) => !settled.has(s))) throw new MembershipChangedError();
    group = locked;
    const siteIds = [...group.siteIds].sort();
    const switches = new Map<string, boolean>();
    const members: Array<{ itemId: string; siteId: string; locale: string; url: string | null; indexable: boolean }> = [];
    for (const siteId of siteIds) {
      await withSiteScope(tx, siteId, async () => {
        const [s] = await tx.select({ allow: siteContentSettings.allowCrossSiteTranslations }).from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
        switches.set(siteId, s?.allow ?? false);
        const seo = await seoSettingsOf(tx, siteId);
        const rows = await tx
          .select({ itemId: translationGroupMembers.itemId })
          .from(translationGroupMembers)
          .where(and(eq(translationGroupMembers.groupId, groupId), eq(translationGroupMembers.siteId, siteId)));
        const pub = rows.length
          ? await tx
              .select({ itemId: publicItems.itemId, locale: publicItems.locale, card: publicItems.card, collection: publicItems.collection, seoRobots: publicItems.seoRobots })
              .from(publicItems)
              .where(and(eq(publicItems.siteId, siteId), inArray(publicItems.itemId, rows.map((r) => r.itemId))))
          : [];
        const publicIds = new Set(pub.map((p) => p.itemId));
        for (const r of rows) {
          const p = pub.find((x) => x.itemId === r.itemId);
          members.push({
            itemId: r.itemId,
            siteId,
            locale: p?.locale ?? '',
            url: publicIds.has(r.itemId) ? ((p!.card as { url?: string | null }).url ?? null) : null,
            indexable: p ? publicItemIndexable(seo, p) : false,
          });
        }
      });
    }
    // The language switch lists published, indexable members only (P07 task 2.2: spec "双向 hreflang"), the page
    // itself included — and only on a page that is itself indexable, so every listed page lists the same set.
    // The group's x-default names one of them, while it is one of them.
    const xDefault = members.find((m) => m.itemId === group.xDefaultItemId);
    for (const viewer of members) {
      handled.add(viewer.itemId);
      const visible = (m: (typeof members)[number]) => !!m.url && m.indexable && (m.siteId === viewer.siteId || (switches.get(m.siteId) && switches.get(viewer.siteId)));
      const listed = visible(viewer) ? members.filter(visible) : [];
      const want = listed.map((m) => ({ siteId: viewer.siteId, itemId: viewer.itemId, locale: m.locale, url: m.url!, targetItemId: m.itemId }));
      if (xDefault && listed.includes(xDefault)) want.push({ siteId: viewer.siteId, itemId: viewer.itemId, locale: 'x-default', url: xDefault.url!, targetItemId: xDefault.itemId });
      if (await replaceAlternates(tx, viewer.siteId, viewer.itemId, want)) changedSites.add(viewer.siteId);
    }
  }
  for (const [itemId, siteId] of alsoItems) {
    if (handled.has(itemId)) continue;
    if (await replaceAlternates(tx, siteId, itemId, [])) changedSites.add(siteId);
  }
  return changedSites;
}

async function replaceAlternates(
  tx: Tx,
  siteId: string,
  itemId: string,
  want: Array<{ siteId: string; itemId: string; locale: string; url: string; targetItemId: string }>,
): Promise<boolean> {
  return withSiteScope(tx, siteId, async () => {
    const have = await tx.select().from(publicAlternates).where(and(eq(publicAlternates.siteId, siteId), eq(publicAlternates.itemId, itemId)));
    const key = (r: { targetItemId: string; locale: string; url: string }) => `${r.targetItemId}|${r.locale}|${r.url}`;
    const a = new Set(have.map(key));
    const b = new Set(want.map(key));
    if (a.size === b.size && [...a].every((k) => b.has(k))) return false;
    await tx.delete(publicAlternates).where(and(eq(publicAlternates.siteId, siteId), eq(publicAlternates.itemId, itemId)));
    if (want.length) await tx.insert(publicAlternates).values(want);
    return true;
  });
}

/** The groups of the items (current memberships), read in each item's site scope. */
async function groupsOfItems(tx: Tx, bySite: Map<string, Set<string>>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [siteId, ids] of bySite) {
    if (ids.size === 0) continue;
    const rows = await withSiteScope(tx, siteId, () =>
      tx.select({ groupId: translationGroupMembers.groupId }).from(translationGroupMembers).where(and(eq(translationGroupMembers.siteId, siteId), inArray(translationGroupMembers.itemId, [...ids]))),
    );
    for (const r of rows) out.add(r.groupId);
  }
  return out;
}

// ---------- whole site ----------

/** Hosts and the site row, then every item of the site, then its cross-site groups. Returns sites changed. */
async function refreshSite(tx: Tx, siteId: string): Promise<Set<string>> {
  const changed = new Set<string>();
  const [site] = await tx.select().from(sites).where(eq(sites.id, siteId));
  if (!site) {
    await tx.delete(publicHosts).where(eq(publicHosts.siteId, siteId));
    return changed;
  }
  await withSiteScope(tx, siteId, async () => {
    // Every row of the site is read and rewritten: no item write of the site may run meanwhile (they hold the settings
    // row shared until they commit), or this would write back what it read before that write. A no-op where the writer
    // took it first (rebuilds, content and SEO settings); a site-wide change of another kind takes it here.
    await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR UPDATE`);
    const domains = await tx
      .select({ hostname: siteDomains.hostname, isPrimary: siteDomains.isPrimary, entryLocale: siteDomains.entryLocale })
      .from(siteDomains)
      .where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active')));
    const primary = domains.find((d) => d.isPrimary)?.hostname ?? null;
    await tx.delete(publicHosts).where(eq(publicHosts.siteId, siteId));
    if (domains.length) {
      await tx.insert(publicHosts).values(domains.map((d) => ({ hostname: d.hostname, siteId, isPrimary: d.isPrimary, entryLocale: d.entryLocale, primaryHostname: primary })));
    }
    const [settings] = await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    const s = {
      availableLocales: settings?.availableLocales ?? [site.defaultLanguage],
      timezone: settings?.timezone ?? 'UTC',
      siteType: settings?.siteType ?? 'blog',
      trailingSlash: settings?.trailingSlash ?? 'always',
      localeStrategy: settings?.localeStrategy ?? 'subdirectory',
      localePrefixMode: settings?.localePrefixMode ?? 'default_at_root',
      localePrefixes: settings?.localePrefixes ?? {},
      permalinks: settings?.permalinks ?? {},
      sponsorDisclosure: settings?.sponsorDisclosure ?? true,
      sponsorRel: settings?.sponsorRel ?? true,
    };
    // The public part of the SEO / GEO settings (P07 task 1.4): the rendering service never reads the settings table.
    const [seoRow] = await tx.select({ settings: siteSeoSettings.settings }).from(siteSeoSettings).where(eq(siteSeoSettings.siteId, siteId));
    const seo = publicSeoSnapshot(effectiveSeoSettings(seoRow?.settings));
    // Whom the site speaks for (P07 task 2.12), all public; `{}` when none is set (nothing is made up).
    const [identityRow] = await tx.select({ identity: siteIdentity.identity }).from(siteIdentity).where(eq(siteIdentity.siteId, siteId));
    const identity = (effectiveSiteIdentity(identityRow?.identity) ?? {}) as Record<string, unknown>;
    // The site nodes its extensions contribute (P07 task 2.9), and what was left out of their contributions.
    const contributions = await siteContributions(tx, siteId);
    const structured = {
      ...(contributions.site.length ? { nodes: contributions.site } : {}),
      ...(contributions.diagnostics.length ? { diagnostics: distinctDiagnostics(contributions.diagnostics) } : {}),
    };
    // The routes, default templates and theme components of its enabled plugins (P12 tasks 2.3–2.5).
    const ext = await publicExtensionsOfSite(tx, siteId);
    const extensionsJson = (ext.hash ? ext : {}) as Record<string, unknown>;
    await tx
      .insert(publicSites)
      .values({ siteId, name: site.name, defaultLanguage: site.defaultLanguage, settings: s, seo, identity, structured, extensions: extensionsJson, builtAt: new Date() })
      .onConflictDoUpdate({ target: publicSites.siteId, set: { name: site.name, defaultLanguage: site.defaultLanguage, settings: s, seo, identity, structured, extensions: extensionsJson, builtAt: new Date() } });
    changed.add(siteId);
    const all = await tx.select({ id: items.id }).from(items).where(eq(items.siteId, siteId));
    const stale = await tx
      .select({ id: publicItems.itemId })
      .from(publicItems)
      .where(eq(publicItems.siteId, siteId));
    // Items gone from the base table whose last public path is remembered: their 410 (a hard delete past the services).
    const remembered = await tx.select({ id: publicPathMemory.itemId }).from(publicPathMemory).where(eq(publicPathMemory.siteId, siteId));
    const ids = [...new Set([...all.map((r) => r.id), ...stale.map((r) => r.id), ...remembered.map((r) => r.id)])];
    for (let i = 0; i < ids.length; i += 500) {
      if (await refreshItemsOfSite(tx, siteId, ids.slice(i, i + 500), new Set())) changed.add(siteId);
    }
  });
  const { groups, orphans } = await withSiteScope(tx, siteId, async () => {
    const members = await tx
      .select({ groupId: translationGroupMembers.groupId, itemId: translationGroupMembers.itemId })
      .from(translationGroupMembers)
      .where(eq(translationGroupMembers.siteId, siteId));
    const grouped = new Set(members.map((m) => m.itemId));
    // Language-switch rows of items no longer in any group (a membership removed past the services).
    const withRows = await tx.selectDistinct({ itemId: publicAlternates.itemId }).from(publicAlternates).where(eq(publicAlternates.siteId, siteId));
    return { groups: [...new Set(members.map((m) => m.groupId))], orphans: withRows.map((r) => r.itemId).filter((id) => !grouped.has(id)) };
  });
  for (const itemId of orphans) if (await replaceAlternates(tx, siteId, itemId, [])) changed.add(siteId);
  const hints = new Map(groups.map((g) => [g, new Set([siteId])]));
  for (const s of await refreshGroups(tx, groups, new Map(), hints)) changed.add(s);
  return changed;
}

// ---------- the flush ----------

interface DirtyRow {
  seq: number;
  site_id: string | null;
  table_name: string;
  op: string;
  object_id: string | null;
  old: Record<string, unknown> | null;
  new: Record<string, unknown> | null;
}

const SITE_WIDE = new Set([
  'lumibase_site_content_settings',
  'lumibase_site_seo_settings',
  'lumibase_site_identity',
  'lumibase_sites',
  'lumibase_site_domains',
  'lumibase_collections',
  'lumibase_fields',
  // P07 task 2.9: an extension with structured-data contributions enabled, upgraded, disabled or uninstalled (only those
  // are recorded, migration 0073) — its site nodes and every item it contributes to are materialised again. P12 tasks
  // 2.3–2.5: also one declaring routes or components (migration 0115) — the site's public extensions.
  'lumibase_extensions',
]);

/**
 * Refresh the projection from this transaction's change records and raise the render version of
 * every site whose public output changed. Call last, before the transaction commits; calling it
 * again later in the same transaction handles what was written since.
 */
export async function flushPublicProjection(tx: Tx): Promise<void> {
  const taken = (await tx.execute(sql`SELECT * FROM heopress_projection_take()`)) as unknown as DirtyRow[];
  if (taken.length === 0) return;
  const changed = new Set<string>();
  const siteWide = new Set<string>();
  const itemsBySite = new Map<string, Set<string>>();
  const deleted = new Set<string>();
  const groups = new Set<string>();
  const removedMembers = new Map<string, string>();
  const groupHints = new Map<string, Set<string>>();
  const hint = (groupId: unknown, sites: unknown[]) => {
    if (typeof groupId !== 'string') return;
    const set = groupHints.get(groupId) ?? new Set<string>();
    for (const x of sites) if (typeof x === 'string') set.add(x);
    groupHints.set(groupId, set);
  };
  const redirectSites = new Set<string>();
  const redirectSources: Array<{ siteId: string; locale: string; path: string }> = [];
  // Sites deleted in this transaction: their projection went with them (cascade); nothing to refresh.
  const goneSites = new Set(taken.filter((d) => d.table_name === 'lumibase_sites' && d.op === 'delete').map((d) => d.site_id).filter((x): x is string => !!x));
  for (const d of taken) {
    const site = d.site_id;
    if (!site || goneSites.has(site)) continue;
    if (SITE_WIDE.has(d.table_name)) {
      siteWide.add(site);
      continue;
    }
    switch (d.table_name) {
      case 'lumibase_items':
      case 'lumibase_content_routes': {
        const id = d.object_id ?? (d.new?.item_id as string | undefined) ?? (d.old?.item_id as string | undefined);
        if (!id) break;
        const set = itemsBySite.get(site) ?? new Set<string>();
        set.add(id);
        itemsBySite.set(site, set);
        if (d.table_name === 'lumibase_items' && (d.op === 'delete' || (d.new && d.new.deleted_at && !d.old?.deleted_at))) deleted.add(id);
        break;
      }
      case 'lumibase_redirects':
        redirectSites.add(site);
        if (d.new && d.new.scope === 'content') redirectSources.push({ siteId: site, locale: String(d.new.locale ?? ''), path: String(d.new.from_path ?? '') });
        break;
      case 'lumibase_translation_group_members':
        for (const g of [d.old?.group_id, d.new?.group_id]) if (typeof g === 'string') groups.add(g);
        if (d.op === 'delete' && d.object_id) removedMembers.set(d.object_id, site);
        // A member's internal-only mark decides whether it is public at all.
        if (d.object_id) {
          const set = itemsBySite.get(site) ?? new Set<string>();
          set.add(d.object_id);
          itemsBySite.set(site, set);
        }
        break;
      case 'lumibase_site_themes':
        // The active theme version moved (publish, switch, rollback): every page of the site renders anew.
        changed.add(site);
        break;
      case 'lumibase_site_root_files':
        // A root file written or deleted (P07 task 3.8): the rendering service reads it through its view; the version moves.
        changed.add(site);
        break;
      case 'lumibase_translation_groups':
        if (d.object_id) groups.add(d.object_id);
        hint(d.object_id, [site, ...((d.old?.site_ids as unknown[]) ?? []), ...((d.new?.site_ids as unknown[]) ?? [])]);
        break;
    }
  }
  for (const siteId of [...siteWide].sort()) for (const s of await refreshSite(tx, siteId)) changed.add(s);
  for (const [siteId, ids] of [...itemsBySite].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (siteWide.has(siteId)) continue;
    if (await refreshItemsOfSite(tx, siteId, [...ids].sort(), deleted)) changed.add(siteId);
  }
  // The language switch: the groups the items are in now, and those named by the records.
  for (const g of await groupsOfItems(tx, itemsBySite)) groups.add(g);
  for (const s of await refreshGroups(tx, groups, removedMembers, groupHints)) changed.add(s);
  // A redirect source covers a tombstone there (design R37): the rule answers instead of the 410.
  for (const r of redirectSources) {
    await withSiteScope(tx, r.siteId, () =>
      tx.delete(routeTombstones).where(and(eq(routeTombstones.siteId, r.siteId), eq(routeTombstones.locale, r.locale), eq(routeTombstones.path, r.path))),
    );
  }
  for (const s of redirectSites) changed.add(s);
  await bumpVersions(tx, changed);
  // Writes made by the refresh itself are projection tables (no triggers), so nothing new is recorded.
}

// ---------- rebuilds (design R18, R26, R37) ----------

/**
 * Rebuild a site's projection and clear the rebuild marks this run saw (a mark added meanwhile stays).
 * One transaction, the site's settings row held FOR UPDATE first (the lock order of every writer).
 */
export async function rebuildSiteProjection(db: Database, siteId: string): Promise<void> {
  // One snapshot for the marks and the base tables (design R37): only the marks this snapshot saw are cleared.
  // The snapshot can predate a writer this waits for at the lock: its serialization failure is retried (R30).
  await withMembershipRetry(() => runSiteTransaction(db, siteId, async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR UPDATE`);
    const marks = await tx.select({ seq: projectionRebuilds.seq }).from(projectionRebuilds).where(eq(projectionRebuilds.siteId, siteId));
    const [exists] = await tx.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId));
    if (!exists) {
      // Deleted since it was marked: only the marks remain to clear.
      if (marks.length) await tx.delete(projectionRebuilds).where(inArray(projectionRebuilds.seq, marks.map((m) => m.seq)));
      return;
    }
    const changed = await refreshSite(tx, siteId);
    changed.add(siteId);
    await bumpVersions(tx, changed);
    if (marks.length) await tx.delete(projectionRebuilds).where(inArray(projectionRebuilds.seq, marks.map((m) => m.seq)));
  }, { isolationLevel: 'repeatable read' }), { conflicts: true });
}

// Every site transaction flushes the projection before it commits.
setBeforeCommitHook(flushPublicProjection);

/**
 * Sites with a rebuild mark, longest waiting first, one at a time (the worker's loop and the CLI).
 * A site whose rebuild fails (retries exhausted, a broken row) keeps one mark, moved to the back of the
 * queue: it is tried again later and never holds the others back. `exclude` skips sites (the CLI's
 * failures of this run).
 */
export async function processProjectionRebuilds(
  db: Database,
  opts: { limit?: number; exclude?: Iterable<string> } = {},
): Promise<{ rebuilt: string[]; failed: string[] }> {
  const exclude = [...(opts.exclude ?? [])];
  const pending = await db
    .select({ siteId: projectionRebuilds.siteId, last: sql<number>`max(${projectionRebuilds.seq})`.mapWith(Number) })
    .from(projectionRebuilds)
    .where(exclude.length ? notInArray(projectionRebuilds.siteId, exclude) : undefined)
    .groupBy(projectionRebuilds.siteId)
    .orderBy(asc(sql`min(${projectionRebuilds.seq})`))
    .limit(opts.limit ?? 50);
  const out = { rebuilt: [] as string[], failed: [] as string[] };
  for (const { siteId, last } of pending) {
    try {
      await rebuildSiteProjection(db, siteId);
      out.rebuilt.push(siteId);
    } catch (err) {
      out.failed.push(siteId);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[projection] rebuild of site ${siteId} failed; it stays marked:`, message);
      await db.transaction(async (tx) => {
        await tx.delete(projectionRebuilds).where(and(eq(projectionRebuilds.siteId, siteId), lte(projectionRebuilds.seq, last)));
        await tx.insert(projectionRebuilds).values({ siteId, reason: `retry: ${message.slice(0, 200)}` });
      });
    }
  }
  return out;
}

/** Build every site that has never been built (first deployment, design R18). */
export async function buildAllProjections(db: Database): Promise<number> {
  const rows = await db
    .select({ id: sites.id })
    .from(sites)
    .leftJoin(publicSites, eq(publicSites.siteId, sites.id))
    .where(isNull(publicSites.builtAt));
  for (const { id } of rows) await rebuildSiteProjection(db, id);
  return rows.length;
}

/**
 * `db.transaction(fn)` for writers that do not use `runSiteTransaction` (one transaction over several
 * sites, or a caller-shaped one): the public projection is flushed last, before the commit.
 */
export function projectedTransaction<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // The refresh may start it over (a site joined a group meanwhile), as every site transaction.
  return retryTransaction(
    () =>
      db.transaction(async (tx) => {
        const out = await fn(tx);
        await flushPublicProjection(tx);
        return out;
      }),
    { conflicts: !isTransaction(db) },
  );
}
