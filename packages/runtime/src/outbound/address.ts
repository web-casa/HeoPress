/**
 * Classify IP addresses for outbound requests (HeoPress P03 task 4.4,
 * platform/outbound-security). Parses to bytes, so textual tricks (IPv4-mapped
 * IPv6, NAT64, 6to4, leading zeros) cannot hide an internal address.
 *
 *   metadata — cloud instance-metadata endpoints. Always refused, even for a
 *              trusted internal service.
 *   internal — loopback, private, link-local, CGNAT, unique-local,
 *              documentation, benchmarking, multicast, reserved and other
 *              non-public ranges. Refused unless the request is a service
 *              connection to a trusted origin.
 *   public   — everything else.
 */
import { isIP } from 'node:net';

export type AddressClass = 'public' | 'internal' | 'metadata';

/** Instance-metadata services (AWS, GCP, Azure, Oracle, Alibaba, ECS task metadata). */
const METADATA_V4 = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200']);
const METADATA_V6 = ['fd00:ec2::254'];

/** Non-public IPv4 ranges: [first octets as a 32-bit int, prefix length]. */
const INTERNAL_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

/** Non-public IPv6 ranges (after embedded-IPv4 forms are unwrapped). */
const INTERNAL_V6: Array<[string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001::', 23], // IETF special purpose (incl. Teredo 2001::/32)
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation (RFC 9637)
  ['5f00::', 16], // segment routing SIDs
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4(ip: number, base: string, prefix: number): boolean {
  const b = v4ToInt(base)!;
  if (prefix === 0) return true;
  const size = 2 ** (32 - prefix);
  return Math.floor(ip / size) === Math.floor(b / size);
}

/** Expand an IPv6 literal to 16 bytes. Returns null when it is not valid IPv6. */
function v6ToBytes(raw: string): number[] | null {
  let ip = raw.split('%')[0]!; // zone index
  if (isIP(ip) !== 6) return null;
  // Embedded dotted quad (::ffff:1.2.3.4) → two hextets.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    if (n === null) return null;
    ip = `${ip.slice(0, -dotted[1]!.length)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = ip.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

function inV6(bytes: number[], base: string, prefix: number): boolean {
  const b = v6ToBytes(base)!;
  let bits = prefix;
  for (let i = 0; i < 16 && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((bytes[i]! & mask) !== (b[i]! & mask)) return false;
    bits -= take;
  }
  return true;
}

function classifyV4(ip: string): AddressClass {
  const n = v4ToInt(ip);
  if (n === null) return 'internal'; // not a canonical dotted quad: refuse
  if (METADATA_V4.has(ip)) return 'metadata';
  return INTERNAL_V4.some(([base, prefix]) => inV4(n, base, prefix)) ? 'internal' : 'public';
}

function embeddedV4(bytes: number[]): string | null {
  const v4 = (offset: number) => bytes.slice(offset, offset + 4).join('.');
  const zero = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated)
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return v4(12);
  if (zero(0, 12) && !zero(12, 16) && !(zero(12, 15) && bytes[15] === 1)) return v4(12);
  // ::ffff:0:a.b.c.d (SIIT)
  if (zero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zero(10, 12)) return v4(12);
  // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48 (local NAT64, last 4 bytes)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return v4(12);
  // 2002::/16 (6to4): bytes 2–5
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4(2);
  return null;
}

/** Classify an IP literal (v4 or v6, brackets allowed). Anything unparseable is `internal`. */
export function classifyAddress(raw: string): AddressClass {
  const ip = raw.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (isIP(ip) === 4) return classifyV4(ip);
  const bytes = v6ToBytes(ip);
  if (!bytes) return 'internal';
  if (METADATA_V6.some((m) => inV6(bytes, m, 128))) return 'metadata';
  const v4 = embeddedV4(bytes);
  if (v4) return classifyV4(v4);
  return INTERNAL_V6.some(([base, prefix]) => inV6(bytes, base, prefix)) ? 'internal' : 'public';
}

export function isIpLiteral(host: string): boolean {
  return isIP(host.replace(/^\[/, '').replace(/\]$/, '')) !== 0;
}

/** Host names that are metadata endpoints whatever they resolve to. */
export const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata', 'metadata.azure.internal']);
