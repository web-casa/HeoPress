#!/usr/bin/env bash
# P06 baseline (docs/benchmarks/p06-classic.md): the public sites served by
# site-classic — three sites (one per starter theme), each with N published
# articles; p95 latency of rendered answers (cache misses), shared-cache hits
# after a restart, process-cache hits, and resident memory. Resource limits
# emulate a 2 vCPU / 4 GB VPS (docker-compose.bench-p06.yml); the rendering
# service is published on the host by docker-compose.sites.yml.
# BENCH_GLOSSARY=1 (P12 task 10.5) enables the official glossary plugin on
# every site first (docker/scripts/bench-glossary.mjs); the pages are the same.
# Measurement hygiene (P13 task 7.5, as bench-v1-scale.sh): BENCH_CPUSET pins the four containers to those host CPUs
# (a generated Compose override with `cpuset`, applied before they start; their CPU and memory limits stay); BENCH_K6_CPUS pins k6 to other host CPUs
# (taskset); BENCH_MAX_LOAD, when set, holds every measured phase until the host's 1-minute load average is at most
# that (checked every 15 s, for at most BENCH_GATE_MINUTES [120]). The pinning and every check go to run.txt.
#
#   docker/scripts/bench-p06-classic.sh [cms-port] [site-port] [articles-per-site]
#
# Runs as its own compose project (COMPOSE_PROJECT_NAME, default
# heopress-bench-p06), whose volumes it destroys and recreates — never a
# development stack's. Both ports are bound to 127.0.0.1. Needs k6 and curl.
set -euo pipefail
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-heopress-bench-p06}"
case "$COMPOSE_PROJECT_NAME" in
  *bench*) ;;
  *) echo "[bench] COMPOSE_PROJECT_NAME must name a benchmark project (contain 'bench'): its volumes are deleted" >&2; exit 1 ;;
esac

cms_port="${1:-1989}"
site_port="${2:-2027}"
per_site="${3:-1000}"
base="http://127.0.0.1:$cms_port"
sites_base="http://127.0.0.1:$site_port"
out="${BENCH_OUT:-$(mktemp -d)}"
mkdir -p -- "$out"
export CMS_PORT="$cms_port" SITE_PORT="$site_port"
files=(-f docker/docker-compose.yml -f docker/docker-compose.sites.yml -f docker/docker-compose.bench-p06.yml)
if [ -n "${BENCH_CPUSET:-}" ]; then
  printf 'services:\n' > "$out/cpuset.yml"
  for svc in postgres cms cms-worker site-classic; do printf '  %s:\n    cpuset: "%s"\n' "$svc" "$BENCH_CPUSET" >> "$out/cpuset.yml"; done
  files+=(-f "$out/cpuset.yml")
fi
compose=(docker compose "${files[@]}")
suffix='bench.example.test'
export HEOPRESS_FREE_DOMAIN_SUFFIX="$suffix"
themes=(news tech minimal)

fail() { echo "[bench] FAIL: $*" >&2; exit 1; }
# shellcheck source=lib-p06-sites.sh
. docker/scripts/lib-p06-sites.sh
stats() { # label → one line per container of this project: name, CPU %, memory
  local ids
  mapfile -t ids < <("${compose[@]}" ps -q)
  [ "${#ids[@]}" -eq 4 ] || fail "expected 4 containers, found ${#ids[@]}"
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' "${ids[@]}" | sed "s/^/$1\t/"
}
gate() { # label: hold until the host's 1-minute load average is at most BENCH_MAX_LOAD
  local max="${BENCH_MAX_LOAD:-}" waited=0 now
  [ -n "$max" ] || return 0
  while now="$(cut -d' ' -f1 /proc/loadavg)"; awk -v l="$now" -v m="$max" 'BEGIN { exit !(l > m) }'; do
    [ "$waited" -lt $(( ${BENCH_GATE_MINUTES:-120} * 60 )) ] || fail "host load $now still above $max before the $1 phase"
    [ $(( waited % 300 )) -ne 0 ] || echo "[bench] host load $now above $max: holding the $1 phase"
    sleep 15
    waited=$((waited + 15))
  done
  echo "gate before the $1 phase: host load $(cut -d' ' -f1-3 /proc/loadavg) (limit $max), held ${waited} s at $(date -u +%H:%M:%S)" | tee -a "$out/run.txt"
}
k6phase() { # label phase pages-file [extra k6 args]
  local label="$1" phase="$2" pages="$3" pin=()
  shift 3
  gate "$label"
  [ -z "${BENCH_K6_CPUS:-}" ] || pin=(taskset -c "$BENCH_K6_CPUS")
  "${pin[@]}" k6 run --quiet --summary-export "$out/k6-$label.json" --env BASE_URL="$sites_base" --env PAGES_FILE="$pages" \
    --env PHASE="$phase" "$@" apps/cms/k6/p06-classic.js | tee "$out/k6-$label.txt"
}
rss() { # label → the rendering service's resident memory (main process with its render worker threads)
  "${compose[@]}" exec -T site-classic sh -c 'grep -E "VmRSS|VmHWM" /proc/1/status' | tr -s ' \t' ' ' | sed "s/^/$1 /" >> "$out/rss.txt"
}

