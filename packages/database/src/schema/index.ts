// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Drizzle schema barrel. `drizzle.config.ts` points at this file's
 * sibling `../schema.ts`, which simply re-exports everything here. Keep
 * domain tables grouped by file so each stays under ~300 LOC.
 */
export * from './core';
export * from './access';
export * from './consent';
export * from './compliance';
export * from './cms';
export * from './platform';
export * from './ai';
export * from './security';
export * from './cdc';
export * from './content-os';
export * from './regulated';
export * from './deployments';
export * from './domains';
export * from './storage';
export * from './llm';
export * from './site-network';
export * from './public-projection';
export * from './themes';
export * from './preview-links';
export * from './external-auth';
export * from './pageviews';
export * from './git-integration';
export * from './runtime-infra';
export * from './search';
export * from './vectors';
export * from './ingest';
export * from './ingest-providers';
export * from './ingest-lifecycle';
export * from './ai-pipeline';
export * from './notification-channels';
export * from './agent-access';
export * from './batch-plans';
export * from './branch-previews';
export * from './git-snapshots';
export * from './astro-builds';
