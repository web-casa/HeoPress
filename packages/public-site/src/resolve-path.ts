import type { SitePathSpace } from './path-space';
import { encodedPath, MAX_URL_PATH } from './permalink-path';
import { ancestorsOf, followRules, pathOf, stepLimit, type EngineRule, type Loc } from './redirect-engine';

/**
 * Public path resolution (HeoPress P05 tasks 1.6, 3.1, 3.3–3.5, design B, R33–R37; moved here in P06
 * task 1.1 so the CMS and the rendering service share it): a request's host, path and query become an
 * item to render, ONE 301 to the final address, gone (410), or not found.
 *
 * In one pass, in memory: a plain alias host goes to the primary domain; the language comes from the
 * host (language entry domain, or the primary domain under the subdomain and domain strategies) or the
 * path prefix (subdirectory strategy); URL-layer rules, the strategy's language rules and content-layer
 * rules (mapped to external paths) are applied by priority until none matches, a live item answering at
 * a location ending it; the trailing slash policy is applied to the end. Whatever changed, the answer is
 * a single 301 to the serialised end (query kept), which is a fixed point: requesting it again resolves
 * to the same place without a redirect. A loop or the step guard is not found, with a warning.
 *
 * The language never comes from `Accept-Language`: the input has no headers (spec i18n/locale-routing
 * "不按浏览器语言替换内容").
 *
 * The data comes through a `PublicReadPort`: the CMS reads its own tables, the rendering service the
 * public projection (P06 design Q1).
 */

export interface PublicPathRequest {
  host: string;
  /** The request path as sent (percent-encoded), without the query. */
  path: string;
  /** The query string without `?` (kept on a redirect). */
  query?: string;
}

/** Where a request ended inside the site: its language and its content path (no prefix). */
export interface ContentLocation {
  locale: string;
  contentPath: string;
}

export type PublicPathResult =
  | { kind: 'item'; siteId: string; locale: string; itemId: string; collection: string; url: string }
  | { kind: 'redirect'; status: 301; siteId: string; location: string }
  | { kind: 'gone'; siteId: string; at: ContentLocation }
  | {
      kind: 'not_found';
      siteId: string | null;
      reason: 'unknown_host' | 'bad_path' | 'no_route' | 'redirect_loop' | 'step_limit';
      /**
       * For `no_route`: where it ended, its canonical URL and whether the request was already that address
       * (the renderer's own pages — home, search — answer there, after a 301 to the canonical form).
       */
      at?: ContentLocation;
      url?: string;
      canonical?: boolean;
    };

export interface PublicHostResolution {
  siteId: string;
  hostname: string;
  isPrimary: boolean;
  entryLocale: string | null;
  /** The site's primary domain, when it has one. */
  primaryHostname: string | null;
}

/** A redirect row as the resolver needs it. */
export interface RedirectRow {
  id: string;
  scope: string;
  locale: string;
  fromPath: string;
  match: string;
  toPath: string;
  toLocale: string;
}

/** One site's public data, read in that site's scope (one transaction). */
export interface SiteReader {
  /** The site's path space; `primaryHost` stands in when the site has no primary domain. */
  space(primaryHost: string): Promise<SitePathSpace>;
  /** The size of the site's rule set for the step guard (R33, R37). */
  ruleStats(): Promise<{ ruleCount: number; maxTarget: number }>;
  /** URL rules from any of `urlPaths`, and content rules of `content.locale` from any of `content.paths`. */
  redirectsFrom(urlPaths: string[], content: { locale: string; paths: string[] } | null): Promise<RedirectRow[]>;
  /** The live public item at a content path of a language. */
  liveItemAt(locale: string, contentPath: string): Promise<{ itemId: string; locale: string; collection: string } | null>;
  /** Whether a once-public item was deleted at this content path (410). Without it, never. */
  goneAt?(locale: string, contentPath: string): Promise<boolean>;
}

export interface PublicReadPort {
  /** An active host of a site (no fallback to a default site). */
  host(hostname: string): Promise<PublicHostResolution | null>;
  /** Run `fn` with the site's reader (in the site's scope). */
  inSite<T>(siteId: string, fn: (reader: SiteReader) => Promise<T>): Promise<T>;
}

/** `Host` normalised: lowercase, no port, no trailing dot. */
export function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/** The public URL of a content path of the site (`https://host/path` under its policies), or null when the language has no address. */
export function publicUrlOf(space: SitePathSpace, locale: string, contentPath: string): string | null {
  const loc = space.externalOf(locale, contentPath);
  if (!loc || loc.host.endsWith('.invalid')) return null;
  const slash = space.canonicalPath(loc.path) !== loc.path;
  const finalPath = encodedPath(loc.path, slash);
  return finalPath.length > MAX_URL_PATH ? null : `https://${loc.host}${finalPath}`;
}

/**
 * Every public URL a content path of the site answers at, its canonical one first (`publicUrlOf`), then its language
 * entry domain's under the subdirectory strategy (`SitePathSpace.addressesOf`) — the same policies (HeoPress P07 task
 * 3.9: the reachability check requests each host at its own addresses).
 */