echo "[bench] fresh stack"
"${compose[@]}" down -v >/dev/null
"${compose[@]}" up -d --build >/dev/null
docker/scripts/smoke-minimal-deploy.sh "$base" "${files[@]}" >/dev/null
: > "$out/run.txt"
{ for id in $("${compose[@]}" ps -q); do
    docker inspect -f '{{.Name}} pinning: cpus={{.HostConfig.NanoCpus}} cpuset={{.HostConfig.CpusetCpus}} memory={{.HostConfig.Memory}}' "$id"
  done
  echo "k6 pinning: ${BENCH_K6_CPUS:-none}"
  "${compose[@]}" logs site-classic 2>/dev/null | grep -o 'listening on.*' | tail -1 || true; } >> "$out/run.txt"


# A body of about 3 KB, as an article of a few paragraphs would have.
paragraph='<p>Site network operations: collecting, translating and publishing content across independent domains, with quality gates before anything goes live. 站群运营：采集、翻译与发布。</p>'
body=$(printf "$paragraph%.0s" $(seq 1 16))

for i in 0 1 2; do
  site="bench-${themes[$i]}"
  echo "[bench] site $site: theme ${themes[$i]}, domain $site.$suffix, $per_site articles"
  new_site "$site" "Bench ${themes[$i]}" "${themes[$i]}"
  seq 1 "$per_site" | xargs -P 8 -I{} curl -fsS -o /dev/null -X POST "$base/api/v1/items/articles" \
    -H "authorization: Bearer $token" -H "x-heopress-site: $site" -H 'content-type: application/json' \
    -d "{\"data\":{\"title\":\"${themes[$i]} article {}\",\"slug\":\"article-{}\",\"locale\":\"en\",\"excerpt\":\"Excerpt of article {}.\",\"body\":\"$body\"},\"status\":\"published\"}"
done

# P12 task 10.5 (opt-in): the official glossary plugin enabled on every site, the measured pages unchanged.
if [ "${BENCH_GLOSSARY:-0}" = 1 ]; then
  echo "[bench] the official glossary plugin on every site"
  node docker/scripts/bench-glossary.mjs key "$out"
  pem=$(cat "$out/bench-key.pub.pem")
  p06_psql "INSERT INTO lumibase_publisher_keys (id, key_id, public_key_pem, publisher, official, revoked) VALUES ('pk_bench_glossary', 'heopress-bench-official', '$pem', 'HeoPress benchmark', true, false)" >/dev/null
  node docker/scripts/bench-glossary.mjs install "$base" "$out" "${themes[@]/#/bench-}"
fi

# Every published article of the three sites, by its primary host: the pages measured.
echo "[bench] waiting for the public projection"
want=$((3 * per_site))
for _ in $(seq 1 120); do
  have=$(p06_psql "SELECT count(*) FROM lumibase_public_items i JOIN lumibase_public_sites s USING (site_id) WHERE i.site_id LIKE 'bench-%' AND i.collection = 'articles' AND s.built_at IS NOT NULL")
  [ "$have" -ge "$want" ] && break
  sleep 2
