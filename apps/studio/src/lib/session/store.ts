import { invoke } from '@tauri-apps/api/core';
import { isDesktopShell } from '../shell';

/**
 * Studio session records (HeoPress P04 task 9.9, spec sites/site-switching).
 *
 * One record per (backend, user, login `sid`, site): two independent logins
 * of the same person on the same server never share a slot, and a site
 * reached by switching keeps its own pair. Records live in localStorage, or
 * in the OS keychain in the desktop shell; an index of record keys (names
 * only, no secrets) stays in localStorage so logout can find them all.
 *
 * Writes are awaitable and serialised per key: a caller that must not lose
 * a rotated refresh token (refresh, switch) waits for the write to land and
 * treats a failed write as a failed operation.
 */

export interface StoredSession {
  /** API origin the session belongs to. */
  backend: string;
  userId: string;
  /** Login session id (JWT `sid`). */
  sid: string;
  siteId: string;
  token: string;
  refreshToken: string;
  refreshTokenExpiresAt?: string;
  /**
   * Its refresh token has been presented for a renewal whose outcome is not
   * saved here (yet): the server may have rotated it, and presenting it again
   * would end the whole login as reuse. Such a record is never read as a
   * session (Codex reviews P04-7 #2, P04-8, P04-9). The mark lives in the
   * record itself, in its own backend (localStorage or the OS keychain).
   */
  renewing?: true;
}

export type SessionIdentity = Pick<StoredSession, 'backend' | 'userId' | 'sid' | 'siteId'>;

const PREFIX = 'heopress.session.v2';
export const INDEX_KEY = `${PREFIX}.index`;

/** Single-slot keys of builds before login sessions; their tokens are void. */
const LEGACY_KEYS = ['heopress.dev.token', 'heopress.dev.refresh'];

export function sessionKey(id: SessionIdentity): string {
  return [PREFIX, encodeURIComponent(id.backend), id.userId, id.sid, id.siteId].join('|');
}

/** The key of a login (all its sites). */
function loginKey(id: Pick<SessionIdentity, 'backend' | 'userId' | 'sid'>): string {
  return [PREFIX, encodeURIComponent(id.backend), id.userId, id.sid].join('|');
}

/**
 * Ended records and logins (Codex review P04-12 #1). Signing out writes one
 * localStorage key per ended login (or record) before the records are
 * removed; a record that is ended is never read as a session, so a late
 * write of a renewal finishing in another window cannot bring it back, even
 * if it lands after the removal. One key each — no shared list to lose
 * entries or to corrupt as a whole. A login's mark stays (its id is never
 * reused); a record's goes when a new sign-in or exchange writes it again.
 */
const ENDED = `${PREFIX}.ended|`;

function isEnded(id: SessionIdentity): boolean {
  try {
    const s = local();
    return Boolean(s && (s.getItem(ENDED + sessionKey(id)) !== null || s.getItem(ENDED + loginKey(id)) !== null));
  } catch {
    return false; // no storage: no mark could have been written either
  }
}

function markEnded(key: string): boolean {
  try {
    const s = local();
    if (!s) return false;
    s.setItem(ENDED + key, '1');
    return true;
  } catch {
    return false;
  }
}

/** Whether a storage key is an ended mark covering this record (storage events). */
export function endedMarkCovers(storageKey: string, id: SessionIdentity): boolean {
  return storageKey === ENDED + sessionKey(id) || storageKey === ENDED + loginKey(id);
}

/** Whether this record or its login was signed out. */
export function isSessionEnded(id: SessionIdentity): boolean {
  return isEnded(id);
}

/**
 * Remove a signed-out record — only while it is still marked ended: a new
 * sign-in or exchange that wrote it again meanwhile lifted the mark, and its
 * record stays (Codex review P04-13 #1).
 */
export async function removeIfEnded(id: SessionIdentity): Promise<void> {
  const key = sessionKey(id);
  await serial(key, async () => {
    if (!isEnded(id)) return;
    await backend.remove(key);
    writeIndex(readIndex().filter((k) => k !== key));
  });
}

/** Mark one record ended; false if the mark could not be stored. */
export function endRecord(id: SessionIdentity): boolean {
  return markEnded(sessionKey(id));
}

/** Mark a login ended on every site; false if the mark could not be stored. */
export function endLogin(id: Pick<SessionIdentity, 'backend' | 'userId' | 'sid'>): boolean {
  return markEnded(loginKey(id));
}

interface Backend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const localBackend: Backend = {
  async get(key) {
    return local()?.getItem(key) ?? null;
  },
  async set(key, value) {
    const s = local();
    if (!s) throw new Error('No storage available for the session.');
    s.setItem(key, value);
  },
  async remove(key) {
    local()?.removeItem(key);
  },
};

const keychainBackend: Backend = {
  async get(key) {
    return (await invoke<string | null>('secure_get', { key })) ?? null;
  },
  async set(key, value) {
    await invoke('secure_set', { key, value });
  },
  async remove(key) {
    await invoke('secure_delete', { key });
  },
};

