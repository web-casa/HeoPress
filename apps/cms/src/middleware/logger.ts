// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { MiddlewareHandler } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../env';
import { ADMIN_PATH_PLACEHOLDER, shouldRetainRawAdminPath } from '../modules/audit/path-mask';

/**
 * Structured request logger. Assigns a `requestId` and prints JSON lines so
 * Workers Logpush can ingest them directly.
 */
export const withLogger = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? nanoid(12);
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);

  const start = Date.now();
  try {
    await next();
  } finally {
    const durMs = Date.now() - start;
    // Structured log line. Avoid logging full bodies — privacy first.
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        requestId,
        method: c.req.method,
        path: loggedPath(c.req.path, c.get('responseType')),
        status: c.res.status,
        durMs,
        site: c.get('siteId'),
        user: c.get('auth')?.userId ?? c.get('auth')?.externalId,
      }),
    );
  }
};

/**
 * The path as it is logged: secrets that travel in a path are masked (HeoPress P13 tasks 3.3, 3.4: admin secrets
 * are not logged). The private Studio path chosen at setup (docs/en/deployment/private-admin-path.md: "mask the
 * private admin path in logs") — a request the admin path guard tagged `STUDIO_HTML`, kept raw only at `debug` like
 * the audit log (`modules/audit/path-mask.ts`, Req 5.5) — and the token of a public share link
 * (`/api/v1/shares/<token>`).
 */
export function loggedPath(path: string, responseType?: string, logLevel?: string): string {
  if (responseType === 'STUDIO_HTML' && !shouldRetainRawAdminPath(logLevel)) return `/${ADMIN_PATH_PLACEHOLDER}`;
  return path.replace(/^(\/api\/v1\/shares\/)[^/]+/, '$1<token>');
}