done
[ "$have" -ge "$want" ] || fail "projection has $have of $want articles"
if [ "${BENCH_GLOSSARY:-0}" = 1 ]; then
  # Publishing the terms queued the plugin's relink of every article (a background job in batches): the measured
  # state is after it, as on a site where the plugin has been enabled for a while. How long it took is recorded.
  echo "[bench] waiting for the glossary plugin's relink jobs"
  started=$(date +%s)
  for _ in $(seq 1 360); do
    busy=$(p06_psql "SELECT (SELECT count(*) FROM pgboss.job WHERE name LIKE 'plugin-jobs%' AND state IN ('created', 'retry', 'active'))
      + (SELECT count(*) FROM lumibase_plugin_jobs WHERE extension_name = 'heopress-glossary' AND (lease_until > now() OR last_status = 'continued'))")
    [ "$busy" -eq 0 ] && break
    sleep 5
  done
  [ "$busy" -eq 0 ] || fail "the glossary plugin's jobs are still running"
  runs=$(p06_psql "SELECT count(*) FROM lumibase_plugin_job_runs WHERE extension_name = 'heopress-glossary'")
  echo "[bench] glossary relink done after $(( $(date +%s) - started )) s ($runs job runs)" | tee "$out/glossary.txt"
fi
# The projection keeps paths without the trailing slash the sites add (a request without it is a 301).
p06_psql "SELECT h.hostname || ' ' || i.path || CASE WHEN right(i.path, 1) = '/' THEN '' ELSE '/' END FROM lumibase_public_items i JOIN lumibase_public_hosts h ON h.site_id = i.site_id AND h.is_primary
      WHERE i.site_id LIKE 'bench-%' AND i.collection = 'articles' ORDER BY random()" > "$out/pages.txt"
[ "$(wc -l < "$out/pages.txt")" -ge "$want" ] || fail "fewer pages than articles"
# Lists too: each site's home page and the next pages of its archive. They are shared as well (list pages
# whose page exists); the shared-cache phase measures article pages only.
for i in 0 1 2; do for p in '' '?page=2' '?page=3'; do echo "bench-${themes[$i]}.$suffix /$p"; done; done > "$out/lists.txt"
cat "$out/pages.txt" "$out/lists.txt" > "$out/all.txt"

echo "[bench] idle (30 s settle, then 3 samples)"
sleep 30
: > "$out/stats.tsv"
: > "$out/rss.txt"
rss idle
for _ in 1 2 3; do stats idle >> "$out/stats.tsv"; sleep 5; done

echo "[bench] misses: every page once, rendered (10 VUs)"
k6phase miss miss "$out/all.txt"
rss after-miss
stats after-miss >> "$out/stats.tsv"

echo "[bench] shared-cache hits: restart site-classic (process cache empty), every article page once (10 VUs)"
# Shared-cache writes happen after the answers: every page of the miss phase stored before the restart.
want_all=$(wc -l < "$out/all.txt")
for _ in $(seq 1 60); do
  stored=$(p06_psql "SELECT count(*) FROM lumibase_render_cache WHERE site_id LIKE 'bench-%' AND status = 200")
  [ "$stored" -ge "$want_all" ] && break
  sleep 1
done
[ "$stored" -ge "$want_all" ] || fail "shared cache holds $stored of $want_all pages"
"${compose[@]}" restart site-classic >/dev/null
for _ in $(seq 1 30); do curl -fs -o /dev/null -H "host: bench-news.$suffix" "$sites_base/" && break; sleep 1; done
# That probe read the home page (not part of this phase); every article page must come from the shared level.
k6phase l2 l2 "$out/pages.txt"
# The list pages into this process too: the next phases are process-cache hits only.
while read -r host path; do curl -fs -o /dev/null -H "host: $host" "$sites_base$path"; done < "$out/lists.txt"
rss after-l2
stats after-l2 >> "$out/stats.tsv"

# Latency below the throughput ceiling: a fixed arrival rate (closed-loop clients without pauses would
# measure queueing at the ceiling instead).
for rate in 300 600; do
  echo "[bench] process-cache hits: $rate requests/s, random pages, 30 s"
  k6phase "hit-r$rate" hit "$out/all.txt" --env RATE="$rate" --env DURATION=30s
done

echo "[bench] process-cache hits: the throughput ceiling — 50 clients without pauses, random pages, 60 s"
( for _ in $(seq 1 10); do sleep 5; stats hit >> "$out/stats.tsv"; done ) &
sampler=$!
k6phase hit50 hit "$out/all.txt"
wait "$sampler"
rss after-hit

echo "[bench] results in $out"
cat "$out/stats.tsv" "$out/rss.txt"
