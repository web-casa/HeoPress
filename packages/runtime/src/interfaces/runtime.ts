// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { CacheProvider } from './cache';
import type { EdgeCacheProvider } from './edge-cache';
import type { StorageProvider } from './storage';
import type { DatabaseProvider } from './database';
import type { SearchProvider } from './search';
import type { QueueProvider } from './queue';
import type { MediaProcessor } from './media';
import type { KeyProvider } from './keys';
import type { RealtimeProvider } from './realtime';
import type { RateLimiterProvider } from './rate-limiter';

export interface RuntimeContext {
  cache: CacheProvider;
  /** Distributed fixed-window rate limiter (PostgreSQL table; memory in tests). */
  rateLimiter: RateLimiterProvider;
  edgeCache: EdgeCacheProvider;
  storage: StorageProvider;
  database: DatabaseProvider;
  search: SearchProvider;
  queue: QueueProvider;
  media: MediaProcessor;
  keys: KeyProvider;
  realtime: RealtimeProvider;
  /** Always `docker` (Node.js); the Cloudflare Workers runtime was removed in P02. */
  runtime: 'docker';
}
