import { describe, expect, it } from 'vitest';
import { parseTarget, requestHost, trustedProxies } from '../host';

/** The request's host (P04 "域名归属与可信 Host"): X-Forwarded-Host only from a configured trusted proxy. */
describe('requestHost', () => {
  // Malformed entries (and prefixes out of range) are skipped, never fatal.
  const trusted = trustedProxies('10.0.0.1, 192.168.0.0/16, fd00::/8, bogus, 1.2.3.4/x, 127.0.0.1/999, 10.9.0.0/33, ::/129, 127.0.0.0/8/9');
  const headers = { host: 'Proxy.Example.com:8080', forwardedHost: 'spoofed.example.org, Site.Example.com.' };

  it('takes X-Forwarded-Host (its right-most value, the one the proxy wrote, normalised) from a trusted peer, by address or range, IPv4-mapped too', () => {
    for (const peer of ['10.0.0.1', '192.168.4.5', '::ffff:192.168.4.5', 'fd12::1']) expect(requestHost(headers, peer, trusted), peer).toBe('site.example.com');
    expect(requestHost(headers, '127.0.0.1', trusted)).toBe('proxy.example.com');
    expect(requestHost(headers, '10.9.1.1', trusted)).toBe('proxy.example.com');
  });

  it('an empty forwarded value falls back to the Host header', () => {
    for (const forwardedHost of ['', ' ', 'a.example.com, ']) expect(requestHost({ host: 'Proxy.Example.com', forwardedHost }, '10.0.0.1', trusted), forwardedHost).toBe('proxy.example.com');
  });

  it('ignores it from anyone else, or with no peer; the Host header is normalised', () => {
    for (const peer of ['10.0.0.2', '8.8.8.8', '::1', undefined]) expect(requestHost(headers, peer, trusted), String(peer)).toBe('proxy.example.com');
    expect(requestHost(headers, '10.0.0.1', trustedProxies(undefined))).toBe('proxy.example.com');
  });

  it('no host at all is null', () => {
    expect(requestHost({ host: '', forwardedHost: null }, undefined, trusted)).toBeNull();
  });
});

describe('parseTarget', () => {
  it('origin-form and absolute-form, raw (no normalisation), without fragments', () => {
    expect(parseTarget('/a/../b?x=1')).toEqual({ authority: null, path: '/a/../b', query: 'x=1' });
    expect(parseTarget('http://Site.example.com:8080/p?q')).toEqual({ authority: 'Site.example.com:8080', path: '/p', query: 'q' });
    expect(parseTarget('https://site.example.com')).toEqual({ authority: 'site.example.com', path: '/', query: '' });
    expect(parseTarget('http://site.example.com?q=1')).toEqual({ authority: 'site.example.com', path: '/', query: 'q=1' });
    expect(parseTarget('/p#frag')).toEqual({ authority: null, path: '/p', query: '' });
  });
  it('anything else is refused', () => {
    for (const raw of ['*', 'site.example.com:443', 'ftp://x/', '', 'https://user@site.example.com/', 'http://a.example.com\\@b.example.com/', 'http://a.example.com%40b/', 'http://[::1]/', 'http:///x']) {
      expect(parseTarget(raw), raw).toBeNull();
    }
  });
});
