// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearActiveToken, getActiveSite, getActiveToken, logout, logoutEverywhere, setActiveLogin } from '@/lib/api';
import { lowerBarrier, raiseBarrier } from '@/lib/http';
import { activeSession } from '@/lib/session/current';
import { listSessions } from '@/lib/session/store';
import { fakeSessionJwt } from '@/test/session';

describe('Studio api session (per tab, per login and site — P04)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('a sign-in is stored under its user, login and site, and becomes this tab’s', async () => {
    const token = fakeSessionJwt({ userId: 'u1', sid: 's1', siteId: 'site_a' });
    await setActiveLogin({ token, refreshToken: 'refresh_1' });
    expect(getActiveToken()).toBe(token);
    expect(getActiveSite()).toBe('site_a');
    expect(listSessions({ backend: window.location.origin, userId: 'u1' })).toEqual([
      { backend: window.location.origin, userId: 'u1', sid: 's1', siteId: 'site_a' },
    ]);
    clearActiveToken();
    await Promise.resolve();
    expect(getActiveToken()).toBe('');
  });

  it('a token without a login session is refused', async () => {
    await expect(setActiveLogin({ token: 'not-a-jwt', refreshToken: 'r' })).rejects.toThrow(/login session/);
  });

  it('logout() ends the login on the server with its refresh token, then drops every site of that login', async () => {
    await setActiveLogin({ token: fakeSessionJwt({ siteId: 'site_b' }), refreshToken: 'refresh_b' });
    await setActiveLogin({ token: fakeSessionJwt({ siteId: 'site_a' }), refreshToken: 'refresh_a' });
    await setActiveLogin({ token: fakeSessionJwt({ sid: 'other_login', siteId: 'site_a' }), refreshToken: 'refresh_x' });
    await setActiveLogin({ token: fakeSessionJwt({ siteId: 'site_a' }), refreshToken: 'refresh_a' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { status: 'logged_out' } }), { status: 200 }));

    await logout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/auth/logout');
    expect(new Headers(init?.headers).get('X-HeoPress-Refresh')).toBe('1');
    expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'refresh_a' });
    expect(activeSession()).toBeNull();
    // Both sites of the login are gone; the other login stays.
    expect(listSessions({ backend: window.location.origin, userId: 'u1' }).map((s) => s.sid)).toEqual(['other_login']);
  });

  it('logout() still clears locally when the network call fails', async () => {
    await setActiveLogin({ token: fakeSessionJwt(), refreshToken: 'refresh_1' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await logout();
    expect(getActiveToken()).toBe('');
    expect(listSessions({ backend: window.location.origin, userId: 'u1' })).toEqual([]);
  });

  it('a server that never answers the logout does not hold the local one (Codex P04-12 #2)', async () => {
    await setActiveLogin({ token: fakeSessionJwt({ userId: 'u1', sid: 's1', siteId: 'site_a' }), refreshToken: 'lo1' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_u, init) =>
          // Never answers; only an abort ends it.
          new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          ),
      );
      const out = logout();
      await vi.advanceTimersByTimeAsync(10_000);
      const settled = await Promise.race([out, Promise.resolve('pending' as const)]);
      expect(settled).toEqual({ endedOnServer: false });
      expect(activeSession()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('“sign out everywhere” gives up within its bound even behind a switch barrier (Codex P04-13 #5)', async () => {
    await setActiveLogin({ token: fakeSessionJwt({ userId: 'u1', sid: 's1', siteId: 'site_a' }), refreshToken: 'le1' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    raiseBarrier();
    try {
      const out = logoutEverywhere();
      const settled = out.then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('The sessions could not be ended.');
    } finally {
      lowerBarrier();
      vi.useRealTimers();
    }
  });
});
