import { describe, expect, it, vi } from 'vitest';

/**
 * What `guardedProbe` (HeoPress P07 task 3.9) asks of the outbound boundary: a user-purpose request (never a trusted
 * service connection), no redirect followed but the redirect returned as the answer, its time and body caps, the
 * caller's `redirect` ignored. The boundary is replaced by a recorder: no request is made.
 */
const calls: Array<{ url: URL; options: Record<string, unknown> }> = [];
vi.mock('@heopress/runtime/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@heopress/runtime/node')>()),
  outboundFetch: vi.fn(async (url: URL, options: Record<string, unknown>) => {
    calls.push({ url, options });
    return new Response(null, { status: 301, headers: { location: 'https://www.example.com/' } });
  }),
}));

import { guardedProbe } from '../ssrf-guard';

describe('guardedProbe options', () => {
  it('a user-purpose request, no redirect followed (the redirect is the answer), caps passed, `redirect: follow` ignored', async () => {
    const res = await guardedProbe('https://example.com/robots.txt', { method: 'GET', headers: { 'user-agent': 'x' }, redirect: 'follow', timeoutMs: 1234, maxResponseBytes: 99 });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.example.com/');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe('https://example.com/robots.txt');
    expect(calls[0]!.options).toMatchObject({ purpose: 'user', maxRedirects: 0, returnRedirect: true, timeoutMs: 1234, maxResponseBytes: 99, method: 'GET' });
    expect(calls[0]!.options).not.toHaveProperty('redirect');
  });
});
