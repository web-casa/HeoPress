/**
 * v1 scale benchmark (HeoPress P13 task 3.2; docs/benchmarks/v1-scale.md): 100 sites × 1,000 articles on one
 * installation (docker/install.sh), public pages read through its Caddy over HTTPS — the production path.
 *
 *   k6 run --env HTTPS_PORT=<port> --env HOSTS_FILE=hosts.txt --env HOT_FILE=hot.txt --env COLD_FILE=cold.txt \
 *     --env WARMUP=10m --env DURATION=30m apps/cms/k6/v1-scale.js
 *
 * 50 concurrent readers (the spec's load), without pauses between requests:
 *   - warm-up (WARMUP): 50 readers on random pages of the hot set (every page rendered once, then cached);
 *   - measured (DURATION): 45 readers on random pages of the hot set (cache hits: `x-cache: hit` from the
 *     rendering service's process cache, `hit-shared` from the shared cache in PostgreSQL) and 5 readers taking
 *     pages of the cold set, never requested before, one after another (cache misses: rendered on request), each
 *     paced to COLD_PACE seconds per page.
 * Background load during the measured phase (not counted among the 50 readers): a writer publishing new articles on
 * random sites (WRITE_RATE per second; each publish raises the site's render version, so every cached page of that
 * site is rendered again on its next request; projection and search indexing in the worker) and a Studio-like
 * reader listing articles through the admin API (ADMIN_RATE per second). A rate of 0 leaves that load out.
 *
 * Latency is recorded per cache level from each answer's `x-cache` header (measured phase only): `lat_hit` (process),
 * `lat_hit_shared`, `lat_cache_hit` (both), `lat_miss`; `admin_list`, `write_publish`. Every page answer must be 200.
 * Files: HOSTS_FILE one host per line; HOT_FILE / COLD_FILE one "host path" per line.
 * BENCH_ADMIN_EMAIL / BENCH_ADMIN_PASSWORD (environment, never printed) sign the writer and the admin reader in.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const PORT = __ENV.HTTPS_PORT;
const ADMIN = __ENV.ADMIN_DOMAIN || 'admin.example.test';
const WARMUP = __ENV.WARMUP || '10m';
const DURATION = __ENV.DURATION || '30m';
const COLD_PACE = Number(__ENV.COLD_PACE || 0.5);
const WRITE_RATE = Number(__ENV.WRITE_RATE || 0.5);
const ADMIN_RATE = Number(__ENV.ADMIN_RATE || 2);
const load = (name, file) =>
  new SharedArray(name, () =>
    open(file)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ')),
  );
const hot = load('hot', __ENV.HOT_FILE);
const cold = load('cold', __ENV.COLD_FILE);
const siteHosts = open(__ENV.HOSTS_FILE).split('\n').filter(Boolean);
const hosts = { [`${ADMIN}:443`]: `127.0.0.1:${PORT}` };
for (const h of siteHosts) hosts[`${h}:443`] = `127.0.0.1:${PORT}`;

const latHit = new Trend('lat_hit', true);
const latHitShared = new Trend('lat_hit_shared', true);
const latCacheHit = new Trend('lat_cache_hit', true);
const latMiss = new Trend('lat_miss', true);
const adminListLat = new Trend('admin_list', true);
const writePublish = new Trend('write_publish', true);
const answers = {
  hit: new Counter('answers_hit'),
  'hit-shared': new Counter('answers_hit_shared'),
  miss: new Counter('answers_miss'),
  other: new Counter('answers_other_cache_state'),
};
const notOk = new Counter('answers_not_200');

const reader = (vus, start, duration, exec) => ({ executor: 'constant-vus', vus, startTime: start, duration, exec });
export const options = {
  hosts,
  insecureSkipTLSVerify: true,
  maxRedirects: 0,
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  scenarios: {
    warm: reader(50, '0s', WARMUP, 'hotPage'),
    measure_hot: reader(45, WARMUP, DURATION, 'hotPage'),
    measure_cold: reader(5, WARMUP, DURATION, 'coldPage'),
    // A rate of 0 leaves the background scenario out.
    ...(WRITE_RATE > 0 && {
      background_write: {
        executor: 'constant-arrival-rate', rate: Math.round(WRITE_RATE * 100), timeUnit: '100s', startTime: WARMUP, duration: DURATION,
        preAllocatedVUs: 2, maxVUs: 10, exec: 'publish',
      },
    }),
    ...(ADMIN_RATE > 0 && {
      background_admin: {
        executor: 'constant-arrival-rate', rate: Math.round(ADMIN_RATE * 100), timeUnit: '100s', startTime: WARMUP, duration: DURATION,
        preAllocatedVUs: 2, maxVUs: 20, exec: 'adminList',
      },
    }),
  },
  thresholds: {
    // A run with page answers other than 200 is not a measurement. The latency targets are judged in the report.
    answers_not_200: ['count==0'],
  },
};

const measuring = () => exec.scenario.name.startsWith('measure');

function page(host, path) {
  // One `name` for every page: per-URL tags would create a time series per page (100,000) in k6.
  const res = http.get(`https://${host}${path}`, { tags: { kind: 'page', name: 'page' } });
  const ok = check(res, { 'status 200': (r) => r.status === 200 });
  if (!ok) notOk.add(1);
  if (!measuring()) return;
  const state = res.headers['X-Cache'];
  const ms = res.timings.duration;
  (answers[state] ?? answers.other).add(1);
  if (state === 'hit') latHit.add(ms);
  if (state === 'hit-shared') latHitShared.add(ms);
  if (state === 'hit' || state === 'hit-shared') latCacheHit.add(ms);
  if (state === 'miss') latMiss.add(ms);
}

export function hotPage() {
  const [host, path] = hot[Math.floor(Math.random() * hot.length)];
  page(host, path);
}

export function coldPage() {
  const i = exec.scenario.iterationInTest;
  if (i >= cold.length) {
    sleep(COLD_PACE);
    return;
  }
  const started = Date.now();
  page(...cold[i]);
  const left = COLD_PACE - (Date.now() - started) / 1000;
  if (left > 0) sleep(left);
}

// Site-bound tokens of the administrator, per VU.
const tokens = {};
function token(site) {
  if (tokens[site]) return tokens[site];
  const res = http.post(
    `https://${ADMIN}/api/v1/auth/login`,
    JSON.stringify({ email: __ENV.BENCH_ADMIN_EMAIL, password: __ENV.BENCH_ADMIN_PASSWORD }),
    { headers: { 'content-type': 'application/json', 'x-heopress-site': site }, responseType: 'text', tags: { kind: 'login', name: 'login' } },
  );
  tokens[site] = res.status === 200 ? res.json('data.token') : null;
  return tokens[site];
}
function api(method, site, path, body, trend) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = http.request(method, `https://${ADMIN}${path}`, body ? JSON.stringify(body) : null, {
      headers: { 'content-type': 'application/json', 'x-heopress-site': site, authorization: `Bearer ${token(site)}` },
      tags: { kind: 'admin', name: `${method} ${path.split('?')[0]}` },
    });
    if (res.status === 401) {
      delete tokens[site];
      continue;
    }
    check(res, { 'admin api 2xx': (r) => r.status >= 200 && r.status < 300 });
    trend.add(res.timings.duration);
    return;
  }
}
const randomSite = () => `bench-${String(1 + Math.floor(Math.random() * siteHosts.length)).padStart(3, '0')}`;

export function publish() {
  const site = randomSite();
  const n = `bg-${exec.scenario.iterationInTest}-${Date.now()}`;
  api('POST', site, '/api/v1/items/articles', {
    data: { title: `Background ${n}`, slug: n, locale: 'en', excerpt: 'Published during the benchmark.', body: '<p>Background article.</p>' },
    status: 'published',
  }, writePublish);
}

export function adminList() {
  const site = randomSite();
  const offset = 20 * Math.floor(Math.random() * 50);
  api('GET', site, `/api/v1/items/articles?limit=20&offset=${offset}`, null, adminListLat);
}
