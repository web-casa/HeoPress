import { getApiBaseUrl } from '../api-base';
import { sessionClaimsOf } from './claims';
import {
  abandonRenewal,
  beginRenewal,
  endedMarkCovers,
  endLogin,
  endRecord,
  isSessionEnded,
  removeIfEnded,
  settleRenewal,
  INDEX_KEY,
  initSessionStore,
  listSessions,
  readSession,
  removeSession,
  sessionKey,
  writeSession,
  type SessionIdentity,
  type StoredSession,
} from './store';

/**
 * The session of this browser tab (HeoPress P04 tasks 9.9–9.10).
 *
 * Each tab has its own current (login, site) in sessionStorage — switching
 * site in one tab never changes another; localStorage remembers the last one
 * only as the default for a new tab. The session pair itself is a stored
 * record (`store.ts`), kept in memory for synchronous reads.
 *
 * **Refresh is coordinated across tabs** with the Web Locks API: per
 * session record, one tab at a time; inside the lock the stored pair is read
 * again — if another tab already rotated it, that pair is used — otherwise
 * the refresh is made once and the new pair stored before the lock is
 * released. Without it, two tabs rotating the same refresh token would be
 * taken for token theft and end the login on every site. Studio therefore
 * requires Web Locks (`locksSupported`).
 */

const TAB_KEY = 'heopress.tab.v2';
const LAST_KEY = 'heopress.lastTab.v2';
const DEFAULT_SITE = '__default__';

interface TabState {
  siteId: string;
  userId?: string;
  sid?: string;
}

let current: StoredSession | null = null;
/** The current pair could not be stored after the server rotated it. */
let unsaved = false;
/**
 * Refresh tokens this tab rotated away from. A stored record still holding
 * one of them is stale (its update failed), not another tab's rotation.
 */
const rotatedAway = new Set<string>();

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The site key of builds before per-tab sessions (still honoured as a default). */
const LEGACY_SITE_KEY = 'heopress.example.site';

