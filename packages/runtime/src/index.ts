// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// @heopress/runtime — Runtime abstraction layer
//
// Adapter-free exports only. The Docker adapters live behind the
// `@heopress/runtime/docker` subpath and `createRuntime` behind
// `@heopress/runtime/node`, so code that only needs the interfaces and helpers
// does not load pg-boss, the S3 client or MeiliSearch. (The Cloudflare
// Workers runtime that originally motivated this split was removed in P02.)
export * from './interfaces';
export {
  EnvKeyProvider,
  collectKeys,
  resolveActiveKeyId,
} from './adapters/shared-keys';
export { MemoryCacheProvider } from './memory-cache';
export { MemoryRateLimiter } from './memory-rate-limiter';
export { CacheBackedRateLimiter } from './adapters/cache-rate-limiter';
export { createNegativeCache, createSwrCache, withProcessCache } from './cache-helpers';
export type {
  NegativeCache,
  NegativeCacheOptions,
  ProcessCacheEntry,
  ProcessCacheOptions,
  ProcessCacheStore,
  SwrCache,
  SwrCacheEntry,
  SwrCacheOptions,
} from './cache-helpers';
export { classifyCacheValue, negativeCacheWireValue } from './cache-entry';
export {
  EDGE_URL_INDEX_LIMIT,
  edgeUrlIndexKey,
  purgeEdgeByTag,
  recordEdgeUrl,
} from './edge-url-index';
// `./leader-lock` (scheduled jobs on PostgreSQL) is exported from
// `@heopress/runtime/node`.
