#!/usr/bin/env bash
# The v1 scale benchmark (HeoPress P13 task 3.2; docs/benchmarks/v1-scale.md): 100 sites × 1,000 articles on an
# installation made by docker/install.sh in a simulated 4 vCPU / 8 GB VPS (docker/scripts/sim-vps-install.sh:
# Docker-in-Docker, so PostgreSQL, the CMS, the worker, the rendering service and Caddy share that one budget), then
# apps/cms/k6/v1-scale.js from this machine through the installation's Caddy over HTTPS: 50 concurrent readers,
# a warm-up, then a measured phase with cache hits and misses recorded separately, with background publishing and
# admin API reads. Resource samples, memory peaks and the database size are recorded around it.
#
#   docker/scripts/bench-v1-scale.sh
#
# Environment (defaults in brackets): BENCH_OUT results [a new temporary directory]; BENCH_SITES [100];
# BENCH_PER_SITE [1000]; BENCH_SEED_CONCURRENCY [16]; BENCH_WARMUP [10m]; BENCH_DURATION [30m]; BENCH_COLD [20000]
# pages kept for the misses; BENCH_WRITE_RATE [0.5] background publishes per second; BENCH_ADMIN_RATE [2] background
# admin API reads per second; SIM_NAME [heopress-sim-bench, must contain "sim"]; SIM_CPUS [4]; SIM_MEMORY [8g];
# SIM_CMS_IMAGE / SIM_SITE_IMAGE / SIM_DB_IMAGE the images (see sim-vps-install.sh); BENCH_KEEP=1 keeps the VM.
# BENCH_REUSE=1 repeats only the load phase on a kept, seeded VM (SIM_NAME): both cache levels are emptied first (the
# shared cache's rows deleted, the rendering service and Caddy restarted), so it starts as a fresh run does; the VM
# is kept afterwards.
# Needs k6, node and Docker. Never prints the administrator's credentials (read from the VM into the environment of
# the seeding and k6 processes only).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="${BENCH_OUT:-$(mktemp -d)}"
mkdir -p -- "$out"
out="$(cd -- "$out" && pwd)"
export SIM_NAME="${SIM_NAME:-heopress-sim-bench}" SIM_CPUS="${SIM_CPUS:-4}" SIM_MEMORY="${SIM_MEMORY:-8g}"
sites="${BENCH_SITES:-100}"
per_site="${BENCH_PER_SITE:-1000}"
cold_n="${BENCH_COLD:-20000}"
vm="$SIM_NAME"
step() { echo "[bench-v1] $(date -u +%H:%M:%S) $*"; }
fail() { echo "[bench-v1] FAIL: $*" >&2; exit 1; }
in_vm() { docker exec "$vm" "$@"; }
psql_vm() { in_vm /opt/heopress/heopress-compose exec -T postgres psql -U heopress -d heopress -v ON_ERROR_STOP=1 -tAc "$1"; }
load() { echo "$(date -u +%H:%M:%S) $(cut -d' ' -f1-3 /proc/loadavg)" >> "$out/host-load.txt"; }
stats() { # label → docker stats of the installation's containers inside the VM
  in_vm sh -c 'docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" $(/opt/heopress/heopress-compose ps -q)' \
    | sed "s/^/$(date -u +%H:%M:%S)\t$1\t/" >> "$out/stats.tsv"
}
peaks() { # label → VmRSS / VmHWM of the CMS, worker and rendering service main processes; PostgreSQL total RSS
  for svc in cms cms-worker site-classic; do
    in_vm /opt/heopress/heopress-compose exec -T "$svc" sh -c 'grep -E "VmRSS|VmHWM" /proc/1/status' | tr -s ' \t' ' ' | tr '\n' ' ' \
      | sed "s/^/$1 $svc /;s/$/\n/" >> "$out/peaks.txt"
  done
  in_vm /opt/heopress/heopress-compose exec -T postgres sh -c 'ps -o rss= -C postgres 2>/dev/null | awk "{s+=\$1} END {print s/1024 \" MiB\"}" || echo n/a' \
    | sed "s/^/$1 postgres total RSS /" >> "$out/peaks.txt"
}
dbsize() { # label
  { echo "== $1"; psql_vm "SELECT pg_size_pretty(pg_database_size('heopress'))";
    psql_vm "SELECT relname || ' ' || pg_size_pretty(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12"; } >> "$out/db-size.txt"
}

echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ); host $(nproc) CPUs, $(awk '/MemTotal/ {printf "%d MB", $2/1024}' /proc/meminfo)" > "$out/run.txt"
git -C "$repo" rev-parse --short HEAD >> "$out/run.txt" 2>/dev/null || true
load

cleanup() {
  if [ "${BENCH_KEEP:-0}" != 1 ] && [ "${BENCH_REUSE:-0}" != 1 ]; then
    docker rm -f "$vm" >/dev/null 2>&1 || true
    docker volume rm "$vm-docker" >/dev/null 2>&1 || true
  fi
}
if [ "${BENCH_REUSE:-0}" = 1 ]; then
  step "reusing the seeded VM $vm"
  port="$(docker port "$vm" 443/tcp | head -1 | sed 's/.*://')"
  [ -n "$port" ] || fail "no running VM $vm"
else
  step "installation in a simulated ${SIM_CPUS} vCPU / ${SIM_MEMORY} VPS ($vm)"
  SIM_OUT="$out/install" SIM_KEEP=1 SIM_EXTRA="--extra-compose docker/docker-compose.bench-v1.yml" "$here/sim-vps-install.sh" > "$out/install.log" 2>&1 \
    || { tail -20 "$out/install.log"; fail 'installation failed'; }
  port="$(cat "$out/install/https-port")"