function readTab(): TabState | null {
  const legacy = local()?.getItem(LEGACY_SITE_KEY);
  for (const raw of [session()?.getItem(TAB_KEY), local()?.getItem(LAST_KEY), legacy ? JSON.stringify({ siteId: legacy }) : null]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as TabState;
      if (typeof parsed.siteId === 'string') return parsed;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Both keys or neither (Codex review P04-7 #3): a failed write changes nothing. */
function writeTab(tab: TabState): void {
  const raw = JSON.stringify(tab);
  const ss = session();
  const ls = local();
  const before = { tab: ss?.getItem(TAB_KEY) ?? null, last: ls?.getItem(LAST_KEY) ?? null };
  try {
    ss?.setItem(TAB_KEY, raw);
    ls?.setItem(LAST_KEY, raw);
  } catch (err) {
    for (const [store, key, value] of [
      [ss, TAB_KEY, before.tab],
      [ls, LAST_KEY, before.last],
    ] as const) {
      try {
        if (value === null) store?.removeItem(key);
        else store?.setItem(key, value);
      } catch {
        /* could not restore either */
      }
    }
    throw err;
  }
}

export function currentBackend(): string {
  return getApiBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
}

export function activeSession(): StoredSession | null {
  return current;
}

export function activeSiteId(): string {
  return current?.siteId ?? readTab()?.siteId ?? DEFAULT_SITE;
}

export function sessionUnsaved(): boolean {
  return unsaved;
}

export function locksSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}

/**
 * Bounds (Codex review P04-11 #1): a renewal — request and answer body — is
 * given up after `renewalMs` (its outcome is then unknown: the record stays
 * marked); waiting for a record's lock at startup or logout stops after
 * `lockWaitMs`, longer than any renewal holding it.
 */
const DEFAULT_TIMING = { renewalMs: 20_000, lockWaitMs: 25_000, exchangeMs: 20_000 };
const timing = { ...DEFAULT_TIMING };

/** Test seam: shorter bounds. */
export function __setSessionTimingForTests(t: Partial<typeof timing> | null): void {
  Object.assign(timing, t ?? DEFAULT_TIMING);
}

/** How long a site switch's exchange (request and body) may take. */
export function exchangeTimeoutMs(): number {
  return timing.exchangeMs;
}

/** The lock could not be had within the wait. */
class LockWaitTimeout extends Error {}

/**
 * Run `fn` holding the cross-tab lock of one session record. With `bounded`,
 * waiting for the lock stops after `lockWaitMs` (rejects LockWaitTimeout).
 */
export function withSessionLock<T>(id: SessionIdentity, fn: () => Promise<T>, opts: { bounded?: boolean } = {}): Promise<T> {
  if (!locksSupported()) throw new Error('This browser cannot coordinate sessions between tabs (Web Locks).');
  const name = `heopress-session:${sessionKey(id)}`;
  if (!opts.bounded) return navigator.locks.request(name, fn) as Promise<T>;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timing.lockWaitMs);
  return (
    navigator.locks.request(name, { signal: stop.signal }, async () => {
      clearTimeout(timer);
      return fn();
    }) as Promise<T>
  ).catch((err: unknown) => {
    clearTimeout(timer);
    throw stop.signal.aborted ? new LockWaitTimeout() : err;
  });
}

/** The answer to a renewal request, or null when there is none in time (outcome unknown). */
export async function requestRenewal(
  s: SessionIdentity,
  refreshToken: string,
): Promise<{ status: number; data?: { token?: string; refreshToken?: string; refreshTokenExpiresAt?: string } } | null> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timing.renewalMs);
  try {
    // The one place outside the transport: renewal must pass a switch barrier.
    // eslint-disable-next-line no-restricted-syntax
    const res = await fetch(`${s.backend}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-heopress-site': s.siteId, 'x-heopress-client': 'studio' },
      body: JSON.stringify({ refreshToken }),
      signal: stop.signal,
    });
    if (!res.ok) return { status: res.status };
    // The body within the same bound: a new pair that never arrives is unknown.
    const body = (await res.json()) as { data?: { token?: string; refreshToken?: string; refreshTokenExpiresAt?: string } } | null;
    return { status: res.status, data: body?.data };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remove a signed-out record holding its lock, so not between a renewal's
 * check and its write. When the record was marked ended first (`ended`),
 * the removal is only clean-up — the mark already keeps it from being read,
 * even if a late write lands — so it runs on without holding up the logout
 * and is never done without the lock (Codex review P04-12 #1). Without the
 * mark it is awaited, bounded, and done without the lock as a last resort.
 */
async function removeLocked(s: SessionIdentity, ended: boolean): Promise<void> {
  if (!locksSupported()) {
    await removeSession(s).catch(() => undefined);
    return;
  }
  if (ended) {
    void withSessionLock(s, () => removeIfEnded(s), { bounded: true }).catch(() => undefined);
    return;
  }
  const locked = withSessionLock(s, () => removeSession(s), { bounded: true });
  try {
    await locked;
  } catch {
    await removeSession(s).catch(() => undefined);
  }
}

/** Choose the site to sign in to (before a login). */
export function setPreferredSite(siteId: string): void {
  const tab = readTab();
  writeTab({ siteId, ...(tab?.siteId === siteId ? { userId: tab.userId, sid: tab.sid } : {}) });
}

/** Load this tab's session at startup. */
export async function hydrateSession(): Promise<void> {
  await initSessionStore();
  const tab = readTab() ?? { siteId: DEFAULT_SITE };
  // A new tab starts from the last one used (or the default); from now on it
  // is its own — another tab signing in or switching site later must not
  // move it on reload (Codex review P04-7 #4).
  if (!session()?.getItem(TAB_KEY)) {
    try {
      session()?.setItem(TAB_KEY, JSON.stringify(tab));
    } catch {
      /* without sessionStorage the tab follows the last one used */
    }
  }
  if (tab.userId && tab.sid) {
    const id = { backend: currentBackend(), userId: tab.userId, sid: tab.sid, siteId: tab.siteId };
    // Read under the record's lock: a renewal under way in another tab ends
    // first, and its new pair is what loads (Codex review P04-10 #1). Still
    // marked after it: its outcome is unknown, and the session is not used.
    // The wait is bounded: a renewal that never ends must not hold the app
    // at "Loading"; read without the lock then (a record still marked is
    // not used).
    current = locksSupported()
      ? await withSessionLock(id, () => readSession(id), { bounded: true }).catch(() => readSession(id))
      : await readSession(id);
  } else {
    current = null;
  }
  listenToOtherTabs();
}

let listening = false;
function listenToOtherTabs(): void {
  if (listening || typeof window === 'undefined') return;
  window.addEventListener('storage', onStorage);
  listening = true;
}

/** Another tab replaced, removed or signed out the record this tab uses. */
function onStorage(event: StorageEvent): void {
  if (!current) return;
  // Signed out in another tab or window: this tab's copy ends at once, even
  // before the records are removed (Codex review P04-13 #2).
  if (event.key && event.newValue !== null && endedMarkCovers(event.key, current)) {
    current = null;
    return;
  }
  // The index names every stored record (in keychain mode the records
  // themselves raise no event): a record removed by another window's logout
  // ends this tab's use of it too (Codex review P04-5 #5).
  if (event.key === INDEX_KEY) {
    if (!(event.newValue ?? '').includes(JSON.stringify(sessionKey(current)))) current = null;
    return;
  }
  if (event.key !== sessionKey(current)) return;
  if (!event.newValue) {
    current = null;
    return;
  }
  try {
    const next = JSON.parse(event.newValue) as StoredSession;
    // A record marked for a renewal elsewhere is not a new pair: wait for
    // one. A signed-out one is no session at all.
    if (isSessionEnded(current)) current = null;
    else if (next.token && next.refreshToken && !next.renewing) current = next;
  } catch {
    /* ignore */
  }
}

/** Adopt the tokens of a fresh login (or a switch): store them, make them this tab's. */
export async function adoptSession(tokens: { token: string; refreshToken: string; refreshTokenExpiresAt?: string }): Promise<StoredSession> {
  const claims = sessionClaimsOf(tokens.token);
  if (!claims) throw new Error('The session token has no login session.');
  const next: StoredSession = { backend: currentBackend(), ...claims, ...tokens };
  await writeSession(next, { fresh: true });
  current = next;
  unsaved = false;
  writeTab({ siteId: next.siteId, userId: next.userId, sid: next.sid });
  listenToOtherTabs();
  return next;
}

/** Make an existing stored session this tab's (switching back to a site). */
export function enterStoredSession(stored: StoredSession): void {
  // The tab state first: if it cannot be saved, nothing changes (Codex
  // review P04-6 #2) — the page must not run on another site's session.
  writeTab({ siteId: stored.siteId, userId: stored.userId, sid: stored.sid });
  current = stored;
  unsaved = false;
}

/** Drop this tab's session locally (the server session is not touched). */
export async function forgetCurrentSession(): Promise<void> {
  const s = current;
  current = null;
  if (s) await removeLocked(s, endRecord(s));
}

/** Drop every stored session of this login (after the server ended it). */
export async function forgetLogin(id: { userId: string; sid: string }): Promise<void> {
  const ended = endLogin({ backend: currentBackend(), ...id });
  const records = withCurrentRecord(listSessions({ backend: currentBackend(), userId: id.userId, sid: id.sid }), (c) => c.userId === id.userId && c.sid === id.sid);
  if (current && current.sid === id.sid) current = null;
  for (const s of records) await removeLocked(s, ended);
}

/** Drop every stored session of a person on this backend (all their logins). */
export async function forgetAllLogins(userId: string): Promise<void> {
  const records = withCurrentRecord(listSessions({ backend: currentBackend(), userId }), (c) => c.userId === userId);
  if (current && current.userId === userId) current = null;
  for (const s of records) await removeLocked(s, endLogin(s));
}

/**
 * The records to drop, this tab's own always among them: without
 * localStorage the index is empty (keychain mode), and its record must
 * still go (Codex review P04-13 #4).
 */
function withCurrentRecord(records: SessionIdentity[], mine: (c: StoredSession) => boolean): SessionIdentity[] {
  const c = current;
  if (!c || !mine(c) || records.some((r) => sessionKey(r) === sessionKey(c))) return records;
  return [...records, { backend: c.backend, userId: c.userId, sid: c.sid, siteId: c.siteId }];
}

const renewalHold = { active: false, waiters: [] as Array<() => void> };

/** Hold new renewals (a switch has decided to go). */
export function holdRenewals(): void {
  renewalHold.active = true;
}

/** Let held renewals continue (the switch was abandoned). */
export function releaseRenewals(): void {
  renewalHold.active = false;
  for (const go of renewalHold.waiters.splice(0)) go();
}

/** Whether `id` is this tab's current session. */
export function isCurrentSession(id: SessionIdentity | null): boolean {
  return Boolean(id && current && sessionKey(id) === sessionKey(current));
}

/**
 * Renew a session — by default this tab's — coordinated across tabs.
 * Resolves to the new access token, or null when it cannot be renewed or
 * the tab no longer uses that session (a request of another login, or of a
 * session logged out meanwhile, is never renewed or retried as the current
 * one — Codex review P04-5 #1).
 */
export async function refreshActiveSession(
  target: StoredSession | null = current,
  opts: { switchControl?: boolean } = {},
): Promise<string | null> {
  const s = target;
  if (!s) return null;
  // A switch about to leave: a new renewal would rotate a token the page may
  // not live to save (Codex review P04-7 #1). It waits; the page then goes
  // away, or the switch is abandoned and it continues.
  if (renewalHold.active && !opts.switchControl) await new Promise<void>((go) => renewalHold.waiters.push(go));
  return withSessionLock(s, async () => {
    if (!isCurrentSession(s)) return null;
    const live = current!;
    const stored = await readSession(s, { includeRenewing: true });
    // Removed (logout in another tab or window): never recreate it.
    if (!stored) {
      if (isCurrentSession(s)) current = null;
      return null;
    }
    const own = rotatedAway.has(stored.refreshToken);
    if (stored.renewing && !own) {
      // A renewal of this pair (here or in another window) has no known
      // outcome: its token may be rotated. It is never presented again; the
      // session is over for this tab (Codex review P04-9 #1).
      if (isCurrentSession(s)) current = null;
      return null;
    }
    // Another tab or window already rotated it: use that pair. A stored pair
    // this tab rotated away from is stale (its write failed), not newer.
    // (Compared with the pair the caller started with: a concurrent caller
    // finds the pair the first one stored.)
    if (stored.refreshToken !== s.refreshToken && !own) {
      current = stored;
      unsaved = false;
      return stored.token;
    }
    const presented = live.refreshToken;
    // Marked before it is presented; cannot mark: do not present it.
    try {
      await beginRenewal(live);
    } catch {
      return null;
    }
    const res = await requestRenewal(s, presented);
    // Refused before any rotation (rate limit): the token is still good.
    if (res?.status === 429) {
      await abandonRenewal(live);
      return null;
    }
    // No answer in time, an error, a refusal: the mark stays (the token is
    // rotated, dead, or unknown).
    const data = res?.data;
    if (!data?.token || !data.refreshToken) return null;
    rotatedAway.add(presented);
    const next: StoredSession = { ...live, token: data.token, refreshToken: data.refreshToken, refreshTokenExpiresAt: data.refreshTokenExpiresAt };
    try {
      // In place of the marked record only: if it was removed meanwhile
      // (logout), it is not recreated.
      if (!(await settleRenewal(live, next))) {
        if (isCurrentSession(s)) current = null;
        return null;
      }
      unsaved = false;
    } catch {
      // The server rotated it; this tab keeps the pair in memory only and
      // says so — a reload will need a new sign-in.
      unsaved = true;
    }
    // Only if the tab still uses this session (it may have logged out or
    // moved to another login while the renewal was under way).
    if (!isCurrentSession(s)) return null;
    current = next;
    return next.token;
  });
}

