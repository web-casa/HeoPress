#!/usr/bin/env bash
# Start a throwaway container from the HeoPress database image and check that
# the extensions load and work (P03 task 1.1).
#
#   docker/postgres/verify-extensions.sh <image> [platform]
#
# Exits non-zero on any failure. The container is removed afterwards.
set -euo pipefail

image="${1:?usage: verify-extensions.sh <image> [platform]}"
platform="${2:-}"
name="heopress-pg-verify-$$"

run_args=(-d --name "$name" -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify)
if [[ -n "$platform" ]]; then run_args+=(--platform "$platform"); fi

docker run "${run_args[@]}" "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 120); do
  if docker exec "$name" pg_isready -U verify -q 2>/dev/null; then break; fi
  sleep 1
done
# pg_isready can answer during the init restart; wait for a real query.
for _ in $(seq 1 60); do
  if docker exec "$name" psql -U verify -d verify -tAc 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done

psql() { docker exec -i "$name" psql -U verify -d verify -v ON_ERROR_STOP=1 -tA "$@"; }

psql <<'SQL'
CREATE EXTENSION vector;
CREATE EXTENSION zhparser;
CREATE EXTENSION pg_trgm;
CREATE TEXT SEARCH CONFIGURATION verify_zh (PARSER = zhparser);
ALTER TEXT SEARCH CONFIGURATION verify_zh ADD MAPPING FOR n,v,a,i,e,l WITH simple;
SQL

tokens="$(psql -c "SELECT to_tsvector('verify_zh', '内容管理系统支持中文全文检索')::text")"
echo "zhparser: $tokens"
[[ "$tokens" == *"'内容'"* ]] || { echo "zhparser did not segment Chinese text" >&2; exit 1; }

dist="$(psql -c "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector")"
echo "pgvector distance: $dist"
[[ "$dist" == "1" ]] || { echo "unexpected pgvector distance: $dist" >&2; exit 1; }

echo "ok: vector, zhparser, pg_trgm (${platform:-native})"
