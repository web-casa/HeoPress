// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { RuntimeContext, StorageProvider } from '../../interfaces';
import { NoOpEdgeCacheProvider } from './edge-cache';
import { S3StorageProvider } from './storage';
import { LocalFileStorageProvider } from '../local/storage';
import { PostgresDatabaseProvider } from './database';
import { MeiliSearchProvider } from './search';
import { PgBossQueueProvider } from '../postgres/queue';
import { SharpMediaProcessor } from '../node/media';
import { createDockerKeyProvider } from './keys';
import { DockerRealtimeProvider, getSharedRealtimeHub } from './realtime';
import { PostgresCacheProvider } from '../postgres/cache';
import { PostgresRateLimiter } from '../postgres/rate-limiter';
import { PostgresSearchProvider } from '../postgres/search';

export {
  DockerRealtimeProvider,
  InProcessRealtimeHub,
  getSharedRealtimeHub,
} from './realtime';
export { NoOpEdgeCacheProvider } from './edge-cache';
export { S3StorageProvider } from './storage';
export { LocalFileStorageProvider } from '../local/storage';
export { PostgresDatabaseProvider } from './database';
export { MeiliSearchProvider } from './search';
export { SharpMediaProcessor } from '../node/media';
export { createDockerKeyProvider } from './keys';
export { PgBossQueueProvider } from '../postgres/queue';
export { PostgresCacheProvider } from '../postgres/cache';
export { PostgresRateLimiter } from '../postgres/rate-limiter';

/**
 * Creates a RuntimeContext configured for Docker/Node.js environments.
 *
 * PostgreSQL is the only required service (HeoPress P03, ADR-0002): the
 * database, cache, rate limits and job queue all run on `DATABASE_URL`.
 */
export function createDockerRuntime(env: Record<string, unknown>): RuntimeContext {
  const databaseUrl = (env.DATABASE_URL as string) || '';
  // MeiliSearch only when configured; PostgreSQL full-text search otherwise (P03 task 5.2).
  const meiliHost = typeof env.MEILISEARCH_HOST === 'string' ? env.MEILISEARCH_HOST.trim() : '';
  const meiliKey = (env.MEILISEARCH_API_KEY as string) || undefined;

  // Cache and rate limits live in PostgreSQL (P03, ADR-0002). `HEOPRESS_CACHE_L1_TTL_MS=0`
  // disables the in-process L1 layer.
  const database = new PostgresDatabaseProvider(databaseUrl);
  const l1TtlRaw = env.HEOPRESS_CACHE_L1_TTL_MS as string | undefined;
  const l1TtlMs = l1TtlRaw !== undefined && l1TtlRaw !== '' && Number.isFinite(Number(l1TtlRaw)) ? Number(l1TtlRaw) : undefined;

  return {
    cache: new PostgresCacheProvider(database.getConnection(), { l1TtlMs }),
    rateLimiter: new PostgresRateLimiter(database.getConnection()),
    edgeCache: new NoOpEdgeCacheProvider(),
    storage: createStorage(env),
    database,
    search: meiliHost
      ? new MeiliSearchProvider(meiliHost, meiliKey)
      : new PostgresSearchProvider(database.getConnection()),
    queue: new PgBossQueueProvider(databaseUrl),
    media: new SharpMediaProcessor({
      maxDimension: Number(env.HEOPRESS_IMAGE_MAX_DIMENSION) > 0 ? Number(env.HEOPRESS_IMAGE_MAX_DIMENSION) : undefined,
    }),
    keys: createDockerKeyProvider(env),
    realtime: new DockerRealtimeProvider(getSharedRealtimeHub()),
    runtime: 'docker',
  };
}

/**
 * Storage backend from configuration (P03 tasks 4.1–4.2):
 *   HEOPRESS_STORAGE=local (default when no S3 bucket is configured) → files
 *     under HEOPRESS_STORAGE_DIR (default ./data/storage);
 *   HEOPRESS_STORAGE=s3 (default when S3_BUCKET or S3_ENDPOINT is set) → any
 *     S3-compatible service: S3_ENDPOINT, S3_REGION, S3_FORCE_PATH_STYLE,
 *     S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY.
 */
function createStorage(env: Record<string, unknown>): StorageProvider {
  const str = (k: string) => (typeof env[k] === 'string' ? (env[k] as string).trim() : '');
  const mode = str('HEOPRESS_STORAGE') || (str('S3_BUCKET') || str('S3_ENDPOINT') ? 's3' : 'local');
  if (mode === 'local') return new LocalFileStorageProvider(str('HEOPRESS_STORAGE_DIR') || './data/storage');
  if (mode !== 's3') throw new Error(`HEOPRESS_STORAGE="${mode}" is not supported; use "local" or "s3".`);
  const pathStyle = str('S3_FORCE_PATH_STYLE').toLowerCase();
  return new S3StorageProvider({
    endpoint: str('S3_ENDPOINT') || undefined,
    region: str('S3_REGION') || undefined,
    forcePathStyle: pathStyle === '' ? undefined : pathStyle === 'true' || pathStyle === '1',
    bucket: str('S3_BUCKET') || 'heopress-media',
    accessKeyId: str('S3_ACCESS_KEY'),
    secretAccessKey: str('S3_SECRET_KEY'),
  });
}
