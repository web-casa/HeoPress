// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failingAfterMarkBackend, fakeSessionJwt, installFakeLocks } from '@/test/session';
import { __setSessionBackendForTests, endLogin, listSessions, readSession, sessionKey, writeSession, type StoredSession } from '../store';
import {
  __setSessionTimingForTests,
  activeSession,
  adoptSession,
  forgetCurrentSession,
  forgetLogin,
  hydrateSession,
  refreshActiveSession,
  sessionUnsaved,
} from '../current';

/**
 * Studio sessions (HeoPress P04 task 9.9): records per backend, user, login
 * and site never mix; a refresh is made once across tabs — a pair another tab
 * already rotated is used as it is — and a pair the server rotated but this
 * browser could not store is kept in memory and reported.
 */

const origin = () => window.location.origin;
const record = (over: Partial<StoredSession> = {}): StoredSession => ({
  backend: origin(),
  userId: 'u1',
  sid: 's1',
  siteId: 'site_a',
  token: fakeSessionJwt(),
  refreshToken: 'r1',
  ...over,
});

describe('session records', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __setSessionBackendForTests(null);
  });

  it('two accounts, two backends and two logins of one person never share a record', async () => {
    await writeSession(record());
    await writeSession(record({ userId: 'u2', refreshToken: 'other user' }));
    await writeSession(record({ backend: 'https://cms.example.net', refreshToken: 'other backend' }));
    await writeSession(record({ sid: 's2', refreshToken: 'other login' }));
    expect((await readSession(record()))!.refreshToken).toBe('r1');
    expect((await readSession(record({ sid: 's2' })))!.refreshToken).toBe('other login');
    expect(listSessions({ backend: origin(), userId: 'u1' }).map((s) => s.sid).sort()).toEqual(['s1', 's2']);
    expect(listSessions({ backend: origin(), userId: 'u1', sid: 's1' })).toHaveLength(1);
  });

  it('a write that cannot be stored rejects (callers treat it as a failure)', async () => {
    __setSessionBackendForTests({
      get: async () => null,
      set: async () => {
        throw new Error('keychain locked');
      },
      remove: async () => undefined,
    });
    await expect(writeSession(record())).rejects.toThrow('keychain locked');
  });
});

describe('refresh coordinated across tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __setSessionBackendForTests(null);
    installFakeLocks();
  });
  afterEach(() => vi.restoreAllMocks());

  const answer = (n: number) =>
    new Response(JSON.stringify({ data: { token: fakeSessionJwt({ n }), refreshToken: `r${n}` } }), { status: 200 });

  it('two refreshes at once rotate the token once', async () => {
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'r1' });
    let n = 1;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer(++n));
    const [a, b] = await Promise.all([refreshActiveSession(), refreshActiveSession()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ refreshToken: 'r1' });
    expect((await readSession(activeSession()!))!.refreshToken).toBe('r2');
  });

  it('a pair another tab already rotated is used, not rotated again', async () => {
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'r1' });
    // Another tab rotated it meanwhile and stored the new pair.
    await writeSession({ ...activeSession()!, token: fakeSessionJwt({ n: 9 }), refreshToken: 'r9' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await refreshActiveSession()).toBe(fakeSessionJwt({ n: 9 }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a rotated pair that cannot be stored is kept in memory and reported', async () => {
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'r1' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(2));
    __setSessionBackendForTests(failingAfterMarkBackend());
    expect(await refreshActiveSession()).toBe(fakeSessionJwt({ n: 2 }));
    expect(activeSession()!.refreshToken).toBe('r2');
    expect(sessionUnsaved()).toBe(true);
  });
});

describe('each tab keeps its own site', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __setSessionBackendForTests(null);
  });

  it('a new tab starts from the last one used and keeps it when another tab switches later', async () => {
    await writeSession(record());
    await writeSession(record({ siteId: 'site_b', refreshToken: 'rb' }));
    localStorage.setItem('heopress.lastTab.v2', JSON.stringify({ siteId: 'site_a', userId: 'u1', sid: 's1' }));
    await hydrateSession(); // a new tab: nothing of its own yet
    expect(activeSession()!.siteId).toBe('site_a');
    // Another tab switches to B (it writes the shared "last used").
    localStorage.setItem('heopress.lastTab.v2', JSON.stringify({ siteId: 'site_b', userId: 'u1', sid: 's1' }));
    await hydrateSession(); // this tab reloads
    expect(activeSession()!.siteId).toBe('site_a');
  });

  it('a tab with nothing to start from pins the default site (Codex P04-7 #4)', async () => {
    await hydrateSession();
    expect(JSON.parse(sessionStorage.getItem('heopress.tab.v2')!)).toEqual({ siteId: '__default__' });
    // Another tab signs in on B afterwards: this one does not follow on reload.
    await writeSession(record({ siteId: 'site_b' }));
    localStorage.setItem('heopress.lastTab.v2', JSON.stringify({ siteId: 'site_b', userId: 'u1', sid: 's1' }));
    await hydrateSession();
    expect(activeSession()).toBeNull();
  });
});

