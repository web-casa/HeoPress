// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { defineConfig } from 'vitest/config';

/**
 * When `DATABASE_URL` is set, the suite's `*.integration.test.ts` /
 * `*.db.integration.test.ts` files run against ONE shared Postgres and each
 * resets shared tables (`users`, `audit_log`, `sites`, …) in `beforeEach`.
 * Running those files in parallel lets one file's TRUNCATE wipe another
 * file's fixtures mid-test, so we serialize file execution whenever a
 * database is configured. Without `DATABASE_URL` those suites self-skip and
 * the remaining pure/property tests run in parallel with a bounded worker pool.
 */
const hasDatabase = Boolean(process.env.DATABASE_URL);

export default defineConfig({
  test: {
    globals: true,
    // Keep isolated file workers bounded when Turbo runs package suites together.
    // Hundreds of concurrent imports can otherwise exhaust memory/worker startup.
    maxWorkers: 4,
    testTimeout: 15_000,
    include: ['src/**/*.{test,spec}.ts', 'src/**/*.property.test.ts'],
    // One file at a time only when a real DB is shared across suites.
    fileParallelism: !hasDatabase,
    // graphql 17 ships separate development and production builds selected by
    // export conditions. Our sources resolve `graphql` through Vite (development
    // build) while an externalised graphql-yoga would load the production build
    // through Node: two realms, and every request fails with "Cannot use
    // GraphQLSchema from another module or realm". Inline Yoga and the
    // envelop / graphql-tools packages it validates and executes with, so they
    // resolve the same copy. The production bundle has a single copy already.
    server: { deps: { inline: [/graphql-yoga/, /@graphql-yoga\//, /@envelop\//, /@graphql-tools\//] } },
  },
});
