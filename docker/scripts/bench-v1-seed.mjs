#!/usr/bin/env node
/**
 * Seeding for the v1 scale benchmark (HeoPress P13 task 3.2; docs/benchmarks/v1-scale.md): N sites, each on its own
 * free test subdomain (`bench-001.sites.example.test`, …) with a starter theme (news, tech, minimal in turn) and M
 * published articles of about 3 KB, written through the public API of an installation made by docker/install.sh —
 * the same path an operator's tools use (site creation, domains, themes, item creation with publishing; the worker
 * then builds each site's public projection and search index).
 *
 *   BENCH_ADMIN_EMAIL=… BENCH_ADMIN_PASSWORD=… node docker/scripts/bench-v1-seed.mjs \
 *     --port <https port> [--sites 100] [--per-site 1000] [--concurrency 16] [--out seed.json]
 *
 * Requests go to 127.0.0.1:<port> (the installation's Caddy) with the TLS name of the administration domain
 * (admin.example.test; Caddy's local CA, so certificates are not verified). The credentials come from the
 * environment and are never printed. Sites that exist already are reused, so an interrupted run can continue.
 */
import https from 'node:https';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith('--') ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
const port = Number(args.port);
const SITES = Number(args.sites ?? 100);
const PER_SITE = Number(args['per-site'] ?? 1000);
const CONCURRENCY = Number(args.concurrency ?? 16);
const ADMIN = args['admin-domain'] ?? 'admin.example.test';
const THEMES = ['news', 'tech', 'minimal'];
const email = process.env.BENCH_ADMIN_EMAIL;
const password = process.env.BENCH_ADMIN_PASSWORD;
if (!port || !email || !password) {
  console.error('usage: BENCH_ADMIN_EMAIL=… BENCH_ADMIN_PASSWORD=… bench-v1-seed.mjs --port <https port> [--sites N] [--per-site M]');
  process.exit(2);
}

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: CONCURRENCY + 4,
  rejectUnauthorized: false,
  servername: ADMIN,
  lookup: (_host, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)),
});

function request(method, path, site, body, token) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: ADMIN,
        port,
        method,
        path,
        agent,
        headers: {
          'content-type': 'application/json',
          'x-heopress-site': site,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`timeout ${method} ${path}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A request that must succeed: retries on rate limits, overload and network errors; error codes only in messages. */
async function must(method, path, site, body, token, ok = [200, 201]) {
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await request(method, path, site, body, token());
    } catch (err) {
      if (attempt >= 6) throw err;
      await sleep(500 * attempt);
      continue;
    }
    if (ok.includes(res.status)) return res;
    const codes = (res.json?.errors ?? []).map((e) => e.code).join(',');
    if ([429, 502, 503, 504].includes(res.status) && attempt < 10) {
      await sleep(1000 * attempt);
      continue;
    }
    throw new Error(`${method} ${path} (${site}) answered ${res.status} ${codes}`);
  }
}

async function login(site) {
  const res = await must('POST', '/api/v1/auth/login', site, { email, password }, () => undefined);
  const token = res.json?.data?.token;
  if (!token) throw new Error(`login to ${site}: no token`);
  return token;
}

const paragraph =
  '<p>Site network operations: collecting, translating and publishing content across independent domains, with quality gates before anything goes live. 站群运营：采集、翻译与发布。</p>';
const body = paragraph.repeat(16);

const started = Date.now();
let written = 0;
let rootToken = await login('__default__');
let rootTokenAt = Date.now();
const timings = [];
for (let s = 1; s <= SITES; s += 1) {
  const id = `bench-${String(s).padStart(3, '0')}`;
  const theme = THEMES[(s - 1) % THEMES.length];
  if (Date.now() - rootTokenAt > 5 * 60_000) {
    rootToken = await login('__default__');
    rootTokenAt = Date.now();
  }
  const siteStarted = Date.now();
  const created = await must('POST', '/api/v1/instance/sites', '__default__', { id, name: `Bench ${s}` }, () => rootToken, [200, 201, 409]);
  const token = await login(id);
  const auth = () => token;
  if (created.status !== 409) {
    const domain = await must('POST', '/api/v1/domains', id, { kind: 'subdomain', hostname: id }, auth);
    await must('POST', `/api/v1/domains/${domain.json.data.id}/primary`, id, undefined, auth);
    const version = await must('POST', `/api/v1/themes/starters/${theme}`, id, undefined, auth);
    await must('POST', `/api/v1/themes/versions/${version.json.data.id}/activate`, id, undefined, auth);
  }
  let next = 1;
  const worker = async () => {
    while (next <= PER_SITE) {
      const n = next;
      next += 1;
      await must(
        'POST',
        '/api/v1/items/articles',
        id,
        {
          data: { title: `${theme} article ${n} of ${id}`, slug: `article-${n}`, locale: 'en', excerpt: `Excerpt of article ${n}.`, body },
          status: 'published',
        },
        auth,
        created.status === 409 ? [201, 409, 422] : [201],
      );
      written += 1;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (Date.now() - siteStarted) / 1000;
  timings.push({ site: id, theme, seconds });
  const total = (Date.now() - started) / 1000;
  console.log(`[seed] ${id} (${theme}) ${PER_SITE} articles in ${seconds.toFixed(1)} s; total ${written} in ${total.toFixed(0)} s (${(written / total).toFixed(1)}/s)`);
}
const summary = { sites: SITES, perSite: PER_SITE, concurrency: CONCURRENCY, written, seconds: (Date.now() - started) / 1000, timings };
if (args.out) fs.writeFileSync(args.out, JSON.stringify(summary, null, 2));
console.log(`[seed] done: ${written} articles on ${SITES} sites in ${summary.seconds.toFixed(0)} s`);
agent.destroy();
