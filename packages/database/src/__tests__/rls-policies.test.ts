import { describe, expect, it } from 'vitest';

import { policiesFor, rlsPolicySql, rlsPolicyStatements } from '../rls/policies';
import { RLS_REGISTRY, type RlsEntry } from '../rls/registry';

/** The policy SQL generated from the registry (HeoPress P14, ADR-0023): what the policy migration installs. */
describe('RLS policy SQL from the registry', () => {
  it('a site table: enabled without FORCE, one site policy, earlier policies dropped first', () => {
    const sql = rlsPolicyStatements([{ table: 'lumibase_items', policy: 'site' }]);
    expect(sql[0]).toMatch(/DROP POLICY/);
    expect(sql[1]).toBe('ALTER TABLE public.lumibase_items ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;');
    expect(sql[2]).toBe(
      'CREATE POLICY site_isolation ON public.lumibase_items FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());',
    );
    expect(sql).toHaveLength(3);
  });

  it('an exception: row-level security disabled, no policy', () => {
    const sql = rlsPolicyStatements([{ table: 'lumibase_public_hosts', policy: 'exempt', reason: { category: 'pre-site-lookup', note: 'hosts' } }]);
    expect(sql.slice(1)).toEqual(['ALTER TABLE public.lumibase_public_hosts DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;']);
  });

  it('extensions: global rows read by every site, written only in the platform scope', () => {
    const specs = policiesFor({ table: 'lumibase_extensions', policy: 'site-or-global-read' });
    expect(specs.map((p) => [p.name, p.command])).toEqual([
      ['extensions_read', 'SELECT'],
      ['extensions_write', 'ALL'],
      ['extensions_platform', 'ALL'],
    ]);
    expect(specs[2]!.check).toContain('app_platform_scope()');
  });

  it('never FORCE, and every isolated registry entry gets at least one policy', () => {
    const sql = rlsPolicySql();
    expect(sql).not.toMatch(/(?<!NO )FORCE ROW LEVEL SECURITY/);
    for (const e of RLS_REGISTRY) if (e.policy !== 'exempt') expect(policiesFor(e).length, e.table).toBeGreaterThan(0);
    expect(rlsPolicySql(RLS_REGISTRY, { breakpoints: true })).toContain('--> statement-breakpoint');
  });

  it('refuses a table name that is not a plain identifier', () => {
    const bad: RlsEntry = { table: 'x; DROP TABLE y', policy: 'site' };
    expect(() => rlsPolicyStatements([bad])).toThrow(/invalid table name/);
  });
});
