import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { classifyAddress, type AddressClass } from '../outbound/address';
import { OutboundBlockedError, outboundBlockOf, outboundFetch, parseTrustedEndpoints, type HostResolver } from '../outbound/fetch';

/**
 * Outbound boundary (P03 tasks 4.4–4.5; spec platform/outbound-security).
 * Real HTTP servers on 127.0.0.1; test hooks decide what each host name
 * resolves to and how 127.0.0.1 is classified, so "public" and "internal"
 * targets can both be reached locally.
 */

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
}

function server(handler: (req: { url: string; headers: IncomingHttpHeaders }, res: import('node:http').ServerResponse) => void) {
  const seen: Seen[] = [];
  const s: Server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers });
    handler({ url: req.url ?? '', headers: req.headers }, res);
  });
  return { s, seen, port: () => (s.address() as AddressInfo).port };
}

const ok = server((_req, res) => res.end('ok'));
const big = server((_req, res) => res.end('x'.repeat(5000)));
const redirector = server((req, res) => {
  const target = new URL(req.url, 'http://x').searchParams.get('to')!;
  res.writeHead(302, { location: target }).end();
});
const slow = server(() => {
  /* never answers */
});

beforeAll(async () => {
  for (const x of [ok, big, redirector, slow]) await new Promise<void>((r) => x.s.listen(0, '127.0.0.1', () => r()));
});
afterAll(async () => {
  for (const x of [ok, big, redirector, slow]) {
    x.s.closeAllConnections();
    await new Promise<void>((r) => x.s.close(() => r()));
  }
});

/** Host names → 127.0.0.1; how 127.0.0.1 is classified depends on the name used. */
function hooks(map: Record<string, AddressClass>) {
  const calls: string[] = [];
  let current: AddressClass = 'public';
  const resolve: HostResolver = async (hostname) => {
    calls.push(hostname);
    current = map[hostname] ?? 'public';
    return [{ address: '127.0.0.1', family: 4 }];
  };
  const classify = (ip: string): AddressClass => (ip === '127.0.0.1' ? current : classifyAddress(ip));
  return { resolve, classify, calls };
}

const at = (host: string, s: { port: () => number }, path = '/') => `http://${host}:${s.port()}${path}`;
const noTrust = parseTrustedEndpoints('');

describe('address classification', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['10.0.0.5', 'internal'],
    ['100.64.1.1', 'internal'],
    ['127.255.0.1', 'internal'],
    ['192.0.2.10', 'internal'],
    ['198.18.0.1', 'internal'],
    ['224.0.0.1', 'internal'],
    ['::1', 'internal'],
    ['fd12:3456::1', 'internal'],
    ['fe80::1', 'internal'],
    ['::ffff:10.0.0.1', 'internal'],
    ['::ffff:a00:1', 'internal'],
    ['64:ff9b::7f00:1', 'internal'],
    ['2002:0a00:0001::', 'internal'],
    ['::ffff:8.8.8.8', 'public'],
    ['169.254.169.254', 'metadata'],
    ['::ffff:169.254.169.254', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['not-an-ip', 'internal'],
  ])('%s → %s', (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });
});

