// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
export * from './schema';
export { schema } from './client';
export { createDb, type Database } from './client';
export * from './backfill/role-policies';
export {
  getMigrationReadiness,
  LATEST_MIGRATION,
  type MigrationReadiness,
  type MigrationStatusQuery,
} from './migration-status';
export {
  applyUnloggedTables,
  capabilityRequirementsFromEnv,
  ensureDatabaseExtensions,
  evaluateCapabilities,
  getDatabaseCapabilities,
  ZH_TEXT_SEARCH_CONFIG,
  type CapabilityReport,
  type CapabilityRequirements,
  type DatabaseCapabilities,
} from './capabilities';
export { assertRlsApplies, ensureAppRole, probeRls, rlsBypassReason } from './app-role';
export { ensureRenderRole, RENDER_READABLE, RENDER_WRITABLE } from './render-role';
