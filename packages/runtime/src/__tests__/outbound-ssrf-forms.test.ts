import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyAddress, type AddressClass } from '../outbound/address';
import {
  OutboundBlockedError,
  guardedLookup,
  outboundBlockOf,
  outboundFetch,
  parseTrustedEndpoints,
  serviceEndpointPolicy,
  type HostResolver,
} from '../outbound/fetch';

/**
 * SSRF suite of the v1 security review (HeoPress P13 task 3.3, docs/reviews/v1-security.md): the address and URL
 * forms an attacker uses to name an internal target — numeric IPv4 spellings, IPv4 inside IPv6, schemes other than
 * http(s), trailing-dot and upper-case host names — plus DNS rebinding between two connections, and the connect-time
 * lookup that clients with their own HTTP stack (the S3 adapter) use. Complements `outbound.test.ts`; nothing here
 * leaves this machine: the only server listens on 127.0.0.1 and host names are resolved by test hooks or are
 * `localhost` itself.
 */

const noTrust = parseTrustedEndpoints('');

let target: Server;
let port = 0;
let hits = 0;
beforeAll(async () => {
  target = createServer((_req, res) => {
    hits += 1;
    res.end('reached');
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  port = (target.address() as AddressInfo).port;
});
afterAll(async () => {
  target.closeAllConnections();
  await new Promise<void>((r) => target.close(() => r()));
});

const blocked = async (url: string, extra: Parameters<typeof outboundFetch>[1] = {}) => {
  const before = hits;
  const err = await outboundFetch(url, { trusted: noTrust, timeoutMs: 3_000, ...extra }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(outboundBlockOf(err), `${url} must be refused by the boundary`).toBeInstanceOf(OutboundBlockedError);
  expect(hits, `${url}: nothing may reach the target`).toBe(before);
};

describe('numeric and alternative spellings of internal IPv4 addresses', () => {
  // The WHATWG URL parser (used by fetch and by the boundary) turns each of these into a dotted quad first.
  it.each([
    ['decimal', 'http://2130706433:PORT/'],
    ['octal', 'http://0177.0.0.1:PORT/'],
    ['hexadecimal', 'http://0x7f.0.0.1:PORT/'],
    ['hexadecimal integer', 'http://0x7f000001:PORT/'],
    ['short form', 'http://127.1:PORT/'],
    ['zero network', 'http://0.0.0.0:PORT/'],
    ['zero short form', 'http://0:PORT/'],
    ['private, decimal', 'http://167772161/'],
    ['metadata, decimal', 'http://2852039166/latest/meta-data/'],
    ['metadata, hexadecimal', 'http://0xa9fea9fe/latest/meta-data/'],
  ])('%s: %s', async (_label, raw) => {
    await blocked(raw.replace('PORT', String(port)));
  });
});

describe('IPv4 inside IPv6 and other IPv6 forms', () => {
  it.each([
    'http://[::1]:PORT/',
    'http://[::]:PORT/',
    'http://[::ffff:127.0.0.1]:PORT/',
    'http://[::ffff:7f00:1]:PORT/',
    'http://[0:0:0:0:0:ffff:127.0.0.1]:PORT/',
    'http://[::ffff:169.254.169.254]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[fd00:ec2::254]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
  ])('%s', async (raw) => {
    await blocked(raw.replace('PORT', String(port)));
  });

  it('classifies the forms the URL parser produces (compressed hextets) the same as the dotted forms', () => {
    expect(new URL('http://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::7f00:1']) expect(classifyAddress(ip)).not.toBe('public');
    expect(classifyAddress('::ffff:a9fe:a9fe')).toBe('metadata');
  });
});

describe('schemes and host names', () => {
  it.each([
    'file:///etc/passwd',
    'gopher://127.0.0.1:70/_GET',
    'ftp://example.com/file',
    'data:text/plain,hello',
    'ws://example.com/',
    'javascript:alert(1)',
    'dict://127.0.0.1:11211/stat',
  ])('%s is not http(s)', async (raw) => {
    await blocked(raw);
  });

  it.each([
    'http://LOCALHOST:PORT/',
    'http://LocalHost:PORT/',
    'http://localhost.:PORT/',
    'http://api.localhost:PORT/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://METADATA.GOOGLE.INTERNAL/computeMetadata/v1/',
  ])('%s', async (raw) => {
    await blocked(raw.replace('PORT', String(port)));
  });

  it('credentials in the URL are refused, whatever the host', async () => {
    await blocked(`http://user:pass@example.com/`);
    await blocked(`http://user@example.com/`);
  });
});

describe('DNS rebinding', () => {
  it('a name that was public for one connection and internal for the next is refused on the second, at connect time', async () => {
    let calls = 0;
    const resolve: HostResolver = async () => {
      calls += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    // 127.0.0.1 counts as public for the first connection only.
    const classify = (ip: string): AddressClass => (ip === '127.0.0.1' ? (calls <= 1 ? 'public' : 'internal') : classifyAddress(ip));
    const url = `http://rebind.example.test:${port}/`;
    const first = await outboundFetch(url, { trusted: noTrust, resolve, classify });
    expect(await first.text()).toBe('reached');
    await blocked(url, { resolve, classify });
    expect(calls).toBe(2);
  });

  it('one internal address among several public ones is enough to refuse', async () => {
    const resolve: HostResolver = async () => [
      { address: '93.184.215.14', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ];
    await blocked('http://mixed.example.test/', { resolve });
  });
});

describe('the connect-time lookup for other HTTP stacks (S3 adapter)', () => {
  const lookupOnce = (allowInternal: boolean, answer: string, family = 4) =>
    new Promise<{ err: unknown; address: unknown }>((done) => {
      const lookup = guardedLookup(allowInternal, async () => [{ address: answer, family }]);
      lookup('storage.example.test', { all: true }, (err, address) => done({ err, address }));
    });

  it('refuses internal addresses unless the endpoint is trusted, and metadata always', async () => {
    expect((await lookupOnce(false, '10.1.2.3')).err).toBeInstanceOf(OutboundBlockedError);
    expect((await lookupOnce(false, '::ffff:192.168.1.1', 6)).err).toBeInstanceOf(OutboundBlockedError);
    expect((await lookupOnce(true, '10.1.2.3')).err).toBeNull();
    expect((await lookupOnce(true, '169.254.169.254')).err).toBeInstanceOf(OutboundBlockedError);
    expect((await lookupOnce(false, '93.184.215.14')).address).toEqual([{ address: '93.184.215.14', family: 4 }]);
  });

  it('a storage endpoint may reach an internal address only when its exact origin is trusted', () => {
    const trusted = parseTrustedEndpoints('http://seaweedfs:8333');
    expect(serviceEndpointPolicy('http://seaweedfs:8333', trusted)).toEqual({ allowInternal: true });
    // Same host, another port or scheme: not trusted.
    expect(serviceEndpointPolicy('http://seaweedfs:9000', trusted)).toEqual({ allowInternal: false });
    expect(serviceEndpointPolicy('https://seaweedfs:8333', trusted)).toEqual({ allowInternal: false });
    // Internal literals and metadata hosts named by a site's storage profile are refused outright.
    expect(() => serviceEndpointPolicy('http://10.0.0.5:9000', trusted)).toThrow(OutboundBlockedError);
    expect(() => serviceEndpointPolicy('http://169.254.169.254/', parseTrustedEndpoints('http://169.254.169.254'))).toThrow(OutboundBlockedError);
    expect(() => serviceEndpointPolicy('http://key:secret@s3.example.com', trusted)).toThrow(OutboundBlockedError);
    expect(() => serviceEndpointPolicy('file:///var/lib/data', trusted)).toThrow(OutboundBlockedError);
  });
});
