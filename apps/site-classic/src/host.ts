import { BlockList, isIP } from 'node:net';
import { normalizeHost } from '@heopress/public-site';

/**
 * The request's host (HeoPress P04 spec sites/domain-routing "域名归属与可信 Host"; P06 task 7.3): the
 * `Host` header, or `X-Forwarded-Host` only when the connection comes from a configured trusted proxy
 * (`HEOPRESS_TRUSTED_PROXIES`: addresses and CIDR ranges, comma-separated). A client cannot point the
 * request at another site with a header.
 */
export function trustedProxies(csv: string | undefined): BlockList {
  const list = new BlockList();
  for (const raw of (csv ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const parts = entry.split('/');
    if (parts.length > 2) continue;
    const [address, prefix] = parts;
    const family = isIP(address!) === 6 ? 'ipv6' : isIP(address!) === 4 ? 'ipv4' : null;
    if (!family) continue;
    if (prefix === undefined) list.addAddress(address!, family);
    // A prefix out of range is skipped like any other malformed entry (it would make addSubnet throw).
    else if (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 'ipv4' ? 32 : 128)) list.addSubnet(address!, Number(prefix), family);
  }
  return list;
}

function isTrusted(list: BlockList, peer: string | undefined): boolean {
  if (!peer) return false;
  const address = peer.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  const family = isIP(address) === 6 ? 'ipv6' : isIP(address) === 4 ? 'ipv4' : null;
  return family !== null && list.check(address, family);
}

/**
 * The visitor's address: the right-most `X-Forwarded-For` value when the connection comes from a trusted proxy (the one
 * that proxy wrote), else the peer (P07 task 6.1: only hashed, never stored).
 */
export function clientAddress(forwardedFor: string | null | undefined, peer: string | undefined, trusted: BlockList): string | null {
  const fromProxy = isTrusted(trusted, peer) ? forwardedFor?.split(',').pop()?.trim() || undefined : undefined;
  return fromProxy ?? peer ?? null;
}

export function requestHost(headers: { host?: string | null; forwardedHost?: string | null }, peer: string | undefined, trusted: BlockList): string | null {
  // The right-most value: the one the nearest proxy (trusted) wrote; values to its left may come from the
  // client when a proxy appends instead of replacing. An empty value falls back to the Host header.
  const fromProxy = isTrusted(trusted, peer) ? headers.forwardedHost?.split(',').pop()?.trim() || undefined : undefined;
  const host = normalizeHost(fromProxy ?? headers.host ?? '');
  return host || null;
}

/**
 * The raw request target, as sent (not normalised by URL parsing: `..` and empty segments are the
 * resolver's to refuse). Origin-form `/path?query`, or absolute-form `http://authority/path?query`, whose
 * authority — a plain host name and optional port, nothing else — then stands for the Host header (RFC
 * 9112 §3.2.2). Anything else (`*`, authority-form, userinfo, an IP literal in brackets) is null.
 */
export function parseTarget(raw: string): { authority: string | null; path: string; query: string } | null {
  let authority: string | null = null;
  let rest = raw;
  const absolute = /^https?:\/\/([^/?#]*)(.*)$/i.exec(raw);
  if (absolute) {
    // A host and an optional port, nothing else: userinfo, backslashes and the like are parsed differently by
    // different URL parsers, and a proxy or cache in front could then take the request for another site.
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(absolute[1]!)) return null;
    authority = absolute[1]!;
    rest = absolute[2] || '/';
    if (rest.startsWith('?')) rest = `/${rest}`;
  }
  if (!rest.startsWith('/')) return null;
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  const q = rest.indexOf('?');
  return { authority, path: q >= 0 ? rest.slice(0, q) : rest, query: q >= 0 ? rest.slice(q + 1) : '' };
}
