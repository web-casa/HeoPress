import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cachedPage, cacheKey, cacheQuery, etagOf, HTML_TYPE, matchesEtag, OUTPUT_VERSION, PageCache, readStored, redirectLocation, representationHeaders, rotation, storedBytes } from '../cache';

/** The page cache's key and validators (HeoPress P06 tasks 3.1, 7.2; design R9). */
describe('page cache keys', () => {
  const base = { mode: 'public' as const, siteId: 's', host: 'a.example.com', path: '/', query: new URLSearchParams(), themeVersion: 't', siteVersion: 1 };
  it('only the parameters that change the page count, normalised', () => {
    expect(cacheQuery('/', new URLSearchParams('utm_source=x&page=2&page=3&q=zz'))).toBe('page=2');
    expect(cacheQuery('/', new URLSearchParams('page=abc'))).toBe('page=invalid');
    expect(cacheQuery('/search/', new URLSearchParams('q=%20Hello%20&x=1'))).toBe('q=Hello');
    expect(cacheQuery('/search/', new URLSearchParams(`q=${'a'.repeat(500)}`))).toBe(`q=${'a'.repeat(200)}`);
  });
  it('every part of the key matters: site, host, path, page, theme version, render version', () => {
    const k = cacheKey(base);
    for (const over of [{ siteId: 't' }, { host: 'b.example.com' }, { path: '/x/' }, { query: new URLSearchParams('page=2') }, { themeVersion: 'u' }, { siteVersion: 2 }]) {
      expect(cacheKey({ ...base, ...over }), JSON.stringify(over)).not.toBe(k);
    }
    expect(cacheKey({ ...base, query: new URLSearchParams('utm=1') })).toBe(k);
    // The language is decided by host and path: an entry per language prefix or language host.
    expect(cacheKey({ ...base, path: '/zh/' })).not.toBe(k);
    expect(cacheKey({ ...base, host: 'zh.a.example.com' })).not.toBe(k);
    // Only public answers have keys (previews are never cached).
    // @ts-expect-error no key for a preview, by type and at run time
    expect(() => cacheKey({ ...base, mode: 'preview' })).toThrow(/only public/);
  });
  it('weak ETags compare by their opaque part', () => {
    const e = etagOf(200, 'x', null);
    expect(e).not.toBe(etagOf(200, 'y', null));
    expect(e).not.toBe(etagOf(404, 'x', null));
    expect(matchesEtag(e, e)).toBe(true);
    expect(matchesEtag(`"a", ${e.slice(2)}`, e)).toBe(true);
    expect(matchesEtag('*', e)).toBe(true);
    expect(matchesEtag('W/"other"', e)).toBe(false);
    expect(matchesEtag(undefined, e)).toBe(false);
  });
});

