import { getApiBaseUrl } from './api-base';
import { activeSession, activeSiteId, isCurrentSession, refreshActiveSession } from './session/current';

/**
 * The one HTTP outlet of Studio (HeoPress P04 tasks 9.9–9.10).
 *
 * Every request to the CMS goes through here — `siteFetch` for the current
 * session and site, `publicFetch` for sign-in, setup and other anonymous
 * calls, and `transportFetch` underneath the SDK client — so that:
 *
 *   - a site switch can hold new requests at its barrier (they wait; the page
 *     then navigates away, or they continue if the switch is abandoned);
 *   - the switch knows which writes are still in flight;
 *   - a `401` renews the session once through the cross-tab coordinator and
 *     retries.
 *
 * ESLint forbids calling `fetch` anywhere else in Studio.
 */

export interface TransportInit extends RequestInit {
  /** Requests of the switch itself pass the barrier. */
  switchControl?: boolean;
}

const barrier = { active: false, waiters: [] as Array<() => void> };
const writes = new Set<Promise<unknown>>();

/** Hold new requests (a site switch is preparing). */
export function raiseBarrier(): void {
  barrier.active = true;
}

/** Let held requests continue (the switch was abandoned). */
export function lowerBarrier(): void {
  barrier.active = false;
  const waiting = barrier.waiters.splice(0);
  for (const go of waiting) go();
}

/** Writes in flight, to wait for before switching. */
export function inFlightWrites(): Promise<unknown>[] {
  return [...writes];
}

/** A path against the configured API base; same-origin paths stay as they are. */
function absolute(input: string): string {
  const base = getApiBaseUrl();
  return /^https?:\/\//i.test(input) || !base ? input : `${base}${input}`;
}

function isWrite(init?: RequestInit): boolean {
  const method = (init?.method ?? 'GET').toUpperCase();
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/**
 * Wait at the barrier unless the request is allowed through it. Nothing to
 * wait for: undefined, so a write is registered at once, not a tick later.
 */
function admission(init: TransportInit): Promise<void> | undefined {
  return barrier.active && !init.switchControl ? new Promise<void>((go) => barrier.waiters.push(go)) : undefined;
}

/** Barrier and write tracking, no authentication. */
export async function transportFetch(input: RequestInfo | URL, init: TransportInit & { untracked?: boolean } = {}): Promise<Response> {
  const wait = admission(init);
  if (wait) await wait;
  const { switchControl: _control, untracked, ...rest } = init;
  const url = typeof input === 'string' ? absolute(input) : input;
  // eslint-disable-next-line no-restricted-syntax
  const request = fetch(url, rest);
  return untracked || !isWrite(rest) ? request : track(request);
}

async function track<T>(work: Promise<T>): Promise<T> {
  writes.add(work);
  try {
    return await work;
  } finally {
    writes.delete(work);
  }
}

/** A request without a session (sign-in, setup, recovery, presigned uploads). */
export function publicFetch(input: string, init: TransportInit = {}): Promise<Response> {
  return transportFetch(input, init);
}

/**
 * A request as this tab's session on its site: bearer token and site header
 * set (callers' own values for them are replaced), one renewal on `401`.
 *
 * The request belongs to the session that started it (Codex review P04-5):
 * the renewal and the retry happen only while the tab still uses that
 * session — never as a login adopted meanwhile; a write is tracked from
 * when it passes the barrier until its final result (renewal and retry
 * included) — one still held at the barrier is not "being saved" (Codex
 * review P04-6 #5); the retry of a request already admitted passes a
 * barrier raised in between.
 */
export function siteFetch(input: string | URL | Request, init: TransportInit = {}): Promise<Response> {
  const session = activeSession();
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    headers.set('x-heopress-site', session?.siteId ?? activeSiteId());
    return transportFetch(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input, {
      ...init,
      headers,
      untracked: true,
      // Admitted already (below): neither the request nor its retry waits again.
      switchControl: true,
    });
  };
  const run = async () => {
    const res = await send(session?.token ?? '');
    if (res.status !== 401 || !session || !isCurrentSession(session)) return res;
    const next = await refreshActiveSession(session);
    return next && isCurrentSession(session) ? send(next) : res;
  };
  const go = () => (isWrite(init) ? track(run()) : run());
  const wait = admission(init);
  return wait ? wait.then(go) : go();
}
