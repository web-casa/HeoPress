import { describe, expect, it } from 'vitest';
import { idConflictOf, validateNewSite } from '../site-provisioning';

/** Site provisioning without a database (HeoPress P07 task 0.1): input checks and how id conflicts are told apart. */
describe('site provisioning', () => {
  it('a unique violation is a held id when the hold refused it, otherwise an existing site', () => {
    const held = { code: '23505', message: 'site id "x" belonged to a site deleted less than 25 hours ago' };
    const exists = { code: '23505', message: 'duplicate key value violates unique constraint "lumibase_sites_pkey"', constraint_name: 'lumibase_sites_pkey' };
    const elsewhere = { code: '23505', message: 'duplicate key value violates unique constraint "roles_site_system_key_unique"', constraint_name: 'roles_site_system_key_unique' };
    expect(idConflictOf(held)).toBe('held');
    expect(idConflictOf(exists)).toBe('exists');
    // As the query builder wraps them.
    expect(idConflictOf({ message: 'Failed query: insert …', cause: held })).toBe('held');
    expect(idConflictOf({ message: 'Failed query: insert …', cause: exists })).toBe('exists');
    expect(idConflictOf(elsewhere)).toBeNull();
    expect(idConflictOf({ message: 'Failed query: insert …', cause: elsewhere })).toBeNull();
    expect(idConflictOf({ code: '23503', message: 'foreign key' })).toBeNull();
    expect(idConflictOf(new Error('anything'))).toBeNull();
    expect(idConflictOf(undefined)).toBeNull();
  });

  it('validates the new site before anything is written', () => {
    expect(validateNewSite({ id: 'site_a', name: ' A ', defaultLanguage: 'zh-CN' })).toEqual({ id: 'site_a', name: 'A', defaultLanguage: 'zh-CN' });
    for (const bad of [{ id: 'Bad Id', name: 'x' }, { id: 'ok', name: '' }, { id: 'ok', name: 'x', defaultLanguage: 'not a tag' }, { id: 'ok', name: 'x', defaultLanguage: 3 }, null]) {
      expect(() => validateNewSite(bad), JSON.stringify(bad)).toThrow();
    }
  });
});
