/**
 * The rehearsal database (HeoPress P13 task 2.1): an empty database on the production server, created by the owner for
 * one upgrade (`heopress_upgrade_<id>`) and dropped afterwards. The backup provider restores the pre-upgrade backup
 * into it, then the target release's migrations run there first.
 */
import { upgradeConnection } from '../migrations';
import type { RehearsalDatabasePort } from '../ports';

export class ScratchDatabase implements RehearsalDatabasePort {
  /** @param ownerUrl owner connection to production (needs CREATEDB, as for the database test suites) */
  constructor(private readonly ownerUrl: string) {}

  async create(upgradeId: string): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
    const name = `heopress_upgrade_${upgradeId.replace(/[^a-zA-Z0-9]/g, '').slice(-24).toLowerCase()}`;
    const admin = upgradeConnection(this.ownerUrl);
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const url = new URL(this.ownerUrl);
    url.pathname = `/${name}`;
    return {
      databaseUrl: url.toString(),
      drop: async () => {
        const sql = upgradeConnection(this.ownerUrl);
        try {
          await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        } finally {
          await sql.end({ timeout: 5 });
        }
      },
    };
  }
}
