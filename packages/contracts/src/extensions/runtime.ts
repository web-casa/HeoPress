/**
 * Runtime extension points of a plugin (HeoPress P12 tasks 3.1–3.7, spec extensions/runtime-extensions): the limits the
 * host enforces and the shapes it accepts for jobs, public endpoints, event subscriptions, pre-publish hooks and private
 * storage. Pure, no runtime dependencies: shared by the CMS (enforcement), Studio (display) and the SDK documentation.
 *
 * A plugin may ask for less than a limit, never for more: `clampLimit` caps every declared value at the host ceiling.
 */

/** Per-run limits of a plugin job (task 3.2). */
export const JOB_LIMITS = {
  /** Wall-clock budget of one run (ms): default and ceiling. */
  durationMs: { default: 30_000, max: 120_000, min: 100 },
  /** Outbound requests (`ctx.fetch`) one run may make. */
  requests: { default: 20, max: 100, min: 0 },
  /** Retries after a failed run before the job waits for its next schedule. */
  retries: { default: 3, max: 5, min: 0 },
  /** Shortest schedule interval (minutes) and longest (one week). */
  intervalMinutes: { min: 5, max: 10_080 },
  /** First retry delay (ms); doubles per attempt. */
  retryBaseMs: 60_000,
  /** Delay before the next batch of a continued run (ms). */
  continuationDelayMs: 1_000,
} as const;

/** Limits of a public endpoint (task 3.3). */
export const ENDPOINT_LIMITS = {
  /** Request body bytes: default and ceiling. */
  bodyBytes: { default: 16 * 1024, max: 64 * 1024, min: 1 },
  /** Requests per minute per client address and endpoint. */
  ratePerMinute: { default: 30, max: 120, min: 1 },
  /** Wall-clock budget of one handler call (ms). */
  durationMs: { default: 5_000, max: 10_000, min: 100 },
  /** Outbound requests one handler call may make. */
  requests: { default: 5, max: 20, min: 0 },
  /** A server callback's timestamp may be at most this far from the server clock (s). */
  callbackToleranceSeconds: 300,
} as const;

/** Limits of event subscriptions and pre-publish hooks (task 3.4). */
export const EVENT_LIMITS = {
  /** One event handler call (ms). */
  handlerMs: { default: 10_000, max: 30_000, min: 100 },
  /** One pre-publish hook (ms); running out of time is a veto. */
  prePublishMs: { default: 3_000, max: 5_000, min: 100 },
  /** Outbound requests per event handler call. */
  requests: { default: 5, max: 20, min: 0 },
  /** Attempts before an event goes to the subscription's dead letter. */
  maxAttempts: 5,
} as const;

/** Private storage limits (task 3.7). */
export const STORAGE_LIMITS = {
  /** Bytes of one document (JSON). */
  documentBytes: 64 * 1024,
  /** Documents one query returns at most. */
  pageSize: { default: 50, max: 200 },
  /** Document id: short, URL-safe. */
  idPattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,
} as const;

/** The reserved public path prefix of plugin endpoints: `/_ext/<plugin>/<endpoint>`. */
export const PLUGIN_ENDPOINT_PREFIX = '/_ext/';

/** Plugin endpoint names and job / subscription / hook names. */
export const RUNTIME_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export function clampLimit(value: unknown, limit: { default: number; max: number; min: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return limit.default;
  return Math.min(limit.max, Math.max(limit.min, Math.floor(value)));
}

/** Endpoint kinds: a browser form (origin-checked) or a server callback (signed). */
export type PluginEndpointKind = 'form' | 'callback';

/** Callback signature headers (task 3.3): `v1=<hex HMAC-SHA256(secret, "<timestamp>.<nonce>.<body>")>`. */
export const CALLBACK_HEADERS = {
  timestamp: 'x-heopress-timestamp',
  nonce: 'x-heopress-nonce',
  signature: 'x-heopress-signature',
} as const;

/** The string a callback signature covers. */
export function callbackSigningInput(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}.${nonce}.${body}`;
}

/** Whether a nonce is acceptable: 16–128 URL-safe characters. */
export function isValidNonce(nonce: string | null | undefined): nonce is string {
  return typeof nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(nonce);
}

/**
 * Whether a storage query only filters on a declared index (task 3.7): the filter's fields must be a prefix of one of
 * the namespace's indexes (`[]` — no filter — is always allowed). Undeclared lookups would be full scans.
 */
export function indexCovers(indexes: readonly (readonly string[])[], fields: readonly string[]): boolean {
  if (fields.length === 0) return true;
  const wanted = [...new Set(fields)].sort();
  return indexes.some((index) => {
    if (index.length < wanted.length) return false;
    const prefix = [...index.slice(0, wanted.length)].sort();
    return prefix.every((f, i) => f === wanted[i]);
  });
}

/** The origin (`scheme://host[:port]`) of a URL, lowercase; null when it is not an http(s) URL. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}
