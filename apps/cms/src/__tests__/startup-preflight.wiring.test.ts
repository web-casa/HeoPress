import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Node entrypoint runs the startup preflight first (P01 runtime baseline).
 *
 * `config/__tests__/preflight.test.ts` proves the checks themselves. This file
 * proves `serve.ts` calls them before any other startup work, and that a
 * failure ends the process with a non-zero exit code.
 *
 * Evidence class: source scan of the real file. No process is started.
 */

const serve = readFileSync(join(__dirname, '..', 'serve.ts'), 'utf8');

describe('serve.ts runs the startup preflight', () => {
  it('imports the preflight', () => {
    expect(serve).toMatch(/import \{[^}]*\brunStartupPreflight\b[^}]*\} from '\.\/config\/preflight';/);
    expect(serve).toMatch(/import \{[^}]*\bassertSupportedPostgres\b[^}]*\} from '\.\/config\/preflight';/);
  });

  it('runs it as the first statement of main(), before secrets and production validation', () => {
    const body = serve.slice(serve.indexOf('async function main() {'));
    const preflight = body.indexOf('runStartupPreflight();');
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(body.indexOf('loadSecretFiles();'));
    expect(preflight).toBeLessThan(body.indexOf('validateProductionConfig();'));
  });

  it('exits non-zero when startup fails', () => {
    expect(serve).toMatch(/main\(\)\.catch\(\(err\) => \{[\s\S]*?process\.exit\(1\);/);
  });

  it('checks the PostgreSQL version after creating the runtime and before serving or scheduling work', () => {
    const body = serve.slice(serve.indexOf('async function main() {'));
    const check = body.indexOf('await assertSupportedPostgres(');
    expect(check).toBeGreaterThan(body.indexOf('createRuntime('));
    expect(check).toBeLessThan(body.indexOf('serve({'));
    expect(check).toBeLessThan(body.indexOf('cron.schedule('));
  });
});
