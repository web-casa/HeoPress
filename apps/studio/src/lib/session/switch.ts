import { getAdminBase } from '../admin-base';
import { inFlightWrites, lowerBarrier, raiseBarrier, transportFetch } from '../http';
import {
  activeSession,
  activeSiteId,
  enterStoredSession,
  exchangeTimeoutMs,
  holdRenewals,
  isCurrentSession,
  refreshActiveSession,
  releaseRenewals,
  requestRenewal,
  sessionUnsaved,
  setPreferredSite,
  withSessionLock,
} from './current';
import { abandonRenewal, beginRenewal, readSession, removeSession, settleRenewal, writeSession, type StoredSession } from './store';

/**
 * Switching this tab to another site (HeoPress P04 task 9.10, spec
 * sites/site-switching "切换不串站").
 *
 * 1. A barrier holds new requests (the switch's own pass).
 * 2. A renewal in progress finishes (its lock is taken once); a session the
 *    server renewed but this browser could not save cannot be switched from.
 * 3. Writes in flight get up to 10 s; if some are still pending the person
 *    is told their result is unknown and decides whether to continue — they
 *    are never reported as done nor repeated on the other site.
 * 4. The destination session: one of the same login already stored here,
 *    if a renewal confirms it; otherwise exchanged with the server, under the
 *    source session's lock with its refresh token read again there (another
 *    tab may just have rotated it). It is stored before going on.
 * 5. It becomes this tab's session, and the page navigates to the admin
 *    home: the old page — requests, realtime connections, timers, state,
 *    caches — is gone, so nothing of the old site can show on the new one.
 *
 * Any failure, or declining to continue, lowers the barrier: the held
 * requests go on and the tab stays where it was, on its own session. The
 * switch belongs to the session it started from: if the tab's login changed
 * or ended meanwhile, it stops (Codex review P04-6 #6). Without a token
 * session (Cloudflare Access and other gateways) there is nothing to
 * exchange: after the same wait for saves, the tab addresses the other site.
 */

type SwitchFailure =
  | 'CANCELLED'
  | 'SITE_NOT_ALLOWED'
  | 'MFA_REQUIRED'
  | 'INVALID_SESSION'
  | 'NOT_SUPPORTED'
  | 'RATE_LIMITED'
  | 'SAVE_FAILED'
  | 'FAILED';
export type SwitchResult = { ok: true } | { ok: false; code: SwitchFailure; message: string };

export interface SwitchOptions {
  /** Ask whether to switch although writes are still pending (result unknown). */
  confirmUnknownWrites: () => boolean;
  /** Full navigation (default: `window.location.assign`). */
  navigate?: (url: string) => void;
  /** How long to wait for writes in flight (default 10 s). */
  writeWaitMs?: number;
}

const MESSAGES: Record<SwitchFailure, string> = {
  CANCELLED: 'Switch cancelled.',
  SITE_NOT_ALLOWED: 'You cannot use Studio on that site.',
  MFA_REQUIRED: 'That site requires two-factor authentication: sign in there.',
  INVALID_SESSION: 'Your session has ended. Please sign in again.',
  NOT_SUPPORTED: 'Sign in on that site to use it.',
  RATE_LIMITED: 'Too many site switches. Try again shortly.',
  SAVE_FAILED: 'The session for that site could not be saved in this browser.',
  FAILED: 'The site could not be switched. Try again.',
};
const fail = (code: SwitchFailure, message = MESSAGES[code]): SwitchResult => ({ ok: false, code, message });

type Prepared = StoredSession | 'addressed' | { code: SwitchFailure; message?: string };

let switching = false;

