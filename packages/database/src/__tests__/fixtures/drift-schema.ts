/** The real schema plus one table no migration creates (migration-drift.test.ts). */
import { pgTable, text } from 'drizzle-orm/pg-core';

export * from '../../schema';
export const driftProbe = pgTable('lumibase_drift_probe', { id: text('id').primaryKey() });
