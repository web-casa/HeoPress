// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSessionJwt, installFakeLocks } from '@/test/session';
import { adoptSession } from '../session/current';
import { inFlightWrites, lowerBarrier, raiseBarrier, siteFetch, transportFetch } from '../http';

/**
 * The one HTTP outlet (HeoPress P04 task 9.9): the switch barrier holds new
 * requests and lets the switch's own through; writes in flight are known;
 * a 401 renews the session once and retries; the tab's token and site are
 * always the ones sent.
 */
describe('Studio transport', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    installFakeLocks();
    await adoptSession({ token: fakeSessionJwt({ siteId: 'site_a' }), refreshToken: 'r1' });
  });
  afterEach(() => {
    lowerBarrier();
    vi.restoreAllMocks();
  });

  it('sends this tab’s token and site, whatever the caller set', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await siteFetch('/api/v1/items/a', { headers: { Authorization: 'Bearer stale', 'X-HeoPress-Site': 'site_b' } });
    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${fakeSessionJwt({ siteId: 'site_a' })}`);
    expect(headers.get('x-heopress-site')).toBe('site_a');
  });

  it('the barrier holds new requests, lets the switch’s own through, and releases the rest when lowered', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    raiseBarrier();
    const held = transportFetch('/api/v1/items');
    await transportFetch('/api/v1/auth/switch-site', { method: 'POST', switchControl: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    lowerBarrier();
    await held;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('knows which writes are in flight', async () => {
    const finish: Array<(r: Response) => void> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => finish.push(r)));
    const write = transportFetch('/api/v1/items/a', { method: 'PATCH' });
    const read = transportFetch('/api/v1/items/a');
    expect(inFlightWrites()).toHaveLength(1);
    for (const done of finish) done(new Response('{}'));
    await Promise.all([write, read]);
    expect(inFlightWrites()).toHaveLength(0);
  });

  it('a 401 renews the session once and retries with the new token', async () => {
    const renewed = fakeSessionJwt({ siteId: 'site_a', n: 2 });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/api/v1/auth/refresh')) return new Response(JSON.stringify({ data: { token: renewed, refreshToken: 'r2' } }));
      const auth = new Headers(fetchMock.mock.calls.at(-1)![1]!.headers).get('authorization');
      return new Response('{}', { status: auth === `Bearer ${renewed}` ? 200 : 401 });
    });
    const res = await siteFetch('/api/v1/items/a');
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0]), window.location.origin).pathname)).toEqual(['/api/v1/items/a', '/api/v1/auth/refresh', '/api/v1/items/a']);
  });
});