fi
trap cleanup EXIT
load

# The administrator's credentials, from the VM's root-only file into this process's environment (never printed).
BENCH_ADMIN_EMAIL="$(in_vm sed -n 's/^email=//p' /opt/heopress/secrets/admin-credentials)"
BENCH_ADMIN_PASSWORD="$(in_vm sed -n 's/^password=//p' /opt/heopress/secrets/admin-credentials)"
export BENCH_ADMIN_EMAIL BENCH_ADMIN_PASSWORD
[ -n "$BENCH_ADMIN_EMAIL" ] && [ -n "$BENCH_ADMIN_PASSWORD" ] || fail 'no administrator credentials in the VM'

if [ "${BENCH_REUSE:-0}" = 1 ]; then
  step 'emptying both cache levels'
  psql_vm "DELETE FROM lumibase_render_cache" > /dev/null
  in_vm /opt/heopress/heopress-compose restart site-classic caddy > /dev/null 2>&1
  sleep 10
  dbsize reuse-start
else
  step "seeding: $sites sites × $per_site articles through the API"
  stats seed-start
  seed_started=$(date +%s)
  node "$here/bench-v1-seed.mjs" --port "$port" --sites "$sites" --per-site "$per_site" --concurrency "${BENCH_SEED_CONCURRENCY:-16}" \
    --out "$out/seed.json" > "$out/seed.log" 2>&1 || { tail -5 "$out/seed.log"; fail 'seeding failed'; }
  tail -1 "$out/seed.log"
  stats seed-end
  load

  step 'waiting for the public projections and the job backlog'
  want=$((sites * per_site))
  have=0
  for _ in $(seq 1 720); do
    have="$(psql_vm "SELECT count(*) FROM lumibase_public_items WHERE site_id LIKE 'bench-%' AND collection = 'articles'")"
    backlog="$(psql_vm "SELECT count(*) FROM pgboss.job WHERE state IN ('created', 'retry', 'active') AND start_after <= now()")"
    [ "$have" -ge "$want" ] && [ "$backlog" -le 5 ] && break
    sleep 5
  done
  [ "$have" -ge "$want" ] || fail "the projections hold $have of $want articles"
  echo "projection complete $(( $(date +%s) - seed_started )) s after seeding started; backlog $backlog" | tee -a "$out/run.txt"
  dbsize after-seed
fi

step 'page lists'
psql_vm "SELECT h.hostname FROM lumibase_public_hosts h WHERE h.is_primary AND h.site_id LIKE 'bench-%' ORDER BY h.hostname" > "$out/hosts.txt"
[ "$(wc -l < "$out/hosts.txt")" -eq "$sites" ] || fail "expected $sites site hosts"
psql_vm "SELECT h.hostname || ' ' || i.path || CASE WHEN right(i.path, 1) = '/' THEN '' ELSE '/' END
  FROM lumibase_public_items i JOIN lumibase_public_hosts h ON h.site_id = i.site_id AND h.is_primary
  WHERE i.site_id LIKE 'bench-%' AND i.collection = 'articles' ORDER BY random()" > "$out/articles.txt"
head -n "$cold_n" "$out/articles.txt" > "$out/cold.txt"
{ tail -n +"$((cold_n + 1))" "$out/articles.txt"
  while read -r h; do for p in / '/?page=2' '/?page=3'; do echo "$h $p"; done; done < "$out/hosts.txt"; } > "$out/hot.txt"
wc -l "$out/hot.txt" "$out/cold.txt" | tee -a "$out/run.txt"

step 'idle (60 s settle, then samples)'
sleep 60
stats idle
peaks idle
load

echo "load: warm-up ${BENCH_WARMUP:-10m}, measured ${BENCH_DURATION:-30m}, background ${BENCH_WRITE_RATE:-0.5} publishes/s, ${BENCH_ADMIN_RATE:-2} admin reads/s" >> "$out/run.txt"
step "load: warm-up ${BENCH_WARMUP:-10m}, measured ${BENCH_DURATION:-30m} (50 readers + background writes and admin reads)"
( while true; do stats load; load; sleep 30; done ) &
sampler=$!
set +e
k6 run --quiet --summary-export "$out/k6-summary.json" \
  --env HTTPS_PORT="$port" --env HOSTS_FILE="$out/hosts.txt" --env HOT_FILE="$out/hot.txt" --env COLD_FILE="$out/cold.txt" \
  --env WARMUP="${BENCH_WARMUP:-10m}" --env DURATION="${BENCH_DURATION:-30m}" \
  --env WRITE_RATE="${BENCH_WRITE_RATE:-0.5}" --env ADMIN_RATE="${BENCH_ADMIN_RATE:-2}" \
  "$repo/apps/cms/k6/v1-scale.js" > "$out/k6.txt" 2>&1
k6_code=$?
set -e
kill "$sampler" 2>/dev/null || true
wait "$sampler" 2>/dev/null || true
echo "k6 exit $k6_code" | tee -a "$out/run.txt"
peaks after-load
stats after-load
dbsize after-load
psql_vm "SELECT count(*) || ' rendered pages in the shared cache' FROM lumibase_render_cache WHERE status = 200" >> "$out/run.txt"
psql_vm "SELECT name || ' ' || state || ' ' || count(*) FROM pgboss.job GROUP BY name, state ORDER BY name" > "$out/jobs.txt" || true
load
echo "finished $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$out/run.txt"
step "results in $out"
grep -E 'lat_|admin_list|write_publish|answers_|http_req_duration|iterations' "$out/k6.txt" || true
