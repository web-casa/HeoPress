#!/usr/bin/env tsx
/**
 * Create or update the application role (P03 task 7.1). Run as the owner of
 * the tables, after migrations:
 *
 *   DATABASE_URL=<owner url> HEOPRESS_APP_ROLE=heopress_app \
 *     HEOPRESS_APP_PASSWORD=<secret> pnpm --filter @heopress/database app-role
 *
 * Then point the application (and the database test suites) at the app role.
 *
 * `--render` provisions the rendering service's read-only role instead (P06, design R20):
 * HEOPRESS_RENDER_ROLE (default heopress_render), HEOPRESS_RENDER_PASSWORD.
 *
 * `--test-database` also grants TRUNCATE, which the database test suites use
 * to reset tables, and lifts the hold on deleted site ids in that database. Row-level security does not apply to TRUNCATE: never pass
 * it for a deployment.
 */
import postgres from 'postgres';
import { ensureAppRole } from '../src/app-role';
import { ensureRenderRole } from '../src/render-role';

const url = process.env.DATABASE_URL;
const render = process.argv.includes('--render');
const role = render ? process.env.HEOPRESS_RENDER_ROLE || 'heopress_render' : process.env.HEOPRESS_APP_ROLE || 'heopress_app';
const password = render ? process.env.HEOPRESS_RENDER_PASSWORD : process.env.HEOPRESS_APP_PASSWORD;
const testDatabase = process.argv.includes('--test-database');
if (!url || !password) {
  console.error(`[app-role] DATABASE_URL (owner) and ${render ? 'HEOPRESS_RENDER_PASSWORD' : 'HEOPRESS_APP_PASSWORD'} are required.`);
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  if (render) {
    // One transaction: a failure leaves the role as it was, never half revoked.
    await sql.begin((tx) => ensureRenderRole(tx, { role, password }));
    console.log(`[app-role] ${role} ready (rendering role: reads the public projection only)`);
  } else {
    await ensureAppRole(sql, { role, password, testDatabase });
    console.log(`[app-role] ${role} ready (no superuser, no BYPASSRLS${testDatabase ? '; TRUNCATE for test suites' : ''})`);
  }
} catch (err) {
  console.error('[app-role] FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
