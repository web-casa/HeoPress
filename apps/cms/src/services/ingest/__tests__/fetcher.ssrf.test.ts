import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyAddress, outboundBlockOf, outboundFetch, parseTrustedEndpoints, type AddressClass } from '@heopress/runtime/node';
import { classifyFetchFailure, IngestFetchError } from '../failure';
import { fetchPage, type FetchPageOptions } from '../fetcher';
import { RobotsCache } from '../robots';

/**
 * The ingestion fetcher against SSRF and politeness rules (HeoPress P08 tasks 2.1, 2.2, 2.5, 6.1; spec ingest/crawling
 * "SSRF 防护", "礼貌抓取"). Real HTTP servers on loopback; an injected resolver decides what each host name resolves
 * to, and an injected classifier treats 127.0.0.1 as a public address and 127.0.0.2 as an internal one, so both can
 * be reached locally. Nothing leaves the machine.
 */

interface Hit {
  host: string;
  path: string;
  headers: IncomingHttpHeaders;
}

type Handler = (path: string, res: ServerResponse, host: string) => void;
let handler: Handler = (_p, res) => res.end();
const hits: Hit[] = [];
const internalHits: Hit[] = [];
let pub: Server;
let internal: Server;
let port = 0;

const ARTICLE = `<!doctype html><html lang="en"><head><title>Test article</title></head><body><article><h1>Test article</h1>${'<p>A long and ordinary paragraph about the town, its parks, its markets, and the people who live there.</p>'.repeat(6)}</article></body></html>`;

