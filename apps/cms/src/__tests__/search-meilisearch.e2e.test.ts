import { describe } from 'vitest';
import { searchApiScenario } from './helpers/search-scenario';

/**
 * Search API on the optional MeiliSearch backend (P03 task 5.2). Runs when
 * HEOPRESS_TEST_MEILI_HOST is set (CI starts MeiliSearch); the host is
 * trusted as an internal endpoint, as compose does.
 */
const url = process.env.DATABASE_URL?.trim();
const meili = process.env.HEOPRESS_TEST_MEILI_HOST?.trim();
// The outbound boundary reads its trusted list from the process environment.
if (meili) process.env.HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS = new URL(meili).origin;
const env: Record<string, unknown> = {
  ...process.env,
  MEILISEARCH_HOST: meili,
  MEILISEARCH_API_KEY: process.env.HEOPRESS_TEST_MEILI_KEY ?? 'heopress_test_key',
  HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS: meili ? new URL(meili).origin : '',
};

describe.skipIf(!url || !meili)('search API — MeiliSearch backend', () => {
  searchApiScenario(env, 'meilisearch');
});
