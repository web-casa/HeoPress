#!/usr/bin/env node
/**
 * Mixed load against a running acceptance stack (HeoPress P13 task 6.2; docker/scripts/accept-image-runtime.sh).
 *
 * For `--seconds`, at the same time:
 *   - front:  public pages of the sites from the rendering service (random pages of `--pages`, `host path` lines);
 *   - studio: Studio operations through the CMS API with each site's administrator token, each client an editor
 *             working at about one cycle a second (create a published article, edit it with its version, list the
 *             collection) — every write is a change event and queues background work;
 *   - events and background jobs: what those writes start (event consumers, the public projection, search
 *             indexing on the worker, scheduled jobs) — measured, not driven.
 * Every 2 s it samples the CMS process (Prometheus default metrics: event-loop delay p99 and max, resident memory),
 * the containers (`docker stats`), PostgreSQL (connections by state and those waiting on a lock, from
 * pg_stat_activity), the readiness probe's latency (it queries the database through the application's pool, so its
 * latency includes the wait for a pooled connection), the queue backlog (pg-boss jobs created or retrying, active)
 * (jobs due now) and the event backlog (change events behind the furthest-behind active consumer).
 * After the load it waits for the queue and event backlogs to drain and writes `--out` (JSON).
 *
 * Fails (exit 1) when a front or Studio request errs (network error or 5xx), when a Studio write is refused, or when
 * a backlog has not drained `--drain-seconds` after the load. Tokens come from the environment
 * (ACCEPT_TOKENS: `site=token` pairs separated by spaces), never from arguments, and are never printed.
 *
 *   node docker/scripts/accept-mixed-load.mjs --cms <url> --sites <url> --pages <file> --out <file>
 *     [--seconds 60] [--front 8] [--studio 4] [--studio-cycle-ms 1000] [--drain-seconds 180] [--compose "docker compose -f …"]
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { promisify } from 'node:util';

const run = promisify(execFile);

function args(argv) {
  const opts = { seconds: 60, front: 8, studio: 4, studioCycleMs: 1000, drainSeconds: 180, compose: 'docker compose' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    opts[key] = ['seconds', 'front', 'studio', 'studioCycleMs', 'drainSeconds'].includes(key) ? Number(argv[i + 1]) : argv[i + 1];
  }
  for (const k of ['cms', 'sites', 'pages', 'out']) if (!opts[k]) throw new Error(`--${k} is required`);
  return opts;
}

const opts = args(process.argv.slice(2));
const tokens = Object.fromEntries(
  (process.env.ACCEPT_TOKENS ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => pair.split('=')),
);
const metricsToken = process.env.ACCEPT_METRICS_TOKEN ?? '';
const sites = Object.keys(tokens);
if (sites.length === 0) throw new Error('ACCEPT_TOKENS is empty');
const pages = fs
  .readFileSync(opts.pages, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split(' '));
const [composeCmd, ...composeArgs] = opts.compose.split(/\s+/);

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/** One HTTP request; resolves to { status, ms, body } (status 0 on a network error). */
function request(base, { method = 'GET', path, headers = {}, body }) {
  const url = new URL(path, base);
  const started = performance.now();
  return new Promise((resolve) => {
    const req = http.request(
      { agent, hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, timeout: 30_000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            ms: performance.now() - started,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, ms: performance.now() - started, body: '', error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

const stats = {};
function record(kind, res) {
  const s = (stats[kind] ??= { count: 0, statuses: {}, ms: [] });
  s.count += 1;
  s.statuses[res.status] = (s.statuses[res.status] ?? 0) + 1;
  s.ms.push(res.ms);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round = (n, d = 1) => (n === null || n === undefined ? null : Number(n.toFixed(d)));

async function front(deadline) {
  while (Date.now() < deadline) {
    const [host, path] = pages[Math.floor(Math.random() * pages.length)];
    record('front', await request(opts.sites, { path, headers: { host } }));
  }
}

let seq = 0;
const refusedWrites = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** One editor at the Studio: create a published article, edit it (with its version), list; about one cycle a second. */
async function studio(deadline, worker) {
  while (Date.now() < deadline) {
    const cycleStarted = Date.now();
    const site = sites[worker % sites.length];
    const headers = { authorization: `Bearer ${tokens[site]}`, 'x-heopress-site': site, 'content-type': 'application/json' };
    const n = `${worker}-${(seq += 1)}`;
    const created = await request(opts.cms, {
      method: 'POST',
      path: '/api/v1/items/articles',
      headers,
      body: JSON.stringify({
        data: { title: `Load article ${n}`, slug: `load-${n}`, locale: 'en', excerpt: `Mixed load ${n}.`, body: '<p>Mixed load.</p>' },
        status: 'published',
      }),
    });
    record('studio:create', created);
    if (created.status !== 201) {
      refusedWrites.push(`create ${created.status}`);
    } else {
      const item = JSON.parse(created.body).data;
      const edited = await request(opts.cms, {
        method: 'PATCH',
        path: `/api/v1/items/articles/${item.id}`,
        headers: { ...headers, 'if-match': created.headers.etag ?? `"${item.version}"` },
        body: JSON.stringify({ data: { title: `Load article ${n} (edited)` } }),
      });
      record('studio:edit', edited);
      if (edited.status !== 200) refusedWrites.push(`edit ${edited.status}`);
    }
    record('studio:list', await request(opts.cms, { path: '/api/v1/items/articles?limit=20', headers }));
    await pause(Math.max(0, opts.studioCycleMs - (Date.now() - cycleStarted)));
  }
}

async function psql(query) {
  const { stdout } = await run(composeCmd, [...composeArgs, 'exec', '-T', 'postgres', 'psql', '-U', 'heopress', '-d', 'heopress', '-tAc', query]);
  return stdout.trim();
}

/**
 * Queues nothing consumes, reported apart from the backlog: `media-processing` (every image upload enqueues
 * thumbnails no process handles; docs/known-issues.md). Listed here explicitly — never a silent exclusion.
 */
const ORPHAN_QUEUES = ['media-processing'];
const orphanList = ORPHAN_QUEUES.map((q) => `'${q}'`).join(', ');
const BACKLOG_SQL = `SELECT
  (SELECT count(*) FROM pgboss.job WHERE state IN ('created', 'retry') AND start_after <= now() AND name NOT IN (${orphanList})),
  (SELECT count(*) FROM pgboss.job WHERE state = 'active'),
  (SELECT count(*) FROM pgboss.job WHERE state = 'created' AND name IN (${orphanList})),
  (SELECT coalesce(max(n), 0) FROM (
     SELECT (SELECT count(*) FROM lumibase_cdc_change_events e
              WHERE (c.site_id IS NULL OR e.site_id = c.site_id) AND (e.txid, e.seq) > (c.cursor_txid, c.cursor_seq)) AS n
       FROM lumibase_event_consumers c WHERE c.status = 'active' AND c.cursor_txid IS NOT NULL) x)`;
// Client connections other than this sampler's own: the CMS processes (API and worker) and the rendering role.
const CONNECTIONS_SQL = `SELECT
  count(*) FILTER (WHERE state = 'active'),
  count(*) FILTER (WHERE state LIKE 'idle%'),
  count(*) FILTER (WHERE wait_event_type = 'Lock'),
  count(*),
  count(*) FILTER (WHERE usename = 'heopress_render')
  FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()`;

async function backlog() {
  const [queued, active, orphanQueued, events] = (await psql(BACKLOG_SQL)).split('|').map(Number);
  return { queued, active, events, orphanQueued };
}

function metric(text, name) {
  const m = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.e+-]+)$`, 'm'));
  return m ? Number(m[1]) : null;
}

function bytes(text) {
  const m = text.match(/^([0-9.]+)\s*([KMG]i?B|B)/);
  if (!m) return null;
  const unit = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, KB: 1e3, MB: 1e6, GB: 1e9 }[m[2]];
  return Number(m[1]) * unit;
}

const samples = [];
async function sample(phase) {
  const at = Date.now();
  const [metrics, ready, docker, conns, queue] = await Promise.all([
    request(opts.cms, { path: '/metrics', headers: metricsToken ? { authorization: `Bearer ${metricsToken}` } : {} }),
    request(opts.cms, { path: '/health/ready' }),
    run(composeCmd, [...composeArgs, 'ps', '-q']).then(({ stdout }) =>
      run('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}', ...stdout.trim().split('\n')]),
    ),
    psql(CONNECTIONS_SQL),
    backlog(),
  ]);
  const [active, idle, lockWaits, total, rendering] = conns.split('|').map(Number);
  const containers = {};
  for (const line of docker.stdout.trim().split('\n')) {
    const [name, cpu, mem] = line.split('\t');
    const service = name.replace(/^.*?-(postgres|cms-worker|cms|site-classic)-\d+$/, '$1');
    containers[service] = { cpu: Number.parseFloat(cpu), memBytes: bytes(mem) };
  }
  samples.push({
    phase,
    t: at,
    cms: {
      eventLoopP99Ms: metric(metrics.body, 'nodejs_eventloop_lag_p99_seconds') * 1000,
      eventLoopMaxMs: metric(metrics.body, 'nodejs_eventloop_lag_max_seconds') * 1000,
      rssBytes: metric(metrics.body, 'process_resident_memory_bytes'),
      metricsStatus: metrics.status,
    },
    readyMs: ready.ms,
    readyStatus: ready.status,
    db: { active, idle, lockWaits, total, rendering },
    backlog: queue,
    containers,
  });
}

async function sampler(phase, until) {
  while (Date.now() < until()) {
    await sample(phase).catch((err) => console.error(`[load] sample failed: ${err.message}`));
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function summarize(phase) {
  const list = samples.filter((s) => s.phase === phase);
  const max = (f) => list.reduce((m, s) => Math.max(m, f(s) ?? 0), 0);
  const services = new Set(list.flatMap((s) => Object.keys(s.containers)));
  return {
    samples: list.length,
    cmsEventLoopP99MsMax: round(max((s) => s.cms.eventLoopP99Ms)),
    cmsEventLoopMaxMsMax: round(max((s) => s.cms.eventLoopMaxMs)),
    cmsRssMiBMax: round(max((s) => s.cms.rssBytes) / 1024 ** 2),
    readyMsP95: round(percentile(list.map((s) => s.readyMs), 95)),
    readyMsMax: round(max((s) => s.readyMs)),
    dbActiveMax: max((s) => s.db.active),
    dbConnectionsMax: max((s) => s.db.total),
    dbRenderingConnectionsMax: max((s) => s.db.rendering),
    dbLockWaitsMax: max((s) => s.db.lockWaits),
    queueBacklogMax: max((s) => s.backlog.queued),
    queueActiveMax: max((s) => s.backlog.active),
    eventBacklogMax: max((s) => s.backlog.events),
    containerMemMiBMax: Object.fromEntries(
      [...services].sort().map((svc) => [svc, round(max((s) => s.containers[svc]?.memBytes) / 1024 ** 2)]),
    ),
    containerCpuPctMax: Object.fromEntries([...services].sort().map((svc) => [svc, round(max((s) => s.containers[svc]?.cpu))])),
  };
}

async function main() {
  const idleUntil = Date.now() + 6000;
  await sampler('idle', () => idleUntil);

  const started = Date.now();
  const deadline = started + opts.seconds * 1000;
  console.log(`[load] ${opts.seconds} s: ${opts.front} front clients, ${opts.studio} Studio clients, ${sites.length} sites`);
  await Promise.all([
    sampler('load', () => deadline),
    ...Array.from({ length: opts.front }, () => front(deadline)),
    ...Array.from({ length: opts.studio }, (_, i) => studio(deadline, i)),
  ]);

  // Drain: the queue and the event consumers catch up once the writes stop.
  const drainStarted = Date.now();
  let drained = null;
  let last;
  while (Date.now() - drainStarted < opts.drainSeconds * 1000) {
    await sample('drain').catch(() => {});
    last = await backlog();
    if (last.queued === 0 && last.active === 0 && last.events === 0) {
      drained = (Date.now() - drainStarted) / 1000;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const requests = Object.fromEntries(
    Object.entries(stats).map(([kind, s]) => [
      kind,
      {
        count: s.count,
        perSecond: round(s.count / opts.seconds),
        statuses: s.statuses,
        p50Ms: round(percentile(s.ms, 50)),
        p95Ms: round(percentile(s.ms, 95)),
        p99Ms: round(percentile(s.ms, 99)),
      },
    ]),
  );
  const errors = Object.entries(stats).flatMap(([kind, s]) =>
    Object.entries(s.statuses)
      .filter(([status]) => Number(status) === 0 || Number(status) >= 500)
      .map(([status, n]) => `${kind}: ${n} × ${status === '0' ? 'network error' : status}`),
  );
  const result = {
    seconds: opts.seconds,
    clients: { front: opts.front, studio: opts.studio },
    sites: sites.length,
    pages: pages.length,
    requests,
    idle: summarize('idle'),
    load: summarize('load'),
    drain: { seconds: drained, last },
    errors,
    refusedWrites: refusedWrites.length,
  };
  fs.writeFileSync(opts.out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  agent.destroy();

  const problems = [...errors];
  if (refusedWrites.length > 0) problems.push(`${refusedWrites.length} Studio writes refused (${[...new Set(refusedWrites)].join(', ')})`);
  if (drained === null) {
    const stuck = await psql(
      `SELECT name || ' ' || state || ' ' || created_on FROM pgboss.job WHERE state IN ('created', 'retry', 'active') AND start_after <= now() AND name NOT IN (${orphanList}) ORDER BY created_on LIMIT 10`,
    ).catch((err) => err.message);
    problems.push(`backlog not drained ${opts.drainSeconds} s after the load: ${JSON.stringify(last)}; jobs: ${stuck.replace(/\n/g, '; ')}`);
  }
  if (!requests.front?.count || !requests['studio:create']?.count) problems.push('no front or Studio request completed');
  if (problems.length > 0) {
    for (const p of problems) console.error(`[load] FAIL: ${p}`);
    process.exit(1);
  }
}

await main();
