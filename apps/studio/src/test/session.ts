/** An unsigned session JWT carrying the claims Studio files a session by. */
export function fakeSessionJwt(claims: { userId?: string; sid?: string; siteId?: string; n?: number } = {}): string {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'HS256' })}.${enc({ userId: 'u1', sid: 's1', siteId: 'site_a', ...claims })}.sig`;
}

/**
 * A Web Locks stand-in for jsdom: exclusive per name, in this realm; takes
 * `(name, fn)` or `(name, { signal }, fn)` — an abort while waiting rejects
 * with AbortError and never runs `fn`.
 */
export function installFakeLocks(): void {
  const chains = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, a: unknown, b?: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
        const signal = typeof a === 'object' && a ? (a as { signal?: AbortSignal }).signal : undefined;
        const prev = (chains.get(name) ?? Promise.resolve()).catch(() => undefined);
        const acquired = signal
          ? Promise.race([
              prev,
              new Promise<never>((_, reject) =>
                signal.addEventListener('abort', () => reject(new DOMException('Lock wait aborted', 'AbortError')), { once: true }),
              ),
            ])
          : prev;
        const next = acquired.then(() => fn());
        // Later requests wait for whoever holds it, even if this one gave up waiting.
        chains.set(name, Promise.all([prev, next.catch(() => undefined)]));
        return next;
      },
    },
  });
}

/**
 * A session backend that stores the mark set before a renewal but fails to
 * store the new pair: "the server rotated it, this browser could not save it".
 */
export function failingAfterMarkBackend() {
  return {
    get: async (key: string) => localStorage.getItem(key),
    set: async (key: string, value: string) => {
      if (!value.includes('"renewing":true')) throw new Error('disk full');
      localStorage.setItem(key, value);
    },
    remove: async (key: string) => localStorage.removeItem(key),
  };
}