beforeAll(async () => {
  pub = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]!;
    hits.push({ host, path: req.url ?? '', headers: req.headers });
    res.setHeader('connection', 'close');
    handler(req.url ?? '/', res, host);
  });
  await new Promise<void>((r) => pub.listen(0, '127.0.0.1', () => r()));
  port = (pub.address() as AddressInfo).port;
  internal = createServer((req, res) => {
    internalHits.push({ host: req.headers.host ?? '', path: req.url ?? '', headers: req.headers });
    res.end('internal secret');
  });
  await new Promise<void>((r) => internal.listen(port, '127.0.0.2', () => r()));
});
afterAll(async () => {
  for (const s of [pub, internal]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
beforeEach(() => {
  hits.length = 0;
  internalHits.length = 0;
  handler = (path, res) => {
    if (path === '/robots.txt') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ARTICLE);
  };
});

/** `*.public.test` → 127.0.0.1 (public); `*.internal.test` → 127.0.0.2 (internal); overrides per test. */
function hooks(overrides: Record<string, () => string> = {}): Pick<FetchPageOptions, 'resolve' | 'classify'> {
  return {
    resolve: async (hostname) => {
      const pick = overrides[hostname];
      const address = pick ? pick() : hostname.endsWith('.internal.test') ? '127.0.0.2' : '127.0.0.1';
      return [{ address, family: 4 }];
    },
    classify: (ip: string): AddressClass => (ip === '127.0.0.1' ? 'public' : ip === '127.0.0.2' ? 'internal' : classifyAddress(ip)),
  };
}

const at = (host: string, path = '/article') => `http://${host}:${port}${path}`;
const fetchIt = (url: string, extra: FetchPageOptions = {}) => fetchPage(url, { robots: new RobotsCache(), ...hooks(), ...extra });

async function failure(p: Promise<unknown>): Promise<{ category: string; terminal: boolean; message: string }> {
  try {
    await p;
  } catch (err) {
    return { ...classifyFetchFailure(err), message: err instanceof Error ? err.message : String(err) };
  }
  throw new Error('expected the fetch to fail');
}

describe('SSRF: internal targets', () => {
  it.each([
    ['private IPv4 literal', 'http://10.0.0.5/'],
    ['loopback', 'http://127.0.0.1/'],
    ['decimal IPv4', 'http://2130706433/'],
    ['octal IPv4', 'http://0177.0.0.1/'],
    ['hex IPv4', 'http://0x7f.0.0.1/'],
    ['short IPv4', 'http://127.1/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 unique-local', 'http://[fd12:3456::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv4-mapped IPv6', 'http://[::ffff:10.0.0.1]/'],
    ['IPv4-mapped IPv6 (hex)', 'http://[::ffff:a9fe:a9fe]/'],
    ['CGNAT', 'http://100.64.0.1/'],
    ['cloud metadata IP', 'http://169.254.169.254/latest/meta-data/'],
    ['cloud metadata host', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['localhost', 'http://localhost/'],
    ['credentials in URL', 'http://user:pass@a.public.test/'],
    ['non-http scheme', 'file:///etc/passwd'],
  ])('%s is refused before any request (%s)', async (_label, url) => {
    // The real classifier: 127.0.0.1 is loopback here.
    const f = await failure(fetchPage(url, { robots: new RobotsCache(), resolve: hooks().resolve, classify: classifyAddress }));
    expect(f.category).toBe('blocked');
    expect(f.terminal).toBe(true);
    expect(hits).toHaveLength(0);
    expect(internalHits).toHaveLength(0);
  });

  it('a public name resolving to an internal address is refused', async () => {
    const f = await failure(fetchIt(at('evil.internal.test')));
    expect(f.category).toBe('blocked');
    expect(internalHits).toHaveLength(0);
  });

  it('a name with any internal address among its records is refused', async () => {
    const f = await failure(
      fetchPage(at('mixed.public.test'), {
        robots: new RobotsCache(),
        resolve: async () => [
          { address: '127.0.0.1', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ],
        classify: hooks().classify,
      }),
    );
    expect(f.category).toBe('blocked');
    expect(hits).toHaveLength(0);
  });

  it('a name resolving to the metadata address is refused', async () => {
    const f = await failure(fetchIt(at('meta.public.test'), { ...hooks({ 'meta.public.test': () => '169.254.169.254' }) }));
    expect(f.category).toBe('blocked');
  });
});

describe('SSRF: redirects', () => {
  it.each([
    ['an internal IP literal', 'http://10.0.0.5/'],
    ['the metadata address', 'http://169.254.169.254/'],
    ['a name resolving internally', () => at('admin.internal.test', '/')],
  ])('a redirect to %s is refused at the redirect', async (_label, target) => {
    handler = (path, res) => {
      if (path === '/robots.txt') return void res.writeHead(404).end();
      res.writeHead(302, { location: typeof target === 'function' ? target() : target }).end();
    };
    const f = await failure(fetchIt(at('start.public.test')));
    expect(f.category).toBe('blocked');
    expect(internalHits).toHaveLength(0);
  });

  it('more than five redirects is refused', async () => {
    handler = (path, res) => {
      if (path === '/robots.txt') return void res.writeHead(404).end();
      const n = Number(/\/r(\d+)/.exec(path)?.[1] ?? 0);
      res.writeHead(302, { location: `/r${n + 1}` }).end();
    };
    const f = await failure(fetchIt(at('loop.public.test', '/r0')));
    expect(f.category).toBe('blocked');
    expect(f.message).toMatch(/more than 5 redirects/);
  });

  it('every hop is checked against its own robots.txt', async () => {
    handler = (path, res, host) => {
      if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(host.startsWith('b.') ? 'User-agent: *\nDisallow: /' : '');
      if (host.startsWith('a.')) return void res.writeHead(301, { location: at('b.public.test', '/moved') }).end();
      res.writeHead(200, { 'content-type': 'text/html' }).end(ARTICLE);
    };
    const f = await failure(fetchIt(at('a.public.test')));
    expect(f.category).toBe('access_denied');
    expect(hits.filter((h) => h.host.startsWith('b.') && h.path === '/moved')).toHaveLength(0);
  });

  it('credentials are never sent, and caller headers stay on the first origin', async () => {
    handler = (path, res, host) => {
      if (path === '/robots.txt') return void res.writeHead(404).end();
      if (host.startsWith('a.')) return void res.writeHead(302, { location: at('b.public.test', '/final') }).end();
      res.writeHead(200, { 'content-type': 'text/html' }).end(ARTICLE);
    };
    const page = await fetchIt(at('a.public.test'), { headers: { authorization: 'Bearer secret', cookie: 'sid=1', 'x-trace': 'abc' } });
    expect(page.finalUrl).toBe(at('b.public.test', '/final'));
    const first = hits.find((h) => h.host.startsWith('a.') && h.path === '/article')!;
    const second = hits.find((h) => h.host.startsWith('b.') && h.path === '/final')!;
    expect(first.headers['x-trace']).toBe('abc');
    for (const h of [first, second]) {
      expect(h.headers.authorization).toBeUndefined();
      expect(h.headers.cookie).toBeUndefined();
      expect(h.headers['user-agent']).toMatch(/^HeoPressBot\//);
    }
    expect(second.headers['x-trace']).toBeUndefined();
  });
});

describe('SSRF: DNS rebinding', () => {
  it('a name that answers public first and internal at connect time never reaches the internal address', async () => {
    let lookups = 0;
    const flip = () => (++lookups === 1 ? '127.0.0.1' : '127.0.0.2');
    const f = await failure(fetchIt(at('rebind.public.test'), hooks({ 'rebind.public.test': flip })));
    // The first lookup (robots.txt) was public; the page's connection looked the name up again and was refused there.
    expect(lookups).toBeGreaterThanOrEqual(2);
    expect(f.category).toBe('blocked');
    expect(internalHits).toHaveLength(0);
  });
});

describe('limits', () => {
  it('a body over 5 MB is refused', async () => {
    handler = (path, res) => {
      if (path === '/robots.txt') return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html' });
      const chunk = Buffer.alloc(256 * 1024, 'a');
      for (let i = 0; i < 24; i++) res.write(chunk);
      res.end();
    };
    const f = await failure(fetchIt(at('big.public.test')));
    expect(f.category).toBe('blocked');
    expect(f.message).toMatch(/byte limit/);
  });

  it('a body that trickles past the deadline times out', async () => {
    handler = (path, res) => {
      if (path === '/robots.txt') return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html>');
      const t = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(t));
    };
    const f = await failure(fetchIt(at('slow.public.test'), { timeoutMs: 400 }));
    expect(f.category).toBe('timeout');
    expect(f.terminal).toBe(false);
  });
});

describe('failure classification', () => {
  it.each([
    [401, 'access_denied', true],
    [403, 'access_denied', true],
    [451, 'access_denied', true],
    [500, 'network', false],
    [503, 'network', false],
    [504, 'timeout', false],
    [429, 'timeout', false],
    [404, 'other', false],
  ])('HTTP %i → %s', async (status, category, terminal) => {
    handler = (path, res) => {
      if (path === '/robots.txt') return void res.writeHead(404).end();
      res.writeHead(status, { 'content-type': 'text/html' }).end('no');
    };
    const f = await failure(fetchIt(at('status.public.test')));
    expect(f).toMatchObject({ category, terminal });
  });

  it('robots.txt disallow → access_denied, and the page is never requested', async () => {
    handler = (path, res) => {
      if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: HeoPressBot\nDisallow: /article');
      res.writeHead(200, { 'content-type': 'text/html' }).end(ARTICLE);
    };
    const f = await failure(fetchIt(at('robots.public.test')));
    expect(f).toMatchObject({ category: 'access_denied', terminal: true });
    expect(hits.map((h) => h.path)).toEqual(['/robots.txt']);
  });

  it('robots.txt answering 5xx → retryable, page not requested', async () => {
    handler = (path, res) => {
      if (path === '/robots.txt') return void res.writeHead(503).end();
      res.writeHead(200, { 'content-type': 'text/html' }).end(ARTICLE);
    };
    const f = await failure(fetchIt(at('down.public.test')));
    expect(f).toMatchObject({ category: 'network', terminal: false });
    expect(hits.map((h) => h.path)).toEqual(['/robots.txt']);
  });

  it.each([
    ['x-robots-tag', 'noai, noimageai'],
    ['tdm-reservation', '1'],
  ])('response header %s: %s → access_denied', async (name, value) => {
    handler = (path, res) => {
      if (path === '/robots.txt') return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html', [name]: value }).end(ARTICLE);
    };
    expect((await failure(fetchIt(at('noai.public.test')))).category).toBe('access_denied');
  });

  it('a network error is retryable', async () => {
    const f = await failure(fetchPage('http://closed.public.test:1/', { robots: new RobotsCache(), ...hooks() }));
    expect(f.terminal).toBe(false);
    expect(['network', 'other']).toContain(f.category);
  });

  it('a successful fetch identifies itself and returns the body', async () => {
    const page = await fetchIt(at('ok.public.test'));
    expect(page.status).toBe(200);
    expect(page.body.toString()).toContain('Test article');
    expect(hits.map((h) => h.path)).toEqual(['/robots.txt', '/article']);
    expect(IngestFetchError).toBeDefined();
  });
});

describe('trusted internal services (ADR-0014)', () => {
  it('only a service connection to a listed origin reaches an internal address; ingestion URLs never do', async () => {
    const origin = `http://svc.internal.test:${port}`;
    const trusted = parseTrustedEndpoints(origin);
    const h = hooks();
    const svc = await outboundFetch(`${origin}/health`, { purpose: 'service', trusted, resolve: h.resolve, classify: h.classify });
    expect(await svc.text()).toBe('internal secret');
    expect(internalHits).toHaveLength(1);
    // The same origin as content (a source URL, a discovered link): refused, even though it is listed.
    const f = await failure(fetchIt(`${origin}/health`));
    expect(f.category).toBe('blocked');
    const err = await outboundFetch(`${origin}/x`, { purpose: 'user', trusted, resolve: h.resolve, classify: h.classify }).catch((e: unknown) => e);
    expect(outboundBlockOf(err)).not.toBeNull();
    expect(internalHits).toHaveLength(1);
  });
});
