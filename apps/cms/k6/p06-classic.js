/**
 * P06 baseline (docs/benchmarks/p06-classic.md): the public sites served by `site-classic`.
 *
 *   PHASE=miss  every page once (shared iterations): nothing cached yet, each answer is rendered
 *   PHASE=l2    every page once again after a restart of the service: process cache empty, shared cache full
 *   PHASE=hit   random pages for DURATION: process cache hits — VUS closed-loop clients (as fast as answered:
 *               the throughput ceiling), or with RATE a fixed arrival rate per second (latency below the ceiling)
 *
 *   k6 run --env BASE_URL=http://127.0.0.1:2027 --env PAGES_FILE=pages.txt --env PHASE=miss apps/cms/k6/p06-classic.js
 *
 * PAGES_FILE: one "host path" per line. Each answer must be 200 and carry the expected `x-cache` state.
 */
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:2027';
const PHASE = __ENV.PHASE || 'hit';
const pages = new SharedArray('pages', () =>
  open(__ENV.PAGES_FILE)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')),
);
// `x-cache`: `hit` from the process cache, `hit-shared` from the shared one, `miss` when rendered.
const EXPECT = { miss: 'miss', l2: 'hit-shared', hit: 'hit' };

const once = { executor: 'shared-iterations', vus: Number(__ENV.VUS || 10), iterations: pages.length, maxDuration: '10m' };
const steady = __ENV.RATE
  ? { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE), timeUnit: '1s', duration: __ENV.DURATION || '60s', preAllocatedVUs: 50, maxVUs: 200 }
  : { executor: 'constant-vus', vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || '60s' };

export const options = {
  scenarios: { pages: PHASE === 'hit' ? steady : once },
  // A redirect is an answer of its own (the pages list holds final addresses): never followed.
  maxRedirects: 0,
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  // A run with failed requests or answers from the wrong cache level is not a baseline: k6 exits non-zero.
  // At a fixed arrival rate, every arrival must also have been sent (none dropped for want of clients).
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'], ...(PHASE === 'hit' && __ENV.RATE ? { dropped_iterations: ['count==0'] } : {}) },
};

export default function () {
  // Each page exactly once in the miss and l2 phases: shared iterations are numbered across the VUs.
  const i = PHASE === 'hit' ? Math.floor(Math.random() * pages.length) : exec.scenario.iterationInTest;
  const [host, path] = pages[i];
  const res = http.get(`${BASE}${path}`, { headers: { host }, tags: { phase: PHASE } });
  check(res, {
    'status 200': (r) => r.status === 200,
    [`x-cache ${EXPECT[PHASE]}`]: (r) => r.headers['X-Cache'] === EXPECT[PHASE],
  });
}
