import { normalizeHost } from '@heopress/public-site';
import type { PublicItemRow } from './read-port';

/**
 * Previews (HeoPress P06 tasks 4.2, 4.3; spec rendering/preview; design R7, R17, R29, R43): served only on
 * the preview origin, never on a site's public host. The rendering role cannot read drafts or unpublished
 * theme versions: the CMS's internal preview endpoint answers, after checking the link (site, expiry,
 * revocation, the creator's current permission) — on every request, not only the first.
 *
 *   GET <origin>/<site id>/<token>                              exchange: an HttpOnly cookie scoped to
 *                                                               `/<site id>/`, then 303 to the token-less view
 *   GET <origin>/<site id>/view                                 the preview page
 *   GET <origin>/<site id>/assets/<version>/<sha256>.<ext>      a theme asset the page uses
 *
 * Every answer — 403, 303 and assets included — is private and not stored, not indexed, sends no
 * referrer, and runs under a CSP without scripts, connections, forms or frames.
 */

export interface PreviewOptions {
  /** `HEOPRESS_PREVIEW_ORIGIN`, `https://preview.example.com`. */
  origin: string;
  /** The CMS as the rendering service reaches it (`HEOPRESS_CMS_INTERNAL_URL`). */
  cmsUrl: string;
  /** `HEOPRESS_INTERNAL_SECRET`. */
  secret: string;
  /** Origins preview pages may load images and media from (the media host), besides the preview itself. */
  media?: string[];
  /** The administration origin (`HEOPRESS_PUBLIC_URL`): the preview origin must differ from it. */
  adminOrigin?: string;
  fetch?: typeof fetch;
}

export interface PreviewConfig {
  origin: string;
  host: string;
  media: string[];
  cms(path: 'resolve' | 'asset', body: Record<string, unknown>): Promise<Response>;
}

export const PREVIEW_COOKIE = 'heopress_preview';

/** The preview origin, checked; null (previews off, logged) when unusable or the same as the admin origin. */
export function previewConfig(opts: PreviewOptions): PreviewConfig | null {
  let origin: URL;
  try {
    origin = new URL(opts.origin);
  } catch {
    console.error('[site-classic] HEOPRESS_PREVIEW_ORIGIN is not a URL: previews are off');
    return null;
  }
  const admin = opts.adminOrigin ? new URL(opts.adminOrigin) : null;
  if (admin && normalizeHost(admin.host) === normalizeHost(origin.host)) {
    console.error('[site-classic] the preview origin must differ from the administration origin: previews are off');
    return null;
  }
  if (opts.secret.length < 32) {
    console.error('[site-classic] HEOPRESS_INTERNAL_SECRET must have 32 characters or more: previews are off');
    return null;
  }
  const media = (opts.media ?? []).flatMap((m) => {
    try {
      return [new URL(m).origin];
    } catch {
      return [];
    }
  });
  const doFetch = opts.fetch ?? fetch;
  const base = opts.cmsUrl.replace(/\/+$/, '');
  return {
    origin: origin.origin,
    host: normalizeHost(origin.host),
    media,
    // The token goes in the body (never a URL that a log could keep).
    cms: (path, body) =>
      doFetch(`${base}/internal/preview/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-heopress-internal-secret': opts.secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      }),
  };
}

/** The headers of every preview answer. */
export function previewHeaders(config: PreviewConfig): Record<string, string> {
  const img = ["'self'", 'data:', ...config.media].join(' ');
  return {
    'cache-control': 'no-store, private',
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; script-src 'none'; connect-src 'none'; img-src ${img}; media-src ${img}; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
  };
}

/** The preview cookie's token, if the request carries one. */
export function previewToken(cookieHeader: string | undefined): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === PREVIEW_COOKIE) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : null;
    }
  }
  return null;
}

export type PreviewTarget =
  | { kind: 'item'; siteId: string; expiresAt: string; item: PublicItemRow }
  | {
      kind: 'theme';
      siteId: string;
      expiresAt: string;
      theme: { versionId: string; templates: Record<string, string>; assets: Array<{ path: string; sha256: string; contentType: string; size: number }> };
    };

/** Ask the CMS what the link shows: the target, `denied` (403 for any reason), or `failed` (the CMS is unavailable). */
export async function resolvePreview(config: PreviewConfig, siteId: string, token: string): Promise<PreviewTarget | 'denied' | 'failed'> {
  let res: Response;
  try {
    res = await config.cms('resolve', { site_id: siteId, token });
  } catch {
    return 'failed';
  }
  if (res.status === 403 || res.status === 400) return 'denied';
  if (!res.ok) return 'failed';
  const { data } = (await res.json()) as { data: PreviewTarget };
  if (data.siteId !== siteId) return 'denied';
  if (data.kind === 'item') {
    const item = data.item as unknown as Record<string, unknown>;
    // Dates arrive as strings.
    for (const k of ['publishedAt', 'updatedAt'] as const) item[k] = typeof item[k] === 'string' ? new Date(item[k]) : null;
  }
  return data;
}

/**
 * Branch previews on a site's public host (HeoPress P10 tasks 4.2, 4.4; spec agents/content-branches): a browser that
 * traded a one-time link for the signed `heopress_branch_preview` cookie sees one branch's version of one item; every
 * other visitor, and every other page, is the public site. The cookie is checked here (signature, site, expiry) before
 * the CMS is asked, and by the CMS (grant, branch, the creator's current permission) on every request. A branch page is
 * never read from or written to any cache and is answered `no-store, private` and `noindex`.
 */
export interface BranchPreviewPort {
  secret: string;
  cms(path: 'branch-exchange' | 'branch-resolve', body: Record<string, unknown>): Promise<Response>;
}

export function branchPreviewPort(opts: PreviewOptions | undefined): BranchPreviewPort | null {
  if (!opts || opts.secret.length < 32 || !opts.cmsUrl) return null;
  const doFetch = opts.fetch ?? fetch;
  const base = opts.cmsUrl.replace(/\/+$/, '');
  return {
    secret: opts.secret,
    cms: (path, body) =>
      doFetch(`${base}/internal/preview/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-heopress-internal-secret': opts.secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      }),
  };
}

/** The headers of every branch preview answer (the exchange, the branch page, a refusal). */
export const BRANCH_PREVIEW_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, private',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
};

export interface BranchTarget {
  siteId: string;
  versionId: string;
  expiresAt: string;
  path: string;
  item: PublicItemRow;
}

/** Ask the CMS for the branch page of a cookie: the target, `denied`, or `failed`. */
export async function resolveBranch(port: BranchPreviewPort, siteId: string, cookie: string): Promise<BranchTarget | 'denied' | 'failed'> {
  let res: Response;
  try {
    res = await port.cms('branch-resolve', { site_id: siteId, token: cookie });
  } catch {
    return 'failed';
  }
  if (res.status === 403 || res.status === 400) return 'denied';
  if (!res.ok) return 'failed';
  const { data } = (await res.json()) as { data: BranchTarget };
  if (data.siteId !== siteId) return 'denied';
  const item = data.item as unknown as Record<string, unknown>;
  for (const k of ['publishedAt', 'updatedAt'] as const) item[k] = typeof item[k] === 'string' ? new Date(item[k]) : null;
  return data;
}
