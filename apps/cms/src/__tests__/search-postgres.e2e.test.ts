import { describe } from 'vitest';
import { searchApiScenario } from './helpers/search-scenario';

/** Search API on the default backend, PostgreSQL full-text search (P03 tasks 5.1–5.2). */
const url = process.env.DATABASE_URL?.trim();
const env: Record<string, unknown> = { ...process.env, MEILISEARCH_HOST: '' };

describe.skipIf(!url)('search API — PostgreSQL backend', () => {
  searchApiScenario(env, 'postgres');
});
