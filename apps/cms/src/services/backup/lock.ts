import postgres from 'postgres';

/**
 * One backup operation at a time (HeoPress P13 task 1.5): a backup, a prune and a drill's media checks never overlap,
 * so a prune can never remove content a running backup has just written but not yet listed in a manifest. A session
 * advisory lock on a dedicated connection of the backup role: released when the work ends, or when the process dies.
 */

export class BackupBusyError extends Error {
  constructor() {
    super('Another backup operation is running; try again later.');
    this.name = 'BackupBusyError';
  }
}

const LOCK_KEY = 'heopress-backup';

export async function withBackupLock<T>(databaseUrl: string, fn: () => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 15 });
  try {
    const [row] = await sql<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended(${LOCK_KEY}, 0)) AS ok`;
    if (!row?.ok) throw new BackupBusyError();
    try {
      return await fn();
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtextextended(${LOCK_KEY}, 0))`.catch(() => undefined);
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}
