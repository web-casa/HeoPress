// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { createHeoPressClient, legacyRest } from '@heopress/sdk';
import { getAdminBase } from '@/lib/admin-base';
import { getApiBaseUrl } from '@/lib/api-base';
import { siteFetch } from '@/lib/http';
import {
  activeSession,
  activeSiteId,
  adoptSession,
  forgetAllLogins,
  forgetCurrentSession,
  forgetLogin,
  isCurrentSession,
  setPreferredSite,
} from '@/lib/session/current';

/**
 * Studio API client. The base URL is resolved by `getApiBaseUrl()`:
 * same-origin in dev (Vite proxy) and Docker, or the absolute CMS origin
 * (`VITE_API_URL`) when the Studio is deployed standalone. The session and
 * site are this tab's (`lib/session/current.ts`, HeoPress P04): records per
 * backend/user/login/site in localStorage or the desktop keychain, renewed
 * under a cross-tab lock; every request goes through `lib/http.ts`.
 */

export function getActiveSite(): string {
  return activeSiteId();
}

/** Choose the site to sign in to. */
export function setActiveSite(siteId: string): void {
  setPreferredSite(siteId);
  cached = null;
}

export function getActiveToken(): string {
  return activeSession()?.token ?? '';
}

/** Adopt the tokens of a sign-in for this tab (stored before it resolves). */
export async function setActiveLogin(tokens: { token: string; refreshToken: string; refreshTokenExpiresAt?: string }): Promise<void> {
  await adoptSession(tokens);
  cached = null;
}

export function clearActiveToken(): void {
  void forgetCurrentSession();
  cached = null;
}

const LOGOUT_TIMEOUT_MS = 10_000;

/**
 * End the login on the server — on every site it reached — and drop its
 * stored sessions here. Always resolves: a network error must not block the
 * local logout (the server session then stays valid until it expires).
 */
export async function logout(): Promise<{ endedOnServer: boolean }> {
  const s = activeSession();
  let endedOnServer = false;
  // Bounded (Codex review P04-12 #2): a server that never answers must not
  // hold the local logout; it then counts as not ended there.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), LOGOUT_TIMEOUT_MS);
  try {
    // eslint-disable-next-line no-restricted-syntax
    const res = await fetch(`${s?.backend ?? getApiBaseUrl()}/api/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      signal: stop.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-HeoPress-Site': getActiveSite(),
        'X-HeoPress-Refresh': '1',
      },
      body: JSON.stringify(s ? { refreshToken: s.refreshToken } : {}),
    });
    endedOnServer = res.ok;
  } catch {
    /* best-effort; clear locally regardless */
  } finally {
    clearTimeout(timer);
  }
  if (s) await forgetLogin(s);
  else await forgetCurrentSession();
  cached = null;
  return { endedOnServer };
}

/**
 * End every login of the person — all devices, all sites — then drop this
 * browser's sessions of them. Throws when the server refused or was unreachable.
 */
export async function logoutEverywhere(): Promise<void> {
  const s = activeSession();
  // The whole call is bounded — a switch barrier or a renewal wait included
  // (Codex review P04-13 #5); the request itself is cancelled too.
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve(null);
    }, LOGOUT_TIMEOUT_MS);
  });
  const res = await Promise.race([siteFetch('/api/v1/me/sessions', { method: 'DELETE', signal: stop.signal }).catch(() => null), timeout]);
  clearTimeout(timer);
  if (!res?.ok) throw new Error('The sessions could not be ended.');
  if (s) await forgetAllLogins(s.userId);
  cached = null;
}

export function hasActiveToken(): boolean {
  return getActiveToken().length > 0;
}

/**
 * Set once we have kicked off a redirect to the login screen so a burst of
 * parallel requests all 401-ing at the same time (e.g. the dashboard firing
 * collections + roles + flows together) only triggers a single navigation.
 * Reset implicitly by the full page load the redirect performs.
 */
let unauthorizedRedirectInFlight = false;

/**
 * Global `401 Unauthorized` handler. A stale/expired token in localStorage
 * is otherwise treated as "logged in" by the gate, letting the shell mount
 * and every API call 401 with a misleading "Failed to load…" message. On the
 * first 401 we clear the token and send the operator to the admin login page,
 * derived from the current URL's `/{adminPath}` prefix (the Zustand setup
 * store may be empty after a reload, so we do NOT rely on it here).
 */
export function handleUnauthorized(): void {
  if (typeof window === 'undefined') return;
  if (unauthorizedRedirectInFlight) return;

  // No token means nothing stale to clear: the auth gate is already showing
  // the login screen, and anonymous requests made before sign-in (the UI
  // translations, for one) legitimately answer 401. Redirecting here is how a
  // Studio served at the root reloaded itself forever — `/` → 401 → assign('/')
  // → 401 … until the API limiter answered 429 (B99).
  if (!hasActiveToken()) return;

  const { pathname } = window.location;
  // Already on a login/recovery page → clearing + redirecting would loop.
  const adminBase = getAdminBase(pathname);
  const rest = adminBase ? pathname.slice(adminBase.length) : pathname;
  if (rest.startsWith('/login') || rest.startsWith('/recovery')) {
    clearActiveToken();
    return;
  }

  unauthorizedRedirectInFlight = true;
  clearActiveToken();
  // On `/` this is a reload, and that is fine: the token is gone, so the
  // reloaded page's anonymous 401s stop at the early return above.
  window.location.assign(adminBase ? `${adminBase}/login` : '/');
}

function createApiClient(site: string) {
  const session = activeSession();
  return createHeoPressClient({
    url: getApiBaseUrl(),
    token: session?.token ?? '',
    siteId: site,
    headers: { 'X-HeoPress-Client': 'studio' },
    // The Studio transport does the rest (P04): this tab's token, one
    // renewal bound to the session the request started with, the switch
    // barrier, writes tracked until their final result.
    fetcher: siteFetch as typeof fetch,
    // A late 401 of a session the tab no longer uses must not sign out the
    // one it uses now.
    onUnauthorized: () => {
      if (isCurrentSession(session)) handleUnauthorized();
    },
  }).with(legacyRest());
}

export type StudioApiClient = ReturnType<typeof createApiClient>;

let cached: { client: StudioApiClient; key: string } | null = null;

export function getApiClient(): StudioApiClient {
  const s = activeSession();
  const key = `${getActiveSite()}|${s ? `${s.userId}|${s.sid}` : ''}`;
  if (!cached || cached.key !== key) {
    cached = { key, client: createApiClient(getActiveSite()) };
  }
  return cached.client;
}
