// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Row-level security guard (HeoPress P14 task 1.3, ADR-0023).
 *
 * Defence in depth: even if an application-level site condition is missing, PostgreSQL row-level security keeps a
 * request to its own site's rows. The scope is not set here: `withDb()` gives the request a scoped handle
 * (`scopedDatabase`), whose every statement sets `app.site_id` inside its own transaction. Setting it once on the pool
 * (what this middleware did before P14) had no effect: `set_config(…, true)` outside a transaction ends with its own
 * statement.
 *
 * This middleware only asserts that `c.get('db')` is scoped to the request's site, and fails closed (503
 * `RLS_UNAVAILABLE`) when it is not — the same in every environment. Usage:
 *
 *   api.use('*', withTenant(), withDb(), …, withRls());
 */

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { hasSiteScope } from './db';

export function withRls() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const siteId = c.get('siteId');
    if (siteId && !hasSiteScope(c.get('db'), siteId)) {
      // A request whose handle is not in its site's scope would rely on the application-level site conditions alone:
      // reject it rather than run with the database-level isolation absent.
      console.error('[rls] the request database handle is not scoped to the request site — failing closed', {
        requestId: c.get('requestId'),
      });
      return c.json(
        { errors: [{ code: 'RLS_UNAVAILABLE', message: 'Request could not be securely scoped. Please retry.' }] },
        503,
      );
    }
    await next();
  });
}
