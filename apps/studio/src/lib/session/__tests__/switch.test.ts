// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failingAfterMarkBackend, fakeSessionJwt, installFakeLocks } from '@/test/session';
import {
  __setSessionTimingForTests,
  activeSession,
  activeSiteId,
  adoptSession,
  currentBackend,
  forgetCurrentSession,
  releaseRenewals,
} from '../current';
import { __setSessionBackendForTests, readSession, writeSession } from '../store';
import { inFlightWrites, lowerBarrier, siteFetch } from '../../http';
import { switchSite } from '../switch';

/**
 * Switching a tab to another site (HeoPress P04 task 9.10): the exchange
 * failing, declining to switch with a save pending, a write that meets a 401
 * after the barrier is up, a renewal racing the exchange, reuse of a stored
 * session of the same login only, nothing of a failed switch left behind.
 */

const A = { userId: 'u1', sid: 's1', siteId: 'site_a' };
const B = { ...A, siteId: 'site_b' };
const path = (u: unknown) => new URL(String(u), window.location.origin).pathname;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const switched = (n = 1) =>
  json({ data: { token: fakeSessionJwt({ ...B, n }), refreshToken: `rb${n}`, sid: 's1', site: { id: 'site_b' } } });
// Lets pending work reach its next request (store reads hash a fingerprint, off the microtask queue).
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('switchSite', () => {
  let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    __setSessionBackendForTests(null);
    installFakeLocks();
    navigate = vi.fn<(url: string) => void>();
    await adoptSession({ token: fakeSessionJwt(A), refreshToken: 'ra1' });
  });
  afterEach(() => {
    releaseRenewals(); // a successful switch leaves them held (the page would be gone)
    lowerBarrier();
    vi.restoreAllMocks();
  });

  it('exchanges, stores the other site’s session, makes it the tab’s and navigates', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(switched());
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(path(url)).toBe('/api/v1/auth/switch-site');
    expect(JSON.parse(String(init!.body))).toEqual({ siteId: 'site_b', refreshToken: 'ra1' });
    expect(new Headers(init!.headers).get('x-heopress-site')).toBe('site_a');
    expect(activeSession()).toMatchObject({ siteId: 'site_b', refreshToken: 'rb1' });
    expect(await readSession({ backend: currentBackend(), ...B })).toMatchObject({ refreshToken: 'rb1' });
    expect(navigate).toHaveBeenCalledWith('/');
    // The source session is kept: switching back can reuse it.
    expect(await readSession({ backend: currentBackend(), ...A })).toMatchObject({ refreshToken: 'ra1' });
  });

  it('a failed exchange keeps the tab on its site and lets held requests go on', async () => {
    let release: (r: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      path(url) === '/api/v1/auth/switch-site' ? new Promise<Response>((r) => (release = r)) : Promise.resolve(json({ data: [] })),
    );
    const switching = switchSite('site_b', { confirmUnknownWrites: () => true, navigate });
    await tick();
    const held = siteFetch('/api/v1/items/posts');
    await tick();
    expect(fetchMock.mock.calls.map((c) => path(c[0]))).toEqual(['/api/v1/auth/switch-site']); // held at the barrier
    release(json({ errors: [{ code: 'MFA_REQUIRED' }] }, 403));
    expect(await switching).toMatchObject({ ok: false, code: 'MFA_REQUIRED' });
    expect((await held).status).toBe(200);
    expect(new Headers(fetchMock.mock.calls[1]![1]!.headers).get('x-heopress-site')).toBe('site_a');
    expect(activeSession()!.siteId).toBe('site_a');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('with a save still pending, declining stays on the site and the save completes there', async () => {
    let finishSave: (r: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      path(url) === '/api/v1/items/posts/1' ? new Promise<Response>((r) => (finishSave = r)) : Promise.resolve(switched()),
    );
    const save = siteFetch('/api/v1/items/posts/1', { method: 'PATCH', body: '{}' });
    const confirm = vi.fn(() => false);
    const result = await switchSite('site_b', { confirmUnknownWrites: confirm, navigate, writeWaitMs: 20 });
    expect(confirm).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(fetchMock.mock.calls.map((c) => path(c[0]))).toEqual(['/api/v1/items/posts/1']); // no exchange
    finishSave(json({ data: {} }));
    expect((await save).status).toBe(200);
    expect(activeSession()!.siteId).toBe('site_a');
  });

  it('a save that finishes within the wait needs no question', async () => {
    let finishSave: (r: Response) => void = () => undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      path(url) === '/api/v1/items/posts/1' ? new Promise<Response>((r) => (finishSave = r)) : Promise.resolve(switched()),
    );
    const save = siteFetch('/api/v1/items/posts/1', { method: 'PATCH', body: '{}' });
    const confirm = vi.fn(() => false);
    const result = switchSite('site_b', { confirmUnknownWrites: confirm, navigate, writeWaitMs: 1000 });
    await tick();
    finishSave(json({ data: {} }));
    expect(await result).toEqual({ ok: true });
    expect(confirm).not.toHaveBeenCalled();
    await save;
  });

  it('a write already sent that meets a 401 after the barrier is renewed and retried, and the switch waits for it', async () => {
    let answerWrite: (r: Response) => void = () => undefined;
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const p = path(url);
      seen.push(p);
      if (p === '/api/v1/items/posts/1' && seen.filter((x) => x === p).length === 1) return new Promise<Response>((r) => (answerWrite = r));
      if (p === '/api/v1/auth/refresh') return Promise.resolve(json({ data: { token: fakeSessionJwt({ ...A, n: 2 }), refreshToken: 'ra2' } }));
      if (p === '/api/v1/auth/switch-site') {
        // The exchange presents the renewed source token, not the rotated one.
        expect(JSON.parse(String(init!.body)).refreshToken).toBe('ra2');
        return Promise.resolve(switched());
      }
      return Promise.resolve(json({ data: {} }));
    });
    const save = siteFetch('/api/v1/items/posts/1', { method: 'PATCH', body: '{}' });
    const confirm = vi.fn(() => false);
    const result = switchSite('site_b', { confirmUnknownWrites: confirm, navigate, writeWaitMs: 1000 });
    await tick();
    expect(inFlightWrites()).toHaveLength(1);
    answerWrite(json({}, 401));
    expect((await save).status).toBe(200);
    expect(await result).toEqual({ ok: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(seen).toEqual(['/api/v1/items/posts/1', '/api/v1/auth/refresh', '/api/v1/items/posts/1', '/api/v1/auth/switch-site']);
  });

  it('a renewal racing the exchange: the exchange runs after it, with the renewed token', async () => {
    let finishRefresh: (r: Response) => void = () => undefined;
    const bodies: Array<[string, unknown]> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      bodies.push([path(url), JSON.parse(String(init?.body ?? 'null'))]);
      if (path(url) === '/api/v1/auth/refresh') return new Promise<Response>((r) => (finishRefresh = r));
      if (path(url) === '/api/v1/auth/switch-site') return Promise.resolve(switched());
      return Promise.resolve(json({}, 401));
    });
    const read = siteFetch('/api/v1/items/posts'); // its 401 starts a renewal
    await tick();
    await tick();
    const result = switchSite('site_b', { confirmUnknownWrites: () => true, navigate });
    await tick();
    expect(bodies.map((b) => b[0])).toEqual(['/api/v1/items/posts', '/api/v1/auth/refresh']);
    finishRefresh(json({ data: { token: fakeSessionJwt({ ...A, n: 2 }), refreshToken: 'ra2' } }));
    expect(await result).toEqual({ ok: true });
    expect(bodies.find((b) => b[0] === '/api/v1/auth/switch-site')![1]).toMatchObject({ refreshToken: 'ra2' });
    await read;
  });

  it('an exchange refused as 401 renews the source once and retries', async () => {
    let exchanges = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (path(url) === '/api/v1/auth/refresh') return Promise.resolve(json({ data: { token: fakeSessionJwt({ ...A, n: 2 }), refreshToken: 'ra2' } }));
      exchanges += 1;
      return Promise.resolve(exchanges === 1 ? json({ errors: [{ code: 'UNAUTHORIZED' }] }, 401) : switched());
    });
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toEqual({ ok: true });
    expect(exchanges).toBe(2);
  });

  it('reuses a stored session of the same login when it renews; another login’s is not used', async () => {
    const backend = currentBackend();
    await writeSession({ backend, ...B, token: fakeSessionJwt(B), refreshToken: 'rb-old' });
    await writeSession({ backend, ...B, sid: 's2', token: fakeSessionJwt({ ...B, sid: 's2' }), refreshToken: 'other-login' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: { token: fakeSessionJwt({ ...B, n: 3 }), refreshToken: 'rb-new' } }));
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((c) => path(c[0]))).toEqual(['/api/v1/auth/refresh']);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ refreshToken: 'rb-old' });
    expect(activeSession()).toMatchObject({ siteId: 'site_b', sid: 's1', refreshToken: 'rb-new' });
  });

  it('a stored session that no longer renews is replaced by an exchange', async () => {
    await writeSession({ backend: currentBackend(), ...B, token: fakeSessionJwt(B), refreshToken: 'rb-dead' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      Promise.resolve(path(url) === '/api/v1/auth/refresh' ? json({ errors: [{ code: 'INVALID_REFRESH' }] }, 401) : switched()),
    );
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((c) => path(c[0]))).toEqual(['/api/v1/auth/refresh', '/api/v1/auth/switch-site']);
    expect(activeSession()).toMatchObject({ siteId: 'site_b', refreshToken: 'rb1' });
  });

  it('a destination session that cannot be saved fails the switch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(switched());
    __setSessionBackendForTests({ get: async (k) => localStorage.getItem(k), set: async () => { throw new Error('disk full'); }, remove: async () => undefined });
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toMatchObject({ ok: false, code: 'SAVE_FAILED' });
    expect(activeSession()!.siteId).toBe('site_a');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a reused session renewed but not saved is removed (its old token would end the login as reuse)', async () => {
    const backend = currentBackend();
    await writeSession({ backend, ...B, token: fakeSessionJwt(B), refreshToken: 'rb-old' });
    const removed: string[] = [];
    __setSessionBackendForTests({
      ...failingAfterMarkBackend(),
      remove: async (k) => { removed.push(k); localStorage.removeItem(k); },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: { token: fakeSessionJwt({ ...B, n: 3 }), refreshToken: 'rb-new' } }));
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toMatchObject({ ok: false, code: 'SAVE_FAILED' });
    expect(removed.some((k) => k.includes('site_b'))).toBe(true);
    expect(await readSession({ backend, ...B })).toBeNull();
  });

  it('a reused session whose renewal has no clear answer is dropped and its token never presented again (Codex P04-6 #1)', async () => {
    const backend = currentBackend();
    await writeSession({ backend, ...B, token: fakeSessionJwt(B), refreshToken: 'rb1' });
    const presented: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (path(url) === '/api/v1/auth/refresh') {
        presented.push(JSON.parse(String(init!.body)).refreshToken);
        throw new TypeError('network'); // rotated on the server? unknown
      }
      return json({ errors: [{ code: 'RATE_LIMITED' }] }, 429);
    });
    expect((await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).ok).toBe(false);
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toMatchObject({ ok: false });
    expect(presented).toEqual(['rb1']);
    expect(await readSession({ backend, ...B })).toBeNull();
  });

  it('a tab state that cannot be saved leaves the tab on its own session (Codex P04-6 #2)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(switched());
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (this === sessionStorage && k === 'heopress.tab.v2') throw new Error('quota');
      return setItem.call(this, k, v);
    });
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toMatchObject({ ok: false, code: 'FAILED' });
    expect(activeSession()!.siteId).toBe('site_a');
    expect(navigate).not.toHaveBeenCalled();
    vi.mocked(Storage.prototype.setItem).mockRestore();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(json({ data: [] }));
    await siteFetch('/api/v1/items/posts'); // not held: the barrier is down
    expect(new Headers(fetchMock.mock.calls.at(-1)![1]!.headers).get('x-heopress-site')).toBe('site_a');
  });

  it('a navigation that fails restores the source and lowers the barrier (Codex P04-6 #3)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(switched());
    const broken = vi.fn(() => {
      throw new Error('blocked');
    });
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate: broken })).toMatchObject({ ok: false, code: 'FAILED' });
    expect(activeSession()!.siteId).toBe('site_a');
    expect(JSON.parse(sessionStorage.getItem('heopress.tab.v2')!)).toMatchObject({ siteId: 'site_a' });
    fetchMock.mockResolvedValue(json({ data: [] }));
    expect((await siteFetch('/api/v1/items/posts')).status).toBe(200);
  });

  it('a write queued behind the barrier is not taken for a save in progress (Codex P04-6 #5)', async () => {
    let release: (r: Response) => void = () => undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      path(url) === '/api/v1/auth/switch-site' ? new Promise<Response>((r) => (release = r)) : Promise.resolve(json({ data: {} })),
    );
    const confirm = vi.fn(() => false);
    const result = switchSite('site_b', { confirmUnknownWrites: confirm, navigate, writeWaitMs: 20 });
    const autosave = siteFetch('/api/v1/items/posts/1', { method: 'PATCH', body: '{}' }); // held
    await tick();
    expect(inFlightWrites()).toHaveLength(0);
    release(switched());
    expect(await result).toEqual({ ok: true });
    expect(confirm).not.toHaveBeenCalled();
    lowerBarrier(); // (the page would have navigated away)
    await autosave;
  });

  it('the login replaced while the exchange was under way stops the switch (Codex P04-6 #6)', async () => {
    let release: (r: Response) => void = () => undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      path(url) === '/api/v1/auth/switch-site' ? new Promise<Response>((r) => (release = r)) : Promise.resolve(json({ data: {} })),
    );
    const result = switchSite('site_b', { confirmUnknownWrites: () => true, navigate });
    await tick();
    await adoptSession({ token: fakeSessionJwt({ userId: 'u2', sid: 's2', siteId: 'site_a' }), refreshToken: 'r2' });
    release(switched());
    expect(await result).toMatchObject({ ok: false, code: 'INVALID_SESSION' });
    expect(activeSession()).toMatchObject({ userId: 'u2', sid: 's2', siteId: 'site_a' });
    expect(navigate).not.toHaveBeenCalled();
    expect(await readSession({ backend: currentBackend(), ...B })).toBeNull();
  });

  it('a refused switch for too many attempts says so, with the wait (Codex P04-6 #7)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: 'RATE_LIMITED' }] }), { status: 429, headers: { 'retry-after': '42' } }),
    );
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      message: 'Too many site switches. Try again in 42 s.',
    });
  });

  it('a session the server rotated but this browser could not save fails the switch before any exchange', async () => {
    __setSessionBackendForTests(failingAfterMarkBackend());
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      Promise.resolve(path(url) === '/api/v1/auth/refresh' ? json({ data: { token: fakeSessionJwt({ ...A, n: 2 }), refreshToken: 'ra2' } }) : json({}, 401)),
    );
    await siteFetch('/api/v1/items/posts'); // 401 → renewed, not saved
    fetchMock.mockClear();
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toMatchObject({ ok: false, code: 'SAVE_FAILED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an unsaved source session fails the switch even when the other site’s session could be reused', async () => {
    await writeSession({ backend: currentBackend(), ...B, token: fakeSessionJwt(B), refreshToken: 'rb-old' });
    __setSessionBackendForTests(failingAfterMarkBackend());
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      Promise.resolve(path(url) === '/api/v1/auth/refresh' ? json({ data: { token: fakeSessionJwt({ ...A, n: 2 }), refreshToken: 'ra2' } }) : json({}, 401)),
    );
    await siteFetch('/api/v1/items/posts'); // 401 → renewed, not saved
    fetchMock.mockClear();
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toMatchObject({ ok: false, code: 'SAVE_FAILED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(activeSession()!.siteId).toBe('site_a');
  });

  it('a renewal in progress is waited for: one that cannot be saved fails the switch, reuse or not', async () => {
    await writeSession({ backend: currentBackend(), ...B, token: fakeSessionJwt(B), refreshToken: 'rb-old' });
    let finishRefresh: (r: Response) => void = () => undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (path(url) !== '/api/v1/auth/refresh') return Promise.resolve(json({}, 401));
      const presented = JSON.parse(String(init!.body)).refreshToken;
      if (presented === 'ra1') return new Promise<Response>((r) => (finishRefresh = r));
      return Promise.resolve(json({ data: { token: fakeSessionJwt({ ...B, n: 3 }), refreshToken: 'rb-new' } }));
    });
    const read = siteFetch('/api/v1/items/posts'); // its 401 starts the source renewal
    await tick();
    await tick();
    // Only the source record fails to save (the other site's would be fine).
    __setSessionBackendForTests({
      get: async (k) => localStorage.getItem(k),
      set: async (k, v) => {
        if (k.includes('site_a')) throw new Error('disk full');
        localStorage.setItem(k, v);
      },
      remove: async (k) => localStorage.removeItem(k),
    });
    const result = switchSite('site_b', { confirmUnknownWrites: () => true, navigate });
    await tick();
    finishRefresh(json({ data: { token: fakeSessionJwt({ ...A, n: 2 }), refreshToken: 'ra2' } }));
    expect(await result).toMatchObject({ ok: false, code: 'SAVE_FAILED' });
    await read;
  });

  it('without a token session (a gateway signs the person in) the saves are waited for too, then the tab addresses the other site (Codex P04-6 #4)', async () => {
    await forgetCurrentSession();
    let finishSave: (r: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => (finishSave = r)));
    const save = siteFetch('/api/v1/items/posts/1', { method: 'PATCH', body: '{}' });
    await tick();
    const confirm = vi.fn(() => false);
    expect(await switchSite('site_b', { confirmUnknownWrites: confirm, navigate, writeWaitMs: 20 })).toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(confirm).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    finishSave(json({ data: {} }));
    await save;
    expect(await switchSite('site_b', { confirmUnknownWrites: confirm, navigate })).toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce(); // nothing to exchange
    expect(JSON.parse(sessionStorage.getItem('heopress.tab.v2')!)).toMatchObject({ siteId: 'site_b' });
  });

  it('a late read’s 401 during the exchange starts no renewal before the page leaves (Codex P04-7 #1)', async () => {
    let answerRead: (r: Response) => void = () => undefined;
    let release: (r: Response) => void = () => undefined;
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      seen.push(path(url));
      if (path(url) === '/api/v1/items/posts') return new Promise<Response>((r) => (answerRead = r));
      if (path(url) === '/api/v1/auth/switch-site') return new Promise<Response>((r) => (release = r));
      return Promise.resolve(json({ data: { token: fakeSessionJwt({ ...A, n: 2 }), refreshToken: 'ra2' } }));
    });
    void siteFetch('/api/v1/items/posts').catch(() => undefined); // sent before the switch
    const result = switchSite('site_b', { confirmUnknownWrites: () => true, navigate });
    await tick();
    answerRead(json({}, 401));
    await tick();
    release(switched());
    expect(await result).toEqual({ ok: true });
    expect(seen).not.toContain('/api/v1/auth/refresh');
  });

  it('…and if the switch is abandoned, that renewal goes on and the read is retried', async () => {
    let answerRead: (r: Response) => void = () => undefined;
    let release: (r: Response) => void = () => undefined;
    let reads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (path(url) === '/api/v1/items/posts') return (reads += 1) === 1 ? new Promise<Response>((r) => (answerRead = r)) : Promise.resolve(json({ data: [] }));
      if (path(url) === '/api/v1/auth/switch-site') return new Promise<Response>((r) => (release = r));
      return Promise.resolve(json({ data: { token: fakeSessionJwt({ ...A, n: 2 }), refreshToken: 'ra2' } }));
    });
    const read = siteFetch('/api/v1/items/posts');
    const result = switchSite('site_b', { confirmUnknownWrites: () => true, navigate });
    await tick();
    answerRead(json({}, 401));
    await tick();
    release(json({ errors: [{ code: 'SITE_NOT_ALLOWED' }] }, 403));
    expect((await result).ok).toBe(false);
    expect((await read).status).toBe(200);
    expect(activeSession()!.refreshToken).toBe('ra2');
  });

  it('a record that cannot be removed is marked void and never presented again (Codex P04-7 #2)', async () => {
    const backend = currentBackend();
    await writeSession({ backend, ...B, token: fakeSessionJwt(B), refreshToken: 'rb1' });
    __setSessionBackendForTests({
      get: async (k) => localStorage.getItem(k),
      set: async (k, v) => localStorage.setItem(k, v),
      remove: async () => {
        throw new Error('keychain locked');
      },
    });
    const presented: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (path(url) === '/api/v1/auth/refresh') {
        presented.push(JSON.parse(String(init!.body)).refreshToken);
        throw new TypeError('network');
      }
      return json({ errors: [{ code: 'RATE_LIMITED' }] }, 429);
    });
    expect((await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).ok).toBe(false);
    expect((await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).ok).toBe(false);
    expect(presented).toEqual(['rb1']);
    expect(await readSession({ backend, ...B })).toBeNull();
  });

  it('without a token session, a tab state that cannot be fully saved leaves the tab on its site (Codex P04-7 #3)', async () => {
    await forgetCurrentSession();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [] }));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (this === localStorage && k === 'heopress.lastTab.v2') throw new Error('quota');
      return setItem.call(this, k, v);
    });
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toMatchObject({ ok: false, code: 'FAILED' });
    vi.mocked(Storage.prototype.setItem).mockRestore();
    expect(activeSiteId()).toBe('site_a');
    expect(JSON.parse(sessionStorage.getItem('heopress.tab.v2')!)).toMatchObject({ siteId: 'site_a' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a stored session that cannot be marked before its renewal is not presented; the switch exchanges (Codex P04-8 #2)', async () => {
    const backend = currentBackend();
    await writeSession({ backend, ...B, token: fakeSessionJwt(B), refreshToken: 'rb1' });
    // Plain records save; the renewal mark cannot.
    __setSessionBackendForTests({
      get: async (k) => localStorage.getItem(k),
      set: async (k, v) => {
        if (v.includes('"renewing":true')) throw new Error('keychain locked');
        localStorage.setItem(k, v);
      },
      remove: async (k) => localStorage.removeItem(k),
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(switched());
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((c) => path(c[0]))).toEqual(['/api/v1/auth/switch-site']);
  });

  it('an exchange whose answer stalls mid-body gives up, lowering the barrier (Codex P04-13 #3)', async () => {
    __setSessionTimingForTests({ exchangeMs: 50 });
    try {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
        Promise.resolve(
          path(url) === '/api/v1/auth/switch-site'
            ? new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode('{"data":')) }), { status: 200 })
            : json({ data: [] }),
        ),
      );
      expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toMatchObject({ ok: false, code: 'FAILED' });
      expect((await siteFetch('/api/v1/items/posts')).status).toBe(200); // not held
      expect(new Headers(fetchMock.mock.calls.at(-1)![1]!.headers).get('x-heopress-site')).toBe('site_a');
    } finally {
      __setSessionTimingForTests(null);
    }
  });

  it('Cloudflare Access (no exchange needed) addresses the other site and navigates', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ errors: [{ code: 'NOT_NEEDED' }] }, 409));
    expect(await switchSite('site_b', { confirmUnknownWrites: () => true, navigate })).toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledOnce();
    expect(JSON.parse(sessionStorage.getItem('heopress.tab.v2')!)).toMatchObject({ siteId: 'site_b' });
  });
});
