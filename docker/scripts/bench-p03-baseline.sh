#!/usr/bin/env bash
# P03 baseline (docs/benchmarks/p03-baseline.md): memory and CPU of the
# minimal deployment idle and under 50 concurrent readers, with resource
# limits emulating a 2 vCPU / 4 GB VPS (docker-compose.bench.yml).
#
#   docker/scripts/bench-p03-baseline.sh [port] [items]
#
# Destroys and recreates the compose project's volumes. Needs k6.
set -euo pipefail

port="${1:-1989}"
items="${2:-1000}"
base="http://127.0.0.1:$port"
out="${BENCH_OUT:-$(mktemp -d)}"
export CMS_PORT="$port"
compose=(docker compose -f docker/docker-compose.yml -f docker/docker-compose.bench.yml)
site='__default__'

stats() { # label → one line per container: name, CPU %, memory
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' \
    $("${compose[@]}" ps -q) | sed "s/^/$1\t/"
}

echo "[bench] fresh stack"
"${compose[@]}" down -v >/dev/null 2>&1 || true
"${compose[@]}" up -d --build >/dev/null
docker/scripts/smoke-minimal-deploy.sh "$base" -f docker/docker-compose.yml >/dev/null

token=$(curl -fs -X POST "$base/api/v1/auth/login" -H 'content-type: application/json' -H "x-heopress-site: $site" \
  -d '{"email":"smoke-admin@example.test","password":"Smoke-Test-Pass-1!"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

echo "[bench] seeding $items items"
seq 1 "$items" | xargs -P 8 -I{} curl -fs -o /dev/null -X POST "$base/api/v1/items/articles" \
  -H "authorization: Bearer $token" -H "x-heopress-site: $site" -H 'content-type: application/json' \
  -d '{"data":{"title":"站群运营指南 network content site {}"},"status":"published"}'
psql() { "${compose[@]}" exec -T postgres psql -U heopress -d heopress -tAc "$1"; }
ids=$(psql "SELECT string_agg(id, ',') FROM (SELECT id FROM lumibase_items WHERE site_id = '$site' ORDER BY random() LIMIT 200) s")
[ -n "$ids" ] || { echo "[bench] no items to read" >&2; exit 1; }

# Measure only once the worker has indexed every item: otherwise the search
# share reads an empty or partial index.
echo "[bench] waiting for the search index"
want=$(psql "SELECT count(*) FROM lumibase_items WHERE site_id = '$site'")
for _ in $(seq 1 120); do
  have=$(psql "SELECT count(*) FROM lumibase_search_documents")
  [ "$have" -ge "$want" ] && break
  sleep 2
done
[ "$have" -ge "$want" ] || { echo "[bench] search index has $have of $want documents" >&2; exit 1; }

echo "[bench] idle (60 s settle, then 3 samples)"
sleep 60
: > "$out/stats.tsv"
for _ in 1 2 3; do stats idle >> "$out/stats.tsv"; sleep 5; done

echo "[bench] 50 concurrent readers for 60 s"
( for _ in $(seq 1 10); do sleep 5; stats load >> "$out/stats.tsv"; done ) &
sampler=$!
# k6 exits non-zero when any request fails (thresholds in the script).
k6 run --quiet --summary-export "$out/k6.json" --env BASE_URL="$base" --env TOKEN="$token" --env ITEM_IDS="$ids" \
  apps/cms/k6/p03-read-baseline.js | tee "$out/k6.txt"
wait "$sampler"

echo "[bench] results in $out"
cat "$out/stats.tsv"