let backend: Backend = localBackend;
/** Whether records live in the OS keychain (no storage events between windows). */
let keychainMode = false;

/** Choose the backend once at startup: the keychain in the desktop shell when it answers. */
export async function initSessionStore(): Promise<void> {
  if (isDesktopShell()) {
    try {
      await invoke<string | null>('secure_get', { key: INDEX_KEY });
      backend = keychainBackend;
      keychainMode = true;
    } catch (error) {
      console.warn('OS keychain unavailable; keeping sessions in localStorage', error);
    }
  }
  const s = local();
  for (const k of LEGACY_KEYS) s?.removeItem(k);
  if (keychainMode) {
    for (const k of ['token', 'refresh']) await keychainBackend.remove(k).catch(() => undefined);
  }
}

/** Test seam: use another backend. */
export function __setSessionBackendForTests(b: Backend | null): void {
  backend = b ?? localBackend;
  keychainMode = false;
}

const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(work);
  queues.set(key, next);
  // Housekeeping only: the caller gets `next` and its rejection; this branch
  // must not surface the same rejection again as an unhandled one.
  next
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    })
    .catch(() => undefined);
  return next;
}

function readIndex(): string[] {
  try {
    const raw = local()?.getItem(INDEX_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(keys: string[]): void {
  local()?.setItem(INDEX_KEY, JSON.stringify([...new Set(keys)]));
}

export async function readSession(id: SessionIdentity, opts: { includeRenewing?: boolean } = {}): Promise<StoredSession | null> {
  const key = sessionKey(id);
  const raw = await serial(key, () => backend.get(key));
  if (!raw) return null;
  let parsed: StoredSession;
  try {
    parsed = JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
  if (!parsed.token || !parsed.refreshToken) return null;
  // Signed out (here or in another window): never a session again.
  if (isEnded(parsed)) return null;
  // A renewal of it has no saved outcome: not a usable session.
  if (parsed.renewing && !opts.includeRenewing) return null;
  return parsed;
}

/**
 * Mark a record before its refresh token is presented; rejects if the mark
 * cannot be stored — the caller must then not present the token. A saved
 * new pair (`writeSession` of an unmarked record) or removal clears it.
 */
export async function beginRenewal(session: StoredSession): Promise<void> {
  await writeSession({ ...session, renewing: true });
}

/**
 * End a renewal begun with `beginRenewal`: store `next` in place of the
 * marked record — only if the record is still there, still marked and still
 * holds the token that was presented. A record removed meanwhile (logout) is
 * not recreated, nor is one replaced overwritten (Codex review P04-10 #2).
 * Resolves false then; rejects if storage fails.
 */
export async function settleRenewal(marked: StoredSession, next: StoredSession): Promise<boolean> {
  const key = sessionKey(marked);
  return serial(key, async () => {
    const raw = await backend.get(key);
    let stored: StoredSession | null = null;
    try {
      stored = raw ? (JSON.parse(raw) as StoredSession) : null;
    } catch {
      stored = null;
    }
    if (!stored?.renewing || stored.refreshToken !== marked.refreshToken || isEnded(marked)) return false;
    await backend.set(key, JSON.stringify(next));
    writeIndex([...readIndex(), key]);
    return true;
  });
}

/** The token was not rotated after all (refused before rotation): unmark it, if still marked. */
export async function abandonRenewal(session: StoredSession): Promise<void> {
  const { renewing: _r, ...plain } = session;
  await settleRenewal(session, plain).catch(() => false);
}

/**
 * Persist a record; resolves once it is stored, rejects if it could not be.
 * `fresh`: the pair of a new sign-in or exchange — it lifts an ended mark of
 * this record (not of its login).
 */
export async function writeSession(session: StoredSession, opts: { fresh?: boolean } = {}): Promise<void> {
  const key = sessionKey(session);
  await serial(key, async () => {
    await backend.set(key, JSON.stringify(session));
    writeIndex([...readIndex(), key]);
    if (opts.fresh) {
      try {
        local()?.removeItem(ENDED + key);
      } catch {
        /* the record stays unreadable until it can be lifted */
      }
    }
  });
}

export async function removeSession(id: SessionIdentity): Promise<void> {
  const key = sessionKey(id);
  await serial(key, async () => {
    await backend.remove(key);
    writeIndex(readIndex().filter((k) => k !== key));
  });
}

/** Records of one login (or of every login of the user when `sid` is omitted) on a backend. */
export function listSessions(filter: { backend: string; userId: string; sid?: string }): SessionIdentity[] {
  return readIndex()
    .map((key) => key.split('|'))
    .filter((p) => p.length === 5 && p[0] === PREFIX)
    .map(([, backendEnc, userId, sid, siteId]) => ({ backend: decodeURIComponent(backendEnc!), userId: userId!, sid: sid!, siteId: siteId! }))
    .filter((s) => s.backend === filter.backend && s.userId === filter.userId && (!filter.sid || s.sid === filter.sid));
}
