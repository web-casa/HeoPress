/**
 * The upgrade's maintenance control survives its session being terminated (HeoPress P13 tasks 2.1, 2.3): backups and
 * restores terminate every session of the database, and the first statement after that fails with 57P01 or a closed
 * connection. The database version is `upgrade.db.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { isConnectionLost, MaintenanceControl, type ControlSql } from '../maintenance-control';

function flakySql(failures: unknown[]) {
  const statements: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    statements.push(strings.join('?').replace(/\s+/g, ' ').trim().slice(0, 40));
    const next = failures.shift();
    if (next) throw next;
    return [{ epoch: 7, active: true, upgrade_id: 'u1' }];
  }) as unknown as ControlSql;
  return { sql, statements };
}

const lost = (code: string) => Object.assign(new Error(code), { code });
const noSleep = async () => {};

describe('maintenance control on a terminated session', () => {
  it('runs a statement again when its session was terminated', async () => {
    const f = flakySql([lost('57P01'), lost('CONNECTION_CLOSED')]);
    const control = new MaintenanceControl({ sql: f.sql, sleep: noSleep });
    await control.step('migrate');
    expect(f.statements).toHaveLength(3);
    expect(await control.enter({ upgradeId: 'u1', fromVersion: '1.0.0', toVersion: '1.1.0' })).toBe(7);
    await control.exit('u1');
    expect(await control.state()).toEqual({ active: true, upgradeId: 'u1' });
  });

  it('gives up after three attempts, and never repeats a statement that failed for another reason', async () => {
    const f = flakySql([lost('57P01'), lost('57P01'), lost('57P01')]);
    await expect(new MaintenanceControl({ sql: f.sql, sleep: noSleep }).step('migrate')).rejects.toThrow('57P01');
    expect(f.statements).toHaveLength(3);
    const g = flakySql([Object.assign(new Error('permission denied'), { code: '42501' })]);
    await expect(new MaintenanceControl({ sql: g.sql, sleep: noSleep }).exit('u1')).rejects.toThrow('permission denied');
    expect(g.statements).toHaveLength(1);
  });

  it('recognises the server and client codes of a lost session only', () => {
    for (const code of ['57P01', '57P02', '57P03', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'ECONNRESET', 'EPIPE']) {
      expect(isConnectionLost(lost(code))).toBe(true);
    }
    for (const err of [lost('23505'), new Error('x'), null, 'CONNECTION_CLOSED']) expect(isConnectionLost(err)).toBe(false);
  });
});
