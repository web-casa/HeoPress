import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P02 task 8.3: `drizzle-kit generate` is usable again, and CI fails when the
 * schema changes without a generated migration (scripts/check-migration-drift.mjs).
 */

const pkg = path.resolve(__dirname, '../..');
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/check-migration-drift.mjs', ...args], { cwd: pkg, encoding: 'utf8' });

describe('migration drift check', () => {
  it('passes when the migrations match the schema', () => {
    const res = run();
    expect(res.status, res.stderr).toBe(0);
  }, 60_000);

  it('fails and names the migration generate would add when the schema drifts', () => {
    const res = run('--schema', './src/__tests__/fixtures/drift-schema.ts');
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/drizzle\/\d{4}_drift_probe\.sql/);
  }, 60_000);
});
