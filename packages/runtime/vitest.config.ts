// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { defineConfig } from 'vitest/config';

// The PostgreSQL adapter suites (`*.db.test.ts`) share one database and reset
// its runtime tables, so files run one at a time when DATABASE_URL is set.
const hasDatabase = Boolean(process.env.DATABASE_URL);

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    fileParallelism: !hasDatabase,
  },
});
