// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failingAfterMarkBackend, fakeSessionJwt, installFakeLocks } from '@/test/session';
import { activeSession, adoptSession, refreshActiveSession, sessionUnsaved } from '../session/current';
import { __setSessionBackendForTests, INDEX_KEY, readSession, removeSession } from '../session/store';
import { inFlightWrites, lowerBarrier, raiseBarrier, siteFetch } from '../http';
import { getApiClient } from '../api';

/**
 * Codex review P04-5: a request belongs to the session that started it; a
 * stale stored pair is not taken for a newer one; writes are tracked until
 * their final result; an SDK retry passes the switch barrier; a session
 * removed by another window is not used or recreated.
 */

const U1 = { userId: 'u1', sid: 's1', siteId: 'site_a' };
const U2 = { userId: 'u2', sid: 's9', siteId: 'site_a' };
const refreshAnswer = (token: string, refreshToken: string) => new Response(JSON.stringify({ data: { token, refreshToken } }));
const path = (u: unknown) => new URL(String(u), window.location.origin).pathname;

describe('requests belong to the session that started them', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    __setSessionBackendForTests(null);
    installFakeLocks();
  });
  afterEach(() => {
    lowerBarrier();
    vi.restoreAllMocks();
  });

  it('a late 401 of U1’s request is not renewed or replayed as U2 after the tab adopts U2', async () => {
    await adoptSession({ token: fakeSessionJwt(U1), refreshToken: 'r1' });
    let answer401: (r: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      path(url) === '/api/v1/items/a' && fetchMock.mock.calls.length === 1 ? new Promise<Response>((r) => (answer401 = r)) : Promise.resolve(new Response('{}')),
    );
    const post = siteFetch('/api/v1/items/a', { method: 'POST', body: '{}' });
    await adoptSession({ token: fakeSessionJwt(U2), refreshToken: 'r9' }); // another person signs in on this tab
    answer401(new Response('{}', { status: 401 }));
    expect((await post).status).toBe(401);
    expect(fetchMock.mock.calls.map((c) => path(c[0]))).toEqual(['/api/v1/items/a']); // no renewal, no replay
    expect(activeSession()!.userId).toBe('u2');
  });

  it('a renewal that finishes after the tab moved to another login does not replace it', async () => {
    await adoptSession({ token: fakeSessionJwt(U1), refreshToken: 'r1' });
    const u1 = activeSession()!;
    let finish: (r: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => (finish = r)));
    const renewal = refreshActiveSession(u1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await adoptSession({ token: fakeSessionJwt(U2), refreshToken: 'r9' });
    finish(refreshAnswer(fakeSessionJwt({ ...U1, n: 2 }), 'r2'));
    expect(await renewal).toBeNull();
    expect(activeSession()!.userId).toBe('u2');
  });

  it('after a failed store, the next renewal presents the rotated token, not the stale stored one', async () => {
    await adoptSession({ token: fakeSessionJwt(U1), refreshToken: 'r1' });
    const bodies: string[] = [];
    let n = 1;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String(init?.body));
      n += 1;
      return refreshAnswer(fakeSessionJwt({ ...U1, n }), `r${n}`);
    });
    __setSessionBackendForTests(failingAfterMarkBackend());
    await refreshActiveSession();
    expect(sessionUnsaved()).toBe(true);
    await refreshActiveSession();
    expect(bodies.map((b) => JSON.parse(b).refreshToken)).toEqual(['r1', 'r2']);
    expect(activeSession()!.refreshToken).toBe('r3');
  });

  it('a write stays tracked while its 401 is being renewed', async () => {
    await adoptSession({ token: fakeSessionJwt(U1), refreshToken: 'r1' });
    let renew: (r: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (path(url) === '/api/v1/auth/refresh') return new Promise<Response>((r) => (renew = r));
      return new Response('{}', { status: inFlightWrites().length && renewed ? 200 : 401 });
    });
    let renewed = false;
    const patch = siteFetch('/api/v1/items/a', { method: 'PATCH', body: '{}' });
    await vi.waitFor(() => expect(fetchMock.mock.calls.map((c) => path(c[0]))).toContain('/api/v1/auth/refresh'));
    expect(inFlightWrites()).toHaveLength(1);
    renewed = true;
    renew(refreshAnswer(fakeSessionJwt({ ...U1, n: 2 }), 'r2'));
    expect((await patch).status).toBe(200);
    expect(inFlightWrites()).toHaveLength(0);
  });

  it('an SDK mutation renewed while a switch barrier went up still completes', async () => {
    await adoptSession({ token: fakeSessionJwt(U1), refreshToken: 'r1' });
    const renewed = fakeSessionJwt({ ...U1, n: 2 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (path(url) === '/api/v1/auth/refresh') {
        raiseBarrier(); // the switch starts while the renewal is in flight
        return refreshAnswer(renewed, 'r2');
      }
      const auth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ data: { ok: true } }), { status: auth === `Bearer ${renewed}` ? 200 : 401 });
    });
    await expect(getApiClient().rawRequest('/api/v1/items/a', { method: 'PATCH', body: '{}' })).resolves.toEqual({ data: { ok: true } });
  });

  it('a session removed by another window is dropped here and never recreated by a renewal', async () => {
    await adoptSession({ token: fakeSessionJwt(U1), refreshToken: 'r1' });
    const u1 = activeSession()!;
    await removeSession(u1); // the other window's logout
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await refreshActiveSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readSession(u1)).toBeNull();

    // And the index event alone ends this tab's use of it.
    await adoptSession({ token: fakeSessionJwt(U1), refreshToken: 'r1' });
    window.dispatchEvent(new StorageEvent('storage', { key: INDEX_KEY, newValue: '[]' }));
    expect(activeSession()).toBeNull();
  });
});
