// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { defineConfig } from 'vitest/config';

/**
 * With `DATABASE_URL` set, the `*.db.test.ts` files share one PostgreSQL:
 * the role and RLS probes run DDL (AccessExclusiveLock) while other files
 * delete sites, which cascades through many tables, and the two deadlock.
 * Run files one at a time then, as `apps/cms` does.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.{test,spec}.ts', 'src/**/*.property.test.ts'],
    fileParallelism: !hasDatabase,
  },
});
