// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { readFileSync } from 'node:fs';
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

/**
 * Coverage thresholds (HeoPress P13 task 6.3, ADR-0017 §2), applied with `--coverage` (`pnpm quality:pr`, group
 * `db`: the whole suite against a database). `coverage-thresholds.json` lists the critical modules — permissions,
 * site scope, approvals, budgets, state machines — by file, each with its baseline, and the baseline of all files
 * under `coverage.include` (`other`, Vitest's global thresholds). A module's threshold applies to its files
 * together. Baselines only go up (`node scripts/coverage-baseline.mjs`).
 */
type Baseline = { lines: number; branches: number; functions: number; statements: number };
const coverageConfig = JSON.parse(readFileSync(new URL('./coverage-thresholds.json', import.meta.url), 'utf8')) as {
  modules: Record<string, { files: string[]; baseline: Baseline }>;
  other: { baseline: Baseline };
};
const moduleThresholds = Object.fromEntries(
  Object.values(coverageConfig.modules).map(({ files, baseline }) => [
    files.length === 1 ? files[0] : `{${files.join(',')}}`,
    baseline,
  ]),
);

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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/__mocks__/**', 'src/test-utils/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { ...coverageConfig.other.baseline, ...moduleThresholds },
    },
  },
});
