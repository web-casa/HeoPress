/**
 * URL normalisation for deduplication (HeoPress P08 tasks 4.1, 4.3; spec ingest/deduplication "精确去重", design
 * decision 7 and "数据隔离与去重边界").
 *
 * Only what cannot change the resource is normalised:
 *
 *   - scheme and host lower-cased (the WHATWG parser does both), the default port dropped, the fragment dropped;
 *   - **configured** tracking parameters removed (`utm_*`, `fbclid`, `gclid`, … plus `HEOPRESS_INGEST_TRACKING_PARAMS`),
 *     every other parameter kept in its order;
 *   - nothing else: the path keeps its case (`/A` ≠ `/a`), functional parameters stay (`?id=1` ≠ `?id=2`), a trailing
 *     slash stays as it is (`/news` ≠ `/news/`).
 *
 * A page's `<link rel="canonical">` is a candidate only: it is stored (`canonical_candidate`) but never fetched and
 * never used to merge URLs by itself. Two URLs end up as one source document only when their normalised bodies are
 * equal (`source-documents.ts`), so a cross-origin, case-changing or query-changing canonical cannot merge anything.
 */

/** Names removed from every URL; an entry ending in `*` is a prefix. */
export const DEFAULT_TRACKING_PARAMS: readonly string[] = [
  'utm_*',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'spm',
];

/** The default list plus `HEOPRESS_INGEST_TRACKING_PARAMS` (comma separated). */
export function trackingParamsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.HEOPRESS_INGEST_TRACKING_PARAMS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...DEFAULT_TRACKING_PARAMS, ...extra])];
}

function isTracking(name: string, params: readonly string[]): boolean {
  const n = name.toLowerCase();
  return params.some((p) => (p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p));
}

/** The normalised form of an http(s) URL; null when it is not a valid http(s) URL. */
export function normalizeUrl(input: string, params: readonly string[] = DEFAULT_TRACKING_PARAMS): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  // `URL` already drops a default port and lower-cases scheme and host; it keeps path case and trailing slashes.
  if (url.search) {
    // Rebuild from the raw query so kept parameters stay byte-for-byte (no re-encoding of `+`, `%20`, …).
    const kept = url.search
      .slice(1)
      .split('&')
      .filter((pair) => {
        if (!pair) return false;
        const raw = pair.split('=')[0] ?? '';
        let name = raw;
        try {
          name = decodeURIComponent(raw.replace(/\+/g, ' '));
        } catch {
          /* keep the raw name */
        }
        return !isTracking(name, params);
      });
    url.search = kept.length ? `?${kept.join('&')}` : '';
  }
  return url.href;
}
