import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, type Database } from '@heopress/database';
import type { StorageProvider } from '@heopress/runtime';
import { replayDeletionLedger, type DeletionLedgerReplayReport, type DeletionLedgerSink } from '../retention/deletion-ledger';

/**
 * After a restore, before writes open (HeoPress P13 tasks 1.5, 5.2; spec ops/data-retention "删除账本与恢复后重放"):
 * the deletion ledger is replayed on the restored database, so personal data deleted after the backup was taken does
 * not come back. `storage` is where the restored media are (snapshots a ledger record names are tombstoned there
 * again); `sink` is the external ledger (`deletionLedgerSinkFromEnv`), which a restore does not roll back.
 *
 * Writes may open only when no record failed: a failed record is an object that may still hold erased data.
 */
export interface RestoreLedgerReplay {
  report: DeletionLedgerReplayReport;
  writesMayOpen: boolean;
}

export async function replayLedgerAfterRestore(deps: { databaseUrl: string; storage: StorageProvider; sink: DeletionLedgerSink | null }): Promise<RestoreLedgerReplay> {
  const client = postgres(deps.databaseUrl, { max: 2, prepare: false, onnotice: () => {} });
  try {
    const db = drizzle(client, { schema }) as unknown as Database;
    const report = await replayDeletionLedger({ db, storage: deps.storage, sink: deps.sink });
    return { report, writesMayOpen: report.failed === 0 };
  } finally {
    await client.end({ timeout: 2 });
  }
}