describe('outboundFetch', () => {
  it('reaches a public host', async () => {
    const h = hooks({});
    const res = await outboundFetch(at('api.example.test', ok), { ...h, trusted: noTrust });
    expect(await res.text()).toBe('ok');
  });

  it('refuses a name that resolves to an internal address, before anything is sent', async () => {
    const h = hooks({ 'rebind.example.test': 'internal' });
    const before = ok.seen.length;
    await expect(outboundFetch(at('rebind.example.test', ok), { ...h, trusted: noTrust })).rejects.toThrow();
    expect(ok.seen.length).toBe(before);
  });

  it('checks the address it connects to: one resolution per connection, no separate pre-check', async () => {
    // A guard that resolves to check and lets fetch resolve again would call
    // the resolver twice; a rebinding answer in between would get through.
    const h = hooks({});
    await (await outboundFetch(at('once.example.test', ok), { ...h, trusted: noTrust })).text();
    expect(h.calls.filter((c) => c === 'once.example.test')).toHaveLength(1);
  });

  it('refuses internal and metadata IP literals, localhost and non-http schemes', async () => {
    for (const url of ['http://10.0.0.5/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data', 'http://localhost:1/', 'file:///etc/passwd', 'http://user:pw@api.example.com/']) {
      await expect(outboundFetch(url, { trusted: noTrust })).rejects.toBeInstanceOf(OutboundBlockedError);
    }
  });

  it('drops credentials on a cross-origin redirect and keeps them on a same-origin one', async () => {
    const h = hooks({});
    const headers = { authorization: 'Bearer secret', cookie: 'sid=1', 'x-api-key': 'k', 'x-goog-api-key': 'g', 'x-signature': 'sig', accept: 'text/plain' };
    const cross = at('a.example.test', redirector, `/?to=${encodeURIComponent(at('b.example.test', ok, '/landed-cross'))}`);
    await (await outboundFetch(cross, { ...h, trusted: noTrust, headers, credentialHeaders: ['x-signature'] })).text();
    const landedCross = ok.seen.find((s) => s.path === '/landed-cross')!;
    expect(landedCross.headers.authorization).toBeUndefined();
    expect(landedCross.headers.cookie).toBeUndefined();
    expect(landedCross.headers['x-api-key']).toBeUndefined();
    expect(landedCross.headers['x-signature']).toBeUndefined();
    expect(landedCross.headers['x-goog-api-key']).toBeUndefined();
    expect(landedCross.headers.accept).toBe('text/plain');

    // Same origin: redirector → redirector (same host and port) → ok via a second hop.
    const same = at('a.example.test', redirector, `/?to=${encodeURIComponent(`/?to=${encodeURIComponent(at('a.example.test', redirector, '/'))}`)}`);
    await outboundFetch(same, { ...h, trusted: noTrust, headers, maxRedirects: 2 }).catch(() => undefined);
    const sameHop = redirector.seen.filter((s) => s.headers.authorization === 'Bearer secret');
    expect(sameHop.length).toBeGreaterThanOrEqual(2);
  });

  it('checks every redirect hop: a public page redirecting to an internal address is refused', async () => {
    const h = hooks({ 'internal.example.test': 'internal' });
    const url = at('a.example.test', redirector, `/?to=${encodeURIComponent(at('internal.example.test', ok, '/should-not-arrive'))}`);
    await expect(outboundFetch(url, { ...h, trusted: noTrust })).rejects.toThrow();
    expect(ok.seen.some((s) => s.path === '/should-not-arrive')).toBe(false);
  });

  it('caps redirects, body size and time', async () => {
    const h = hooks({});
    const loop = at('a.example.test', redirector, `/?to=${encodeURIComponent(at('a.example.test', redirector, '/?to=/'))}`);
    await expect(outboundFetch(loop, { ...h, trusted: noTrust, maxRedirects: 3 })).rejects.toThrow(/redirects/);
    await expect(outboundFetch(at('big.example.test', big), { ...h, trusted: noTrust, maxResponseBytes: 1000 })).rejects.toThrow(/limit/);
    const started = Date.now();
    await expect(outboundFetch(at('slow.example.test', slow), { ...h, trusted: noTrust, timeoutMs: 200 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returnRedirect: past the limit the redirect itself is the answer, not followed and not refused (P07 task 3.9)', async () => {
    const h = hooks({});
    const target = at('b.example.test', ok, '/never-reached');
    const res = await outboundFetch(at('a.example.test', redirector, `/?to=${encodeURIComponent(target)}`), { ...h, trusted: noTrust, maxRedirects: 0, returnRedirect: true });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(target);
    expect(ok.seen.some((s) => s.path === '/never-reached')).toBe(false);
    // It changes nothing about the address check: a name resolving to an internal address is refused before anything is
    // sent, and a redirect toward one is answered, never followed.
    const hInternal = hooks({ 'rebind.example.test': 'internal' });
    const before = ok.seen.length;
    await expect(outboundFetch(at('rebind.example.test', ok), { ...hInternal, trusted: noTrust, maxRedirects: 0, returnRedirect: true })).rejects.toThrow();
    expect(ok.seen.length).toBe(before);
    const toInternal = at('a.example.test', redirector, `/?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`);
    expect((await outboundFetch(toInternal, { ...h, trusted: noTrust, maxRedirects: 0, returnRedirect: true })).status).toBe(302);
    // Without it, the same request is refused.
    await expect(outboundFetch(at('a.example.test', redirector, `/?to=${encodeURIComponent(target)}`), { ...h, trusted: noTrust, maxRedirects: 0 })).rejects.toThrow(/redirects/);
  });
});

describe('whether a refused request was sent (HeoPress P04 7.4: a ledger must not take "blocked" for "not sent")', () => {
  // A connect-time refusal arrives wrapped by fetch: look through the causes.
  const blockedBy = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => outboundBlockOf(e));

  it('a refusal before connecting says nothing was sent; one after a response says it was', async () => {
    const h = hooks({ 'internal.example.test': 'internal' });
    const before = await blockedBy(outboundFetch(at('internal.example.test', ok, '/never'), { ...h, trusted: noTrust }));
    expect(before).toBeInstanceOf(OutboundBlockedError);
    expect(before!.afterResponse).toBe(false);
    expect(ok.seen.some((s) => s.path === '/never')).toBe(false);

    const loop = at('a.example.test', redirector, `/?to=${encodeURIComponent(at('a.example.test', redirector, '/?to=/'))}`);
    const redirected = await blockedBy(outboundFetch(loop, { ...hooks({}), trusted: noTrust, maxRedirects: 1 }));
    expect(redirected!.afterResponse).toBe(true);

    const tooBig = await blockedBy(outboundFetch(at('big.example.test', big), { ...hooks({}), trusted: noTrust, maxResponseBytes: 1000 }));
    expect(tooBig!.afterResponse).toBe(true);

    // A same-origin redirect to a URL the boundary refuses (credentials in it): sent already.
    const origin = new URL(at('a.example.test', redirector, '/')).origin;
    const withCreds = `${origin.replace('://', '://user:pw@')}/next`;
    const sameOrigin = await blockedBy(outboundFetch(at('a.example.test', redirector, `/?to=${encodeURIComponent(withCreds)}`), { ...hooks({}), trusted: noTrust }));
    expect(sameOrigin).toBeInstanceOf(OutboundBlockedError);
    expect(sameOrigin!.afterResponse).toBe(true);
    // …and one whose next hop is refused at connect time (internal address).
    const internalNext = at('a.example.test', redirector, `/?to=${encodeURIComponent(at('internal.example.test', ok, '/x'))}`);
    const atConnect = await blockedBy(outboundFetch(internalNext, { ...hooks({ 'internal.example.test': 'internal' }), trusted: noTrust }));
    expect(atConnect!.afterResponse).toBe(true);
  });
});

describe('trusted internal endpoints (ADR-0014)', () => {
  const internal = () => hooks({ 'crawl4ai.test': 'internal', 'other.internal.test': 'internal' });

  it('lets a service connection reach a listed internal origin', async () => {
    const trusted = parseTrustedEndpoints(at('crawl4ai.test', ok, ''));
    const res = await outboundFetch(at('crawl4ai.test', ok, '/crawl'), { ...internal(), trusted, purpose: 'service' });
    expect(res.status).toBe(200);
  });

  it('refuses the same internal origin when the URL comes from a user or content', async () => {
    const trusted = parseTrustedEndpoints(at('crawl4ai.test', ok, ''));
    await expect(outboundFetch(at('crawl4ai.test', ok, '/'), { ...internal(), trusted, purpose: 'user' })).rejects.toThrow();
  });

  it('needs an exact origin match: another port on the same host is refused', async () => {
    const trusted = parseTrustedEndpoints('http://crawl4ai.test:1');
    await expect(outboundFetch(at('crawl4ai.test', ok, '/'), { ...internal(), trusted, purpose: 'service' })).rejects.toThrow();
  });

  it('re-checks a redirect from a trusted origin to another internal origin and refuses it', async () => {
    const trusted = parseTrustedEndpoints(at('crawl4ai.test', redirector, ''));
    const url = at('crawl4ai.test', redirector, `/?to=${encodeURIComponent(at('other.internal.test', ok, '/escaped'))}`);
    await expect(outboundFetch(url, { ...internal(), trusted, purpose: 'service' })).rejects.toThrow();
    expect(ok.seen.some((s) => s.path === '/escaped')).toBe(false);
  });

  it('never trusts a metadata address, warns about it, and still refuses requests to it', async () => {
    const parsed = parseTrustedEndpoints('http://169.254.169.254, http://metadata.google.internal');
    expect(parsed.origins.size).toBe(0);
    expect(parsed.warnings.join('\n')).toMatch(/metadata/);
    await expect(
      outboundFetch('http://169.254.169.254/latest/meta-data', { trusted: parsed, purpose: 'service' }),
    ).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('a service connection refuses any cross-origin redirect, so provider keys never leave (Codex review 3, #3)', async () => {
    const h = hooks({});
    const url = at('api.example.test', redirector, `/?to=${encodeURIComponent(at('evil.example.test', ok, '/stolen'))}`);
    await expect(
      outboundFetch(url, { ...h, trusted: noTrust, purpose: 'service', method: 'POST', body: '{}', headers: { 'x-goog-api-key': 'g' } }),
    ).rejects.toThrow(/another origin/);
    expect(ok.seen.some((s) => s.path === '/stolen')).toBe(false);
  });

  it('never echoes credentials or query strings of a rejected entry (Codex review 3, #8)', () => {
    const parsed = parseTrustedEndpoints('https://operator:hunter2@example.com/, http://svc.test/?key=sk-123, not a url sk-456');
    const text = parsed.warnings.join('\n');
    expect(parsed.warnings).toHaveLength(3);
    for (const secret of ['operator', 'hunter2', 'sk-123', 'key=', 'sk-456']) expect(text).not.toContain(secret);
    expect(text).toContain('https://example.com');
  });

  it('logs configuration warnings once at startup', async () => {
    const { trustedEndpointsFromEnv, __resetTrustedEndpointsForTests } = await import('../outbound/fetch');
    __resetTrustedEndpointsForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    trustedEndpointsFromEnv({ HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS: 'http://169.254.169.254' });
    trustedEndpointsFromEnv({ HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS: 'http://169.254.169.254' });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    __resetTrustedEndpointsForTests();
  });
});