describe('a refresh token presented without a saved outcome is never presented again (Codex P04-9)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __setSessionBackendForTests(null);
    installFakeLocks();
  });
  afterEach(() => vi.restoreAllMocks());

  const answer = (n: number) =>
    new Response(JSON.stringify({ data: { token: fakeSessionJwt({ n }), refreshToken: `r${n}` } }), { status: 200 });
  const presentedTokens = (fetchMock: ReturnType<typeof vi.spyOn>) =>
    (fetchMock.mock.calls as Array<[unknown, RequestInit | undefined]>).map(([, init]) => JSON.parse(String(init?.body)).refreshToken as string);

  it('a renewal whose answer was lost: neither this tab nor a reload presents the token again', async () => {
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'lost1' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'));
    expect(await refreshActiveSession()).toBeNull();
    expect(await refreshActiveSession()).toBeNull();
    // A reload (or another window) finds no usable session.
    await hydrateSession();
    expect(activeSession()).toBeNull();
    expect(presentedTokens(fetchMock)).toEqual(['lost1']);
  });

  it('a pair rotated by the server but not saved: another window cannot use the stored one; this tab goes on with its new pair', async () => {
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'r1' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(2));
    __setSessionBackendForTests(failingAfterMarkBackend());
    expect(await refreshActiveSession()).toBe(fakeSessionJwt({ n: 2 }));
    expect(sessionUnsaved()).toBe(true);
    expect(await readSession(record())).toBeNull(); // what another window would read
    fetchMock.mockResolvedValue(answer(3));
    expect(await refreshActiveSession()).toBe(fakeSessionJwt({ n: 3 }));
    expect(presentedTokens(fetchMock)).toEqual(['r1', 'r2']);
  });

  it('the mark is kept in the record’s own backend (keychain mode works without localStorage marks)', async () => {
    const keychain = new Map<string, string>();
    __setSessionBackendForTests({
      get: async (k) => keychain.get(k) ?? null,
      set: async (k, v) => void keychain.set(k, v),
      remove: async (k) => void keychain.delete(k),
    });
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'kc1' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'));
    await refreshActiveSession();
    expect(JSON.parse(keychain.get([...keychain.keys()][0]!)!)).toMatchObject({ refreshToken: 'kc1', renewing: true });
    expect(await readSession(record())).toBeNull();
    // A new sign-in is a new record: usable at once.
    await adoptSession({ token: fakeSessionJwt({ sid: 's2' }), refreshToken: 'n1' });
    expect(await readSession(record({ sid: 's2', refreshToken: 'n1' }))).toMatchObject({ refreshToken: 'n1' });
  });

  it('a mark that cannot be stored: the token is not presented', async () => {
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'r1' });
    __setSessionBackendForTests({ get: async (k) => localStorage.getItem(k), set: async () => { throw new Error('keychain locked'); }, remove: async () => undefined });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    expect(await refreshActiveSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refused before any rotation (429): the mark is lifted and the session stays usable', async () => {
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'r1' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 429 }));
    expect(await refreshActiveSession()).toBeNull();
    expect(await readSession(record())).toMatchObject({ refreshToken: 'r1' });
  });

  it('a record another window marked for its renewal is not taken for a new pair', async () => {
    const mine = await adoptSession({ token: fakeSessionJwt(), refreshToken: 'ev1' });
    window.dispatchEvent(
      new StorageEvent('storage', { key: sessionKey(mine), newValue: JSON.stringify({ ...mine, token: 'other', renewing: true }) }),
    );
    expect(activeSession()!.token).toBe(mine.token);
  });

  it('a tab loading while another tab renews waits for it and loads the new pair (Codex P04-10 #1)', async () => {
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'hy1' });
    let finish: (r: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => (finish = r)));
    const renewal = refreshActiveSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const loading = hydrateSession(); // the other tab (same tab state, same records)
    finish(new Response(JSON.stringify({ data: { token: fakeSessionJwt({ n: 7 }), refreshToken: 'hy2' } })));
    await renewal;
    await loading;
    expect(activeSession()).toMatchObject({ refreshToken: 'hy2' });
  });

  it('a late 429 after the session was forgotten does not bring it back (Codex P04-10 #2)', async () => {
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'fg1' });
    let finish: (r: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => (finish = r)));
    const renewal = refreshActiveSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const forgetting = forgetCurrentSession(); // waits for the renewal's lock
    finish(new Response('{}', { status: 429 }));
    await renewal;
    await forgetting;
    expect(await readSession(record(), { includeRenewing: true })).toBeNull();
  });

  it('…nor does a late successful renewal', async () => {
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'fg2' });
    let finish: (r: Response) => void = () => undefined;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((r) => (finish = r)));
    const renewal = refreshActiveSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const forgetting = forgetCurrentSession();
    finish(new Response(JSON.stringify({ data: { token: fakeSessionJwt({ n: 8 }), refreshToken: 'fg3' } })));
    expect(await renewal).toBeNull();
    await forgetting;
    expect(await readSession(record(), { includeRenewing: true })).toBeNull();
    expect(activeSession()).toBeNull();
  });

  describe('bounded waits (Codex P04-11 #1)', () => {
    afterEach(() => __setSessionTimingForTests(null));

    it('a renewal that never answers is given up: outcome unknown, the record stays marked, startup is not held', async () => {
      __setSessionTimingForTests({ renewalMs: 50 });
      await adoptSession({ token: fakeSessionJwt(), refreshToken: 'hang1' });
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_u, init) =>
          new Promise<Response>((_, reject) =>
            init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
          ),
      );
      expect(await refreshActiveSession()).toBeNull();
      expect(await readSession(record(), { includeRenewing: true })).toMatchObject({ refreshToken: 'hang1', renewing: true });
      await hydrateSession();
      expect(activeSession()).toBeNull();
    });

    it('a lock held without end does not keep the app at "Loading"', async () => {
      __setSessionTimingForTests({ lockWaitMs: 50 });
      const mine = await adoptSession({ token: fakeSessionJwt(), refreshToken: 'held1' });
      void navigator.locks.request(`heopress-session:${sessionKey(mine)}`, () => new Promise(() => undefined));
      await hydrateSession();
      expect(activeSession()).toMatchObject({ refreshToken: 'held1' });
    });
  });

  it('a logout in another window cannot slip between a renewal’s check and its write (Codex P04-11 #2)', async () => {
    // Two windows: two module instances over the same storage and locks; an
    // asynchronous (keychain-like) backend whose writes we hold.
    let releaseWrite: (() => void) | undefined;
    let holdNextPlainWrite = false;
    const shared = {
      get: async (k: string) => localStorage.getItem(k),
      set: async (k: string, v: string) => {
        if (holdNextPlainWrite && !v.includes('"renewing":true')) {
          holdNextPlainWrite = false;
          await new Promise<void>((r) => (releaseWrite = r));
        }
        localStorage.setItem(k, v);
      },
      remove: async (k: string) => localStorage.removeItem(k),
    };
    __setSessionBackendForTests(shared);
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'xw1' });
    vi.resetModules();
    const other = await import('../current');
    const otherStore = await import('../store');
    otherStore.__setSessionBackendForTests(shared);

    holdNextPlainWrite = true; // the new pair's write lands late
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { token: fakeSessionJwt({ n: 9 }), refreshToken: 'xw2' } })),
    );
    const renewal = refreshActiveSession();
    await vi.waitFor(() => expect(releaseWrite).not.toBe(undefined));
    await new Promise((r) => setTimeout(r, 20)); // the write is under way
    const logout = other.forgetLogin({ userId: 'u1', sid: 's1' }); // the other window signs out
    await new Promise((r) => setTimeout(r, 20));
    releaseWrite!();
    await renewal;
    await logout;
    expect(await readSession(record(), { includeRenewing: true })).toBeNull();
    expect(listSessions({ backend: origin(), userId: 'u1', sid: 's1' })).toEqual([]);
  });

  it('a logout whose lock wait runs out is not undone by a late write: the ended mark keeps the record unread (Codex P04-12 #1)', async () => {
    __setSessionTimingForTests({ lockWaitMs: 30 });
    let releaseWrite: (() => void) | undefined;
    let holdNextPlainWrite = false;
    const shared = {
      get: async (k: string) => localStorage.getItem(k),
      set: async (k: string, v: string) => {
        if (holdNextPlainWrite && !v.includes('"renewing":true')) {
          holdNextPlainWrite = false;
          await new Promise<void>((r) => (releaseWrite = r));
        }
        localStorage.setItem(k, v);
      },
      remove: async (k: string) => localStorage.removeItem(k),
    };
    __setSessionBackendForTests(shared);
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'lw1' });
    vi.resetModules();
    const other = await import('../current');
    const otherStore = await import('../store');
    otherStore.__setSessionBackendForTests(shared);
    other.__setSessionTimingForTests({ lockWaitMs: 30 });

    holdNextPlainWrite = true;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { token: fakeSessionJwt({ n: 4 }), refreshToken: 'lw2' } })),
    );
    const renewal = refreshActiveSession();
    await vi.waitFor(() => expect(releaseWrite).toBeDefined()); // the new pair's write is stalled
    await other.forgetLogin({ userId: 'u1', sid: 's1' }); // returns without waiting for the lock
    await new Promise((r) => setTimeout(r, 60)); // longer than the lock wait
    releaseWrite!(); // the late write lands
    await renewal;
    expect(await readSession(record(), { includeRenewing: true })).toBeNull();
    expect(await otherStore.readSession(record(), { includeRenewing: true })).toBeNull();
    await other.hydrateSession();
    expect(other.activeSession()).toBeNull();
    __setSessionTimingForTests(null);
  });

  it('a new sign-in or exchange of a record lifts its own ended mark, not its login’s', async () => {
    const mine = await adoptSession({ token: fakeSessionJwt(), refreshToken: 'em1' });
    await forgetCurrentSession(); // this record ended
    expect(await readSession(mine)).toBeNull();
    await writeSession({ ...mine, refreshToken: 'em2' }, { fresh: true });
    expect(await readSession(mine)).toMatchObject({ refreshToken: 'em2' });
    endLogin(mine); // the whole login ended (logout)
    await writeSession({ ...mine, refreshToken: 'em3' }, { fresh: true });
    expect(await readSession(mine)).toBeNull();
  });

  it('the clean-up of a signed-out record does not remove one written again since (Codex P04-13 #1)', async () => {
    const mine = await adoptSession({ token: fakeSessionJwt(), refreshToken: 'cu1' });
    let releaseHeld: () => void = () => undefined;
    void navigator.locks.request(`heopress-session:${sessionKey(mine)}`, () => new Promise<void>((r) => (releaseHeld = r)));
    await forgetCurrentSession(); // marked ended; its removal waits for the lock
    await writeSession({ ...mine, refreshToken: 'cu2' }, { fresh: true }); // switched back: a new exchange
    releaseHeld();
    await new Promise((r) => setTimeout(r, 20));
    expect(await readSession(mine)).toMatchObject({ refreshToken: 'cu2' });
  });

  it('a sign-out in another tab ends this tab’s copy at once (Codex P04-13 #2)', async () => {
    const mine = await adoptSession({ token: fakeSessionJwt(), refreshToken: 'so1' });
    const key = `heopress.session.v2.ended|${sessionKey(mine).split('|').slice(0, 4).join('|')}`;
    localStorage.setItem(key, '1');
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: '1' }));
    expect(activeSession()).toBeNull();
  });

  it('without localStorage (keychain mode) a sign-out still removes this tab’s record (Codex P04-13 #4)', async () => {
    const keychain = new Map<string, string>();
    __setSessionBackendForTests({
      get: async (k) => keychain.get(k) ?? null,
      set: async (k, v) => void keychain.set(k, v),
      remove: async (k) => void keychain.delete(k),
    });
    await adoptSession({ token: fakeSessionJwt(), refreshToken: 'kc9' });
    vi.stubGlobal('localStorage', undefined);
    try {
      await forgetLogin({ userId: 'u1', sid: 's1' });
      await hydrateSession();
      expect(activeSession()).toBeNull();
      expect(keychain.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
