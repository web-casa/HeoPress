/**
 * Settings of services HeoPress no longer uses (P03, ADR-0002). Cache,
 * queue, scheduled jobs and rate limits run on PostgreSQL and images are
 * transformed in process, so these variables do nothing. A deployment that
 * still sets them almost certainly expects them to — refuse to start and say
 * why, instead of running with a silently different setup (task 7.2).
 */
const REMOVED: Record<string, string> = {
  REDIS_URL: 'Redis is no longer used: cache, queue, scheduled jobs and rate limits run on PostgreSQL',
  REDIS_HOST: 'Redis is no longer used: cache, queue, scheduled jobs and rate limits run on PostgreSQL',
  IMGPROXY_URL: 'imgproxy is no longer used: images are transformed in process (sharp)',
  IMGPROXY_KEY: 'imgproxy is no longer used: transform URLs are signed by HeoPress itself',
  IMGPROXY_SALT: 'imgproxy is no longer used: transform URLs are signed by HeoPress itself',
};

export class RemovedServiceConfigError extends Error {
  constructor(readonly variables: string[], message: string) {
    super(message);
    this.name = 'RemovedServiceConfigError';
  }
}

/** Throw if any removed service is still configured. */
export function assertNoRemovedServices(env: Record<string, string | undefined> = process.env): void {
  const set = Object.keys(REMOVED).filter((k) => (env[k] ?? '').trim() !== '');
  if (set.length === 0) return;
  const lines = set.map((k) => `  ${k}: ${REMOVED[k]}`);
  throw new RemovedServiceConfigError(
    set,
    `Configuration names services HeoPress no longer uses; remove these variables and restart:\n${lines.join('\n')}\n` +
      'See docs/en/deployment/docker.md (minimal deployment).',
  );
}
