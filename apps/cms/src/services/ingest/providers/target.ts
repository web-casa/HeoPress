import dns from 'node:dns';
import { classifyAddress, OutboundBlockedError, type AddressClass } from '@heopress/runtime/node';

/**
 * The normal outbound check for a URL a crawl service will fetch for us (HeoPress P08 task 3.6; spec ingest/crawling
 * "外部采集服务插件": "插件不能绕过 URL 安全检查"). The service would connect from its own network, so the platform
 * boundary never sees that connection: the check runs here, before the URL is sent — http(s) only, no credentials,
 * no localhost or metadata names, and **every** address the host resolves to public. Content URLs are never trusted
 * internal endpoints (ADR-0014), so there is no exception. Used for the target and again for the final URL the
 * service reports.
 */
export type TargetResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolve: TargetResolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });
const METADATA = new Set(['metadata.google.internal', 'metadata', 'metadata.azure.internal']);

export async function assertPublicTarget(
  raw: string,
  opts: { resolve?: TargetResolver; classify?: (ip: string) => AddressClass } = {},
): Promise<URL> {
  const classify = opts.classify ?? classifyAddress;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundBlockedError('URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OutboundBlockedError('only http and https URLs are allowed');
  if (url.username || url.password) throw new OutboundBlockedError('URLs with embedded credentials are not allowed');
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) throw new OutboundBlockedError('URL host is required');
  if (METADATA.has(host)) throw new OutboundBlockedError('cloud metadata hosts are never allowed');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new OutboundBlockedError('localhost is not allowed');
  const addresses = /^[\d.]+$/.test(host) || host.includes(':') ? [{ address: host, family: host.includes(':') ? 6 : 4 }] : await (opts.resolve ?? defaultResolve)(host);
  if (!addresses.length) throw Object.assign(new Error(`${host} resolved to no addresses`), { code: 'ENOTFOUND' });
  for (const a of addresses) {
    const cls = classify(a.address);
    if (cls !== 'public') throw new OutboundBlockedError(`${host} resolves to a ${cls === 'metadata' ? 'cloud metadata' : 'non-public'} address`);
  }
  return url;
}