export function publicUrlsOf(space: SitePathSpace, locale: string, contentPath: string): string[] {
  const out: string[] = [];
  for (const loc of space.addressesOf(locale, contentPath)) {
    if (loc.host.endsWith('.invalid')) continue;
    const finalPath = encodedPath(loc.path, space.canonicalPath(loc.path) !== loc.path);
    if (finalPath.length <= MAX_URL_PATH) out.push(`https://${loc.host}${finalPath}`);
  }
  return out;
}

/** Bare decoded path and whether the request had a trailing slash, or null for a path no route can have. */
function parsePath(raw: string): { path: string; trailingSlash: boolean } | null {
  if (!raw.startsWith('/') || raw.length > MAX_URL_PATH) return null;
  const trailingSlash = raw.length > 1 && raw.endsWith('/');
  const body = trailingSlash ? raw.slice(1, -1) : raw.slice(1);
  if (body === '') return { path: '/', trailingSlash };
  const segments: string[] = [];
  for (const s of body.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      return null;
    }
    if (decoded === '' || decoded === '.' || decoded === '..' || decoded.includes('/')) return null;
    segments.push(decoded);
  }
  return { path: pathOf(segments), trailingSlash };
}

export async function resolvePublicPathWith(port: PublicReadPort, request: PublicPathRequest): Promise<PublicPathResult> {
  const requestHost = normalizeHost(request.host);
  const hostInfo = await port.host(requestHost);
  if (!hostInfo) return { kind: 'not_found', siteId: null, reason: 'unknown_host' };
  const siteId = hostInfo.siteId;
  const parsed = parsePath(request.path);
  if (!parsed) return { kind: 'not_found', siteId, reason: 'bad_path' };

  return port.inSite(siteId, async (reader) => {
    const space = await reader.space(hostInfo.primaryHostname ?? requestHost);
    const { ruleCount, maxTarget } = await reader.ruleStats();

    let start: Loc = { host: requestHost, path: parsed.path };
    let hostChanged = false;
    // A plain alias (not primary, not a language entry) answers at the primary domain (P04).
    if (!hostInfo.isPrimary && !hostInfo.entryLocale && hostInfo.primaryHostname) {
      start = { host: hostInfo.primaryHostname, path: parsed.path };
      hostChanged = true;
    }

    let found: { itemId: string; locale: string; collection: string } | null = null;
    const system = space.systemRules();
    const candidates = async (loc: Loc): Promise<EngineRule[]> => {
      const at = space.detect(loc);
      const rows = await reader.redirectsFrom(ancestorsOf(loc.path), at ? { locale: at.locale, paths: ancestorsOf(at.contentPath) } : null);
      const out: EngineRule[] = [...system];
      for (const r of rows) {
        if (r.scope === 'url') out.push({ id: r.id, layer: 'url', host: loc.host, toHost: loc.host, from: r.fromPath, match: r.match as 'exact', to: r.toPath });
        else out.push(...space.contentRule(r).filter((e) => e.host === loc.host));
      }
      return out;
    };
    const result = await followRules(start, candidates, {
      // System rules count as rules; content targets may gain a language prefix segment.
      limit: stepLimit(ruleCount + system.length, parsed.path, maxTarget + 1),
      stop: async (loc) => {
        const at = space.detect(loc);
        found = at ? await reader.liveItemAt(at.locale, at.contentPath) : null;
        return found !== null;
      },
    });
    if (result.kind !== 'end') {
      console.warn('[public-path] redirect resolution stopped', { siteId, host: requestHost, path: request.path, reason: result.kind, steps: result.steps });
      return { kind: 'not_found', siteId, reason: result.kind === 'loop' ? 'redirect_loop' : 'step_limit' };
    }

    const end = result.loc;
    const slash = space.canonicalPath(end.path) !== end.path;
    const finalPath = encodedPath(end.path, slash);
    // An address no request can reach (longer than a request may be) is not served, nor redirected to.
    if (finalPath.length > MAX_URL_PATH) return { kind: 'not_found', siteId, reason: 'bad_path' };
    const url = `https://${end.host}${finalPath}`;
    const moved = hostChanged || result.steps > 0;
    const requestCanonical = parsed.path === '/' || parsed.trailingSlash === slash;
    const item = found as { itemId: string; locale: string; collection: string } | null;
    if (item && !moved && requestCanonical) return { kind: 'item', siteId, ...item, url };
    if (item || moved) return { kind: 'redirect', status: 301, siteId, location: request.query ? `${url}?${request.query}` : url };
    const at = space.detect(end);
    // A deleted once-public item answers 410 at its last public address (P06 design R22): no rule took the request elsewhere.
    if (at && reader.goneAt && (await reader.goneAt(at.locale, at.contentPath))) return { kind: 'gone', siteId, at };
    return { kind: 'not_found', siteId, reason: 'no_route', ...(at ? { at, url, canonical: requestCanonical } : {}) };
  });
}
