#!/usr/bin/env -S npx tsx
// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * CMS-facing migration CLI shim.
 *
 * Usage:
 *   heopress migrations version
 *   heopress migrations preflight
 *   heopress migrations dry-run
 */

export {};

process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'heopress', ...process.argv.slice(2)];
await import('../../../packages/database/scripts/migrate.js');
