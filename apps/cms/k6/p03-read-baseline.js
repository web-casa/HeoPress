/**
 * P03 baseline (docs/benchmarks/p03-baseline.md): 50 concurrent readers for
 * 60 s — 70% item lists (random page 1–10 by offset), 20% item detail, 10% PostgreSQL search.
 *
 *   k6 run --env BASE_URL=http://127.0.0.1:1989 --env TOKEN=<jwt> \
 *          --env ITEM_IDS=<comma-separated ids> apps/cms/k6/p03-read-baseline.js
 */
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: { readers: { executor: 'constant-vus', vus: Number(__ENV.VUS || 50), duration: __ENV.DURATION || '60s' } },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  // A run with failed requests is not a baseline: k6 exits non-zero.
  thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
};

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:1989';
const params = { headers: { authorization: `Bearer ${__ENV.TOKEN}`, 'x-heopress-site': __ENV.SITE_ID || '__default__' } };
const ids = (__ENV.ITEM_IDS || '').split(',').filter(Boolean);
const words = ['运营', '指南', 'network', 'content', 'site'];

export function setup() {
  if (ids.length === 0) throw new Error('ITEM_IDS is empty: seed items first');
  // The search share must hit indexed documents, not an empty index.
  const res = http.get(`${BASE}/api/v1/search?collection=articles&q=${encodeURIComponent(words[0])}`, params);
  const hits = res.status === 200 ? (res.json('data') || []).length : 0;
  if (hits === 0) throw new Error(`search returned no hits (status ${res.status}): index not filled`);
}

export default function () {
  const r = Math.random();
  let res;
  if (r < 0.7) {
    // The items API pages by offset (a `page` parameter would be ignored).
    const offset = 20 * Math.floor(Math.random() * 10);
    res = http.get(`${BASE}/api/v1/items/articles?limit=20&offset=${offset}`, { ...params, tags: { kind: 'list' } });
  } else if (r < 0.9 && ids.length) {
    res = http.get(`${BASE}/api/v1/items/articles/${ids[Math.floor(Math.random() * ids.length)]}`, { ...params, tags: { kind: 'detail' } });
  } else {
    const q = encodeURIComponent(words[Math.floor(Math.random() * words.length)]);
    res = http.get(`${BASE}/api/v1/search?collection=articles&q=${q}`, { ...params, tags: { kind: 'search' } });
  }
  check(res, { 'status 200': (x) => x.status === 200 });
}