export async function switchSite(targetSiteId: string, opts: SwitchOptions): Promise<SwitchResult> {
  const source = activeSession();
  const fromSite = activeSiteId();
  if (targetSiteId === fromSite) return { ok: true };
  if (switching) return fail('FAILED');
  switching = true;
  let leaving = false;
  raiseBarrier();
  try {
    // The tab still uses the session the switch started from (or still none).
    const unchanged = () => (source ? isCurrentSession(source) : activeSession() === null);
    if (source) {
      // A renewal in progress finishes (and is stored) first.
      await withSessionLock(source, async () => undefined);
      if (sessionUnsaved()) return fail('SAVE_FAILED');
    }
    if (!(await writesSettled(opts.writeWaitMs ?? 10_000)) && !opts.confirmUnknownWrites()) return fail('CANCELLED');
    // From here no new renewal starts (a late read's 401 would rotate a token
    // the page may not live to save); one already started finishes first.
    holdRenewals();
    if (source) {
      await withSessionLock(source, async () => undefined);
      if (sessionUnsaved()) return fail('SAVE_FAILED');
    }
    if (!unchanged()) return fail('INVALID_SESSION');

    const dest: Prepared = source ? await destinationSession(source, targetSiteId, unchanged) : 'addressed';
    if (dest !== 'addressed' && 'code' in dest) return fail(dest.code, dest.message);
    if (!unchanged()) return fail('INVALID_SESSION');

    const before = activeSession();
    if (dest === 'addressed') setPreferredSite(targetSiteId);
    else enterStoredSession(dest);
    try {
      (opts.navigate ?? ((url: string) => window.location.assign(url)))(getAdminBase(window.location.pathname) || '/');
    } catch {
      // Not leaving after all: back to the source, held requests go on.
      if (before) enterStoredSession(before);
      else setPreferredSite(fromSite);
      return fail('FAILED');
    }
    leaving = true;
    return { ok: true };
  } catch {
    return fail('FAILED');
  } finally {
    // Leaving: the page goes away with its held requests. Otherwise they go on.
    if (!leaving) {
      releaseRenewals();
      lowerBarrier();
    }
    switching = false;
  }
}