describe('the answer envelope (HeoPress P07 task 1.3)', () => {
  it('only the system representation headers, as RFC 9110 tokens, with plain visible-ASCII values', () => {
    expect(representationHeaders({ 'X-Robots-Tag': 'noindex', Link: '<https://a.example.com/x>; rel="canonical"' })).toEqual({
      link: '<https://a.example.com/x>; rel="canonical"',
      'x-robots-tag': 'noindex',
    });
    // A root file's (P07 task 3.8): fixed by the system, allowed.
    expect(representationHeaders({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" })).toEqual({
      'content-security-policy': "sandbox; default-src 'none'",
      'x-content-type-options': 'nosniff',
    });
    for (const name of ['Set-Cookie', 'Location', 'Refresh', 'Access-Control-Allow-Origin', 'X-Robots Tag', 'x-robots-tag:', 'X-Rob\u00f6ts-Tag', '']) {
      expect(() => representationHeaders({ [name]: 'x' }), name).toThrow(/not allowed/);
    }
    for (const value of ['noindex\n', 'noindex\r', 'noindex\r\n', 'a\r\nSet-Cookie: x=1', 'a\nb', 'a\rb', 'caf\u00e9', '   ', '', 'a\u0000b', 'tab\there']) {
      expect(() => representationHeaders({ 'X-Robots-Tag': value }), JSON.stringify(value)).toThrow(/not allowed/);
    }
  });

  it('a content type is type/subtype with parameters; the entity tag covers type and headers', () => {
    expect(cachedPage(200, 'x', null).contentType).toBe(HTML_TYPE);
    expect(cachedPage(200, 'x', null, { contentType: 'application/xml; charset=utf-8' }).contentType).toBe('application/xml; charset=utf-8');
    for (const bad of ['text', 'text/html;\r\ncharset=utf-8', 'text/html\r\n;charset=utf-8', 'text/html;\ncharset=utf-8', 'text/html\t; charset=utf-8', 'text/html;\u00a0charset=utf-8', 'text/html\n', 'text/html\r\n', 'text/html; charset=utf-8\r', 'text/html\r\nX: y', 'text/html; charset="utf-8"', '']) {
      expect(() => cachedPage(200, 'x', null, { contentType: bad }), bad).toThrow(/content-type not allowed/);
    }
    const plain = cachedPage(200, 'x', null);
    expect(cachedPage(200, 'x', null, { contentType: 'text/plain; charset=utf-8' }).etag).not.toBe(plain.etag);
    expect(cachedPage(200, 'x', null, { headers: { 'X-Robots-Tag': 'noindex' } }).etag).not.toBe(plain.etag);
    expect(plain.etag).toBe(etagOf(200, 'x', null));
  });

  it('the shared level stores answers by a size limit of their type: pages up to 2 MB, discovery files larger', async () => {
    const written: Array<{ contentType: string; bytes: number }> = [];
    const tx = {
      execute: async () => [],
      insert: () => ({
        values: (v: { contentType: string; body: string }) => ({ onConflictDoUpdate: async () => void written.push({ contentType: v.contentType, bytes: Buffer.byteLength(v.body) }) }),
      }),
    };
    const db = { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } as never;
    const cache = new PageCache(db);
    const big = 'x'.repeat(3_000_000);
    await cache.store('k1', 's', 1, cachedPage(200, big, null), { shared: true });
    await cache.store('k2', 's', 1, cachedPage(200, big, null, { contentType: 'application/xml; charset=utf-8' }), { shared: true });
    await cache.store('k3', 's', 1, cachedPage(200, 'x'.repeat(9_000_000), null, { contentType: 'text/plain; charset=utf-8' }), { shared: true });
    expect(written).toEqual([{ contentType: 'application/xml; charset=utf-8', bytes: 3_000_000 }]);
  });

  it('the limit counts UTF-8 bytes and headers, and media types compare case-insensitively', async () => {
    const written: string[] = [];
    const tx = { execute: async () => [], insert: () => ({ values: (v: { body: string }) => ({ onConflictDoUpdate: async () => void written.push(v.body.slice(0, 1)) }) }) };
    const cache = new PageCache({ transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } as never);
    // 3,000,000 characters of three UTF-8 bytes each: 9 MB, over the 8 MB limit though `.length` is under it.
    const wide = cachedPage(200, '\u4e2d'.repeat(3_000_000), null, { contentType: 'application/xml; charset=utf-8' });
    expect(storedBytes(wide)).toBeGreaterThan(9_000_000);
    await cache.store('w', 's', 1, wide, { shared: true });
    // An uppercase HTML type takes the page limit, not the discovery one.
    await cache.store('u', 's', 1, cachedPage(200, 'u'.repeat(3_000_000), null, { contentType: 'Text/HTML; charset=utf-8' }), { shared: true });
    // At the boundary: the headers count.
    const edge = 'e'.repeat(2_000_000 - 'text/html; charset=utf-8'.length);
    await cache.store('e1', 's', 1, cachedPage(200, edge, null), { shared: true });
    await cache.store('e2', 's', 1, cachedPage(200, edge, null, { headers: { 'X-Robots-Tag': 'noindex' } }), { shared: true });
    expect(written).toEqual(['e']);
  });

  it('a shared row is checked again when read: a bad one is a miss, a good one gets its entity tag recomputed', async () => {
    const good = { status: 200, body: 'b', etag: 'W/"stale"', location: null, contentType: 'text/plain; charset=utf-8', headers: { 'x-robots-tag': 'noindex' } };
    const read = (row: Record<string, unknown>) => readStored({ select: () => ({ from: () => ({ where: async () => [row] }) }) } as never, 'k', 's');
    expect(await read(good)).toEqual(cachedPage(200, 'b', null, { contentType: good.contentType, headers: good.headers }));
    for (const bad of [
      { ...good, status: 404 },
      { ...good, status: 301, location: '/x' },
      { ...good, contentType: 'text/html\r\nSet-Cookie: x=1' },
      { ...good, headers: { 'set-cookie': 'x=1' } },
      { ...good, headers: { 'x-robots-tag': 'a\r\nb' } },
      { ...good, location: 'a\r\nb' },
    ]) {
      expect(await read(bad), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of ['/a\nb', '/a\n', '/a\r\n', '', '   ', '/caf\u00e9', 'javascript:x', '/a b', null, '//evil.example', '/\\evil.example', 'https://', 'http://a.example.com/', '/a%zz', '/a%2']) {
      expect(() => cachedPage(301, '', bad), JSON.stringify(bad)).toThrow(/location/);
    }
    expect(cachedPage(301, '', 'https://a.example.com/x/?q=1').location).toBe('https://a.example.com/x/?q=1');
    expect(cachedPage(301, '', '/%E4%B8%AD/%66eed.xml').location).toBe('/%E4%B8%AD/%66eed.xml');
    expect(() => cachedPage(200, 'x', '/x')).toThrow(/location/);
    expect(() => cachedPage(410, 'x', '/x')).toThrow(/location/);
  });

  it('a served redirect keeps the request\'s query, encoded where it cannot stand in a header', () => {
    expect(redirectLocation('https://a.example.com/x/', 'a=1&a=2&b=%20')).toBe('https://a.example.com/x/?a=1&a=2&b=%20');
    expect(redirectLocation('/x/', '')).toBe('/x/');
    // Raw bytes a request may carry (decoded as latin1 by the server), spaces, a backslash, a stray `%`.
    expect(redirectLocation('/x/', 'q=caf\u00e9 x\\y&p=50%')).toBe('/x/?q=caf%C3%A9%20x%5Cy&p=50%25');
    expect(redirectLocation('/x/', 'q=\ud800')).toBeNull();
    // After the target's own query, before its fragment.
    expect(redirectLocation('/x?fixed=1', 'ref=2')).toBe('/x?fixed=1&ref=2');
    expect(redirectLocation('/x?', 'ref=2')).toBe('/x?ref=2');
    expect(redirectLocation('/x?value?', 'ref=2')).toBe('/x?value?&ref=2');
    expect(redirectLocation('/x??', 'ref=2')).toBe('/x??&ref=2');
    expect(redirectLocation('/x?a=1&', 'ref=2')).toBe('/x?a=1&ref=2');
    expect(redirectLocation('/x#section', 'ref=2')).toBe('/x?ref=2#section');
    expect(redirectLocation('/x?a=1#s', 'ref=2')).toBe('/x?a=1&ref=2#s');
    expect(redirectLocation('/x#s', '')).toBe('/x#s');
  });

  it('the output version is part of every key: entries of another format are never read', () => {
    const k = { mode: 'public' as const, siteId: 's', host: 'a.example.com', path: '/', query: new URLSearchParams(), themeVersion: 't', siteVersion: 1 };
    expect(OUTPUT_VERSION).toBeGreaterThanOrEqual(2);
    // The P06 format (`v1`) cannot produce the same key.
    const p06 = createHash('sha256').update(['v1', 'public', 's', 'a.example.com', '/', '', 't', '1'].join('\u0000')).digest('hex');
    expect(cacheKey(k)).not.toBe(p06);
  });
});

describe('sweep rotation', () => {
  it('resumes after the last site by its position, whatever the order of the list (one site per pass)', () => {
    // A database collation where 'a' < 'B' < 'c' (JavaScript would put 'B' first).
    const sites = ['a', 'B', 'c'];
    let cursor = '';
    const visited: string[] = [];
    for (let i = 0; i < 6; i++) {
      const next = rotation(sites, cursor)[0]!;
      visited.push(next);
      cursor = next;
    }
    expect(visited).toEqual(['a', 'B', 'c', 'a', 'B', 'c']);
    // A cursor that has left the list: the next one in byte order.
    expect(rotation(['a', 'c'], 'b')).toEqual(['c', 'a']);
    expect(rotation(['a', 'c'], 'z')).toEqual(['a', 'c']);
    expect(rotation([], 'a')).toEqual([]);
  });
});
