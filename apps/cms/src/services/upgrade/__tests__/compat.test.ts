import { describe, expect, it } from 'vitest';
import { checkCompatibility, type CompatibilityFacts } from '../compat';

const bundled = [
  { tag: '0000_a', hash: 'h0', when: 1000 },
  { tag: '0001_b', hash: 'h1', when: 2000 },
  { tag: '0002_c', hash: 'h2', when: 3000 },
];

function facts(over: Partial<CompatibilityFacts> = {}): CompatibilityFacts {
  return {
    currentVersion: '1.0.0-rc.4',
    targetVersion: '1.0.0',
    postgresVersionNum: 180004,
    applied: [
      { hash: 'h0', createdAt: 1000 },
      { hash: 'h1', createdAt: 2000 },
    ],
    bundled,
    plugins: [],
    backupProvider: true,
    ...over,
  };
}

describe('upgrade compatibility check', () => {
  it('accepts a forward upgrade and lists the pending migrations', () => {
    const r = checkCompatibility(facts());
    expect(r).toMatchObject({ ok: true, upToDate: false, problems: [], pending: ['0002_c'] });
  });

  it('is up to date on the same version with nothing pending', () => {
    const r = checkCompatibility(facts({ currentVersion: '1.0.0', applied: bundled.map((b) => ({ hash: b.hash, createdAt: b.when })) }));
    expect(r).toMatchObject({ ok: true, upToDate: true, pending: [] });
  });

  it('refuses a downgrade and a skipped major release', () => {
    expect(checkCompatibility(facts({ currentVersion: '1.2.0', targetVersion: '1.1.0' })).problems.join()).toMatch(/downgrades are not supported/);
    expect(checkCompatibility(facts({ currentVersion: '1.2.0', targetVersion: '3.0.0' })).problems.join()).toMatch(/skips a major release/);
    expect(checkCompatibility(facts({ currentVersion: 'unknown' })).ok).toBe(false);
  });

  it('refuses PostgreSQL older than 18', () => {
    expect(checkCompatibility(facts({ postgresVersionNum: 170005 })).problems.join()).toMatch(/PostgreSQL 17 is not supported/);
  });

  it('refuses a database migrated with another history or by a newer release', () => {
    const other = checkCompatibility(facts({ applied: [{ hash: 'h0', createdAt: 1000 }, { hash: 'other', createdAt: 2000 }] }));
    expect(other.problems.join()).toMatch(/history differs .* #2 \(0001_b\)/);
    const ahead = checkCompatibility(facts({ applied: [...bundled.map((b) => ({ hash: b.hash, createdAt: b.when })), { hash: 'h3', createdAt: 4000 }] }));
    expect(ahead.problems.join()).toMatch(/migrated by a newer release/);
  });

  it('refuses while an installed plugin excludes the target release', () => {
    const r = checkCompatibility(
      facts({
        plugins: [
          { siteId: 's1', name: 'old-plugin', enabled: true, manifest: { compatibleWith: '^0.26.0' } },
          { siteId: null, name: 'fine', enabled: true, manifest: { heopress: '^1.0.0-0' } },
          { siteId: 's1', name: 'no-range', enabled: false, manifest: {} },
        ],
      }),
    );
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/plugin old-plugin \(site s1\) declares HeoPress \^0\.26\.0/);
  });

  it('refuses without a backup provider', () => {
    expect(checkCompatibility(facts({ backupProvider: false })).problems.join()).toMatch(/no backup provider/);
  });
});