async function writesSettled(ms: number): Promise<boolean> {
  const pending = inFlightWrites();
  if (pending.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  const settled = Promise.allSettled(pending).then(() => true as const);
  const done = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return done && inFlightWrites().length === 0;
}

async function destinationSession(source: StoredSession, siteId: string, unchanged: () => boolean): Promise<Prepared> {
  // The same login already reached that site here: reuse it if it renews.
  const stored = await readSession({ ...source, siteId });
  if (stored) {
    const renewed = await renewStored(stored);
    if (renewed === 'unsaved') return { code: 'SAVE_FAILED' };
    if (renewed) return renewed;
  }
  let res = await exchange(source, siteId);
  if (res === 'ended') return { code: 'INVALID_SESSION' };
  if (res === 'unsaved') return { code: 'SAVE_FAILED' };
  if (res.status === 401 && isCurrentSession(source)) {
    // The access token may just have expired: renew it once, then retry.
    if (!(await refreshActiveSession(source, { switchControl: true })) || sessionUnsaved()) return { code: sessionUnsaved() ? 'SAVE_FAILED' : 'INVALID_SESSION' };
    const again = await exchange(activeSession()!, siteId);
    if (again === 'ended') return { code: 'INVALID_SESSION' };
    if (again === 'unsaved') return { code: 'SAVE_FAILED' };
    res = again;
  }
  if (!res.ok) {
    const code = res.code;
    if (code === 'SITE_NOT_ALLOWED' || code === 'MFA_REQUIRED' || code === 'INVALID_SESSION') return { code };
    if (code === 'NOT_NEEDED') return 'addressed';
    if (code === 'NOT_SUPPORTED') return { code: 'NOT_SUPPORTED' };
    if (res.status === 429) {
      const after = res.retryAfter ?? 0;
      return { code: 'RATE_LIMITED', ...(after > 0 ? { message: `Too many site switches. Try again in ${after} s.` } : {}) };
    }
    return { code: res.status === 401 ? 'INVALID_SESSION' : 'FAILED' };
  }
  const data = res.data;
  if (!data?.token || !data.refreshToken || !data.sid || !data.site?.id) return { code: 'FAILED' };
  const next: StoredSession = {
    backend: source.backend,
    userId: source.userId,
    sid: data.sid,
    siteId: data.site.id,
    token: data.token,
    refreshToken: data.refreshToken,
    refreshTokenExpiresAt: data.refreshTokenExpiresAt,
  };
  // The login this switch started from was replaced or ended meanwhile.
  if (!unchanged()) return { code: 'INVALID_SESSION' };
  try {
    // Under the destination record's lock: a signed-out clean-up of an
    // earlier record there cannot interleave (Codex review P04-13 #1).
    await withSessionLock(next, () => writeSession(next, { fresh: true }));
  } catch {
    return { code: 'SAVE_FAILED' };
  }
  return next;
}

/** The answer of an exchange, its body read within the bound. */
interface ExchangeAnswer {
  ok: boolean;
  status: number;
  code?: string;
  retryAfter?: number;
  data?: { token?: string; refreshToken?: string; refreshTokenExpiresAt?: string; sid?: string; site?: { id?: string } };
}

/** Exchange under the source session's lock, its refresh token read again there. */
function exchange(source: StoredSession, siteId: string): Promise<ExchangeAnswer | 'ended' | 'unsaved'> {
  return withSessionLock(source, async () => {
    // Bounded — request and body (Codex reviews P04-11 #1, P04-13 #3): it
    // holds the source session's lock and the switch barrier.
    // (A controller and a timer: AbortSignal.timeout is newer than Web Locks.)
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), exchangeTimeoutMs());
    const tooLong = new Promise<never>((_, reject) =>
      stop.signal.addEventListener('abort', () => reject(new Error('The exchange took too long.')), { once: true }),
    );
    tooLong.catch(() => undefined);
    try {
      const res = await Promise.race([exchangeLocked(source, siteId, stop.signal), tooLong]);
      if (typeof res === 'string') return res;
      // The body within the same bound: an answer that stalls mid-body must
      // not hold the lock and the barrier (an aborted read may not end itself).
      const body = (await Promise.race([res.json().catch(() => null), tooLong])) as {
        data?: ExchangeAnswer['data'];
        errors?: Array<{ code?: string }>;
      } | null;
      return {
        ok: res.ok,
        status: res.status,
        code: body?.errors?.[0]?.code,
        retryAfter: Number(res.headers.get('retry-after')) || undefined,
        data: body?.data,
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

async function exchangeLocked(source: StoredSession, siteId: string, signal: AbortSignal): Promise<Response | 'ended' | 'unsaved'> {
  // Renewed here but not saved: the stored token is already rotated away.
  if (sessionUnsaved()) return 'unsaved' as const;
  const live = (await readSession(source)) ?? null;
  if (!live) return 'ended' as const;
  return transportFetch(`${source.backend}/api/v1/auth/switch-site`, {
    method: 'POST',
    switchControl: true,
    untracked: true,
    headers: {
      authorization: `Bearer ${live.token}`,
      'x-heopress-site': source.siteId,
      'x-heopress-client': 'studio',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ siteId, refreshToken: live.refreshToken }),
    signal,
  });
}

/**
 * Renew a stored (not current) session under its own lock; null if it cannot
 * be. The record is marked before its token is presented; a renewal that did
 * not end in a saved new pair leaves it marked and removes it: its refresh
 * token is refused, or may have been rotated (no answer, an error, an
 * unreadable answer, a failed save) — presenting it again would end the
 * whole login as reuse (Codex reviews P04-6 #1, P04-9). The switch then
 * exchanges.
 */
function renewStored(stored: StoredSession): Promise<StoredSession | null | 'unsaved'> {
  return withSessionLock(stored, async () => {
    const live = await readSession(stored);
    if (!live) return null;
    // Marked before its token is presented; the mark goes when the new pair
    // is saved (or the record removed). Cannot mark: do not present it.
    try {
      await beginRenewal(live);
    } catch {
      return null;
    }
    // Its outcome is not a saved new pair: remove it (best effort — if that
    // fails, the mark keeps it from ever being read as a session).
    const drop = () => removeSession(live).catch(() => undefined);
    const res = await requestRenewal(live, live.refreshToken);
    // Refused before any rotation (rate limit): the token is still good.
    if (res?.status === 429) {
      await abandonRenewal(live);
      return null;
    }
    const data = res?.data;
    if (!data?.token || !data.refreshToken) {
      await drop();
      return null;
    }
    const next: StoredSession = { ...live, token: data.token, refreshToken: data.refreshToken, refreshTokenExpiresAt: data.refreshTokenExpiresAt };
    try {
      // Removed meanwhile (logout): not recreated.
      if (!(await settleRenewal(live, next))) return null;
    } catch {
      await drop();
      return 'unsaved' as const;
    }
    return next;
  });
}
