#!/usr/bin/env bash
# Image runtime acceptance (HeoPress P13 task 6.2; docs/benchmarks/p13-image-runtime.md): the production images in
# the minimal deployment (PostgreSQL 18, API, worker, rendering service), checked from outside the processes.
#
#   0. database role   the CMS and the worker connect as the application role heopress_app, the rendering service as
#                      heopress_render: no superuser, not the tables' owner, row-level security applies (catalogue and
#                      a live probe on the server's own connection); no server keeps the owner's connection; a CMS
#                      given the owner's connection with HEOPRESS_REQUIRE_APP_ROLE=true refuses to start (S-5).
#                      Every later check (writes, search, jobs, sites, load) runs with these roles: the app works.
#   1. non-root        every process of every container runs as a non-root user
#   2. write scope     the CMS and the worker can write only their data directory and temporary directories; the
#                      rendering service's root file system is read-only
#   3. volumes         media, content, accounts and job history survive `docker compose down` and `up`
#   4. exit signals    SIGTERM (docker stop) ends every service cleanly: exit status 0, well before the kill — the
#                      worker also right after it starts
#   5. database outage PostgreSQL stopped: readiness 503, liveness 200, no process exits (a worker stopped meanwhile
#                      ends within its 10 s shutdown limit); PostgreSQL back: readiness 200, writes, search indexing
#                      and public pages work again, the API without a restart
#   6. task state      jobs queued while the worker is down wait, then run once it is back (backlog drains, results
#                      present); after a SIGKILL the worker restarts and processes new jobs; scheduled jobs resume
#   7. mixed load      public pages + Studio operations + event consumption + background jobs at once; records the
#                      CMS event-loop delay and memory, container memory, PostgreSQL connections and lock waits,
#                      readiness latency (includes the wait for a pooled connection), queue and event backlog
#                      (docker/scripts/accept-mixed-load.mjs)
#
#   docker/scripts/accept-image-runtime.sh
#
# Environment: COMPOSE_PROJECT_NAME (default heopress-accept; must contain "accept": its volumes are deleted),
# CMS_PORT / SITE_PORT / POSTGRES_PORT (host ports on 127.0.0.1; default 21989 / 22027 / 25432),
# HEOPRESS_CMS_IMAGE / HEOPRESS_SITE_IMAGE / HEOPRESS_DB_IMAGE (image tags), ACCEPT_SKIP_BUILD=true to use those
# images as they are, ACCEPT_LOAD_SECONDS (default 60), ACCEPT_OUT (results directory; default a new temporary
# one), ACCEPT_KEEP=true to leave the stack running. Needs docker compose, curl and node.
set -euo pipefail
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-heopress-accept}"
case "$COMPOSE_PROJECT_NAME" in
  *accept*) ;;
  *) echo "[accept] COMPOSE_PROJECT_NAME must name an acceptance project (contain 'accept'): its volumes are deleted" >&2; exit 1 ;;
esac

export CMS_PORT="${CMS_PORT:-21989}" SITE_PORT="${SITE_PORT:-22027}" POSTGRES_PORT="${POSTGRES_PORT:-25432}"
export HEOPRESS_FREE_DOMAIN_SUFFIX='accept.example.test'
export ACCEPT_METRICS_TOKEN="${ACCEPT_METRICS_TOKEN:-accept_metrics}"
base="http://127.0.0.1:$CMS_PORT"
sites_base="http://127.0.0.1:$SITE_PORT"
out="${ACCEPT_OUT:-$(mktemp -d)}"
mkdir -p -- "$out"
files=(-f docker/docker-compose.yml -f docker/docker-compose.sites.yml -f docker/docker-compose.accept.yml)
compose=(docker compose "${files[@]}")
results="$out/checks.tsv"
: > "$results"
current='setup'

fail() { echo "[accept] FAIL ($current): $*" >&2; printf '%s\tFAIL\t%s\n' "$current" "$*" >> "$results"; exit 1; }
step() { current="$1"; echo "[accept] $1: $2"; }
pass() { echo "[accept] PASS $current: $*"; printf '%s\tPASS\t%s\n' "$current" "$*" >> "$results"; }
# shellcheck source=lib-p06-sites.sh
. docker/scripts/lib-p06-sites.sh
# shellcheck source=lib-db-role.sh
. docker/scripts/lib-db-role.sh
# shellcheck disable=SC2034 # used by lib-db-role.sh
db_role_compose=("${compose[@]}")

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    "${compose[@]}" ps -a > "$out/ps.txt" 2>&1 || true
    "${compose[@]}" logs --no-color --tail=300 > "$out/logs.txt" 2>&1 || true
    echo "[accept] container states and logs in $out" >&2
  fi
  if [ "${ACCEPT_KEEP:-false}" != true ]; then "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
  echo "[accept] results in $out"
}
trap cleanup EXIT

cid() { "${compose[@]}" ps -aq "$1"; }
state() { docker inspect -f "$2" "$(cid "$1")"; }
code_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }
wait_for() { # seconds description command...
  local seconds="$1" what="$2"
  shift 2
  for _ in $(seq 1 "$seconds"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "$what: not within ${seconds}s"
}
ready() { [ "$(code_of "$base/health/ready")" = 200 ]; }
worker_ready() {
  "${compose[@]}" exec -T cms-worker node -e "fetch('http://127.0.0.1:1988/health/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}
worker_starting() { "${compose[@]}" logs --no-color --since "$1" cms-worker 2>&1 | grep -q 'Worker health server listening'; }
site_ok() { [ "$(code_of -H "host: accept-a.$HEOPRESS_FREE_DOMAIN_SUFFIX" "$sites_base/")" = 200 ]; }
searchable() { # site token word
  curl -fs "$base/api/v1/search?collection=articles&q=$3" -H "authorization: Bearer $2" -H "x-heopress-site: $1" | grep -q "$3"
}
create_article() { # site token title slug → item id
  curl -fsS -X POST "$base/api/v1/items/articles" -H "authorization: Bearer $2" -H "x-heopress-site: $1" -H 'content-type: application/json' \
    -d "{\"data\":{\"title\":\"$3\",\"slug\":\"$4\",\"locale\":\"en\",\"excerpt\":\"$3.\",\"body\":\"<p>$3</p>\"},\"status\":\"published\"}" | p06_json id
}

# ---------------------------------------------------------------------------------------------------------------
step setup "fresh stack ($COMPOSE_PROJECT_NAME)"
"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
if [ "${ACCEPT_SKIP_BUILD:-false}" = true ]; then
  "${compose[@]}" up -d --no-build >/dev/null
else
  "${compose[@]}" up -d --build >/dev/null
fi
docker/scripts/smoke-minimal-deploy.sh "$base" "${files[@]}" > "$out/smoke.txt" 2>&1 || { cat "$out/smoke.txt" >&2; fail "smoke test"; }
new_site accept-a "Accept A" news
token_a="$token"
new_site accept-b "Accept B" tech
token_b="$token"
for site in accept-a accept-b; do
  t="$token_a"; [ "$site" = accept-b ] && t="$token_b"
  seq 1 30 | xargs -P 6 -I{} curl -fsS -o /dev/null -X POST "$base/api/v1/items/articles" \
    -H "authorization: Bearer $t" -H "x-heopress-site: $site" -H 'content-type: application/json' \
    -d "{\"data\":{\"title\":\"$site article {}\",\"slug\":\"article-{}\",\"locale\":\"en\",\"excerpt\":\"Excerpt {}.\",\"body\":\"<p>Article {} of $site.</p>\"},\"status\":\"published\"}"
done
for _ in $(seq 1 120); do
  have=$(p06_psql "SELECT count(*) FROM lumibase_public_items i JOIN lumibase_public_sites s USING (site_id) WHERE i.site_id LIKE 'accept-%' AND i.collection = 'articles' AND s.built_at IS NOT NULL")
  [ "$have" -ge 60 ] && break
  sleep 2
done
[ "$have" -ge 60 ] || fail "public projection has $have of 60 articles"
wait_for 60 "site home page" site_ok
pass "smoke test, two sites with 30 articles each, public pages answer"

# ---------------------------------------------------------------------------------------------------------------
step db-role "the runtime connects as the application role; row-level security applies (security review S-5)"
check_runtime_db_roles
"${compose[@]}" logs --no-color cms 2>&1 | grep -F 'heopress_app: row-level security applies' >/dev/null || fail "the CMS entrypoint did not log its role check"
# The owner's connection as the server's (HEOPRESS_REQUIRE_APP_ROLE=true, as installed): startup stops before the
# server. The owner URL is the container's own (DATABASE_OWNER_URL); nothing is passed on the command line.
set +e
refused=$("${compose[@]}" run --rm --no-deps -e HEOPRESS_REQUIRE_APP_ROLE=true -e SKIP_MIGRATIONS=true -e HEOPRESS_SKIP_APP_ROLE=true \
  -e HEOPRESS_SKIP_RENDER_ROLE=true --entrypoint sh cms -c 'DATABASE_URL="$DATABASE_OWNER_URL" exec /entrypoint.sh' 2>&1)
code=$?
set -e
[ "$code" -ne 0 ] || fail "a CMS connected as the owner started with HEOPRESS_REQUIRE_APP_ROLE=true"
grep -qF 'row-level security does not apply to this connection (superuser)' <<<"$refused" || fail "the refusal did not name the reason: $(echo "$refused" | tail -3)"
! grep -qF 'Starting server' <<<"$refused" || fail "the server started as the owner"
pass "cms and cms-worker sessions are heopress_app only, site-classic heopress_render only, no owner session; RLS applies to the servers' connections (live probe); no owner URL or role password in their environment; the owner's connection with HEOPRESS_REQUIRE_APP_ROLE=true stops startup"

# ---------------------------------------------------------------------------------------------------------------
step non-root "every process of every container"
# The probe itself runs as nobody (65534): in the PostgreSQL image a plain exec would be root.
for svc in postgres cms cms-worker site-classic; do
  uids=$("${compose[@]}" exec -T --user 65534 "$svc" sh -c 'for f in /proc/[0-9]*/status; do sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" "$f"; done' | sort -u | tr '\n' ' ')
  [ -n "$uids" ] || fail "$svc: no process found"
  case " $uids" in *" 0 "*) fail "$svc runs a process as root (uids: $uids)" ;; esac
  echo "  $svc: process uids $uids"
done
# The application images declare their user: an exec, a restart or a one-off run is not root either.
for svc in cms cms-worker site-classic; do
  user=$("${compose[@]}" exec -T "$svc" id -un)
  [ "$user" = heopress ] || fail "$svc: image user is $user, expected heopress"
done
pass "postgres, cms, cms-worker and site-classic run no process as root; the application images run as heopress"

# ---------------------------------------------------------------------------------------------------------------
step write-scope "what the runtime user can write"
# On the root file system (-xdev: mounted volumes and tmpfs are checked separately).
allowed='^(/tmp|/var/tmp|/app/data|/app/data/storage|/run/lock|/var/lock|/dev/shm)(/.*)?$'
for svc in cms cms-worker; do
  writable=$("${compose[@]}" exec -T "$svc" sh -c 'find / -xdev \( -path /proc -o -path /sys \) -prune -o -writable -print 2>/dev/null' | grep -Ev "$allowed" || true)
  [ -z "$writable" ] || fail "$svc can write outside its data and temporary directories: $(echo "$writable" | head -5 | tr '\n' ' ')"
  "${compose[@]}" exec -T "$svc" sh -c 'f=/app/data/storage/.accept-probe; touch "$f" && rm "$f"' || fail "$svc cannot write its media volume"
  for path in /app/dist/serve.cjs /app/drizzle /app/studio /entrypoint.sh /usr/local/bin/node; do
    "${compose[@]}" exec -T "$svc" sh -c "test ! -w $path" || fail "$svc can write $path"
  done
done
# /tmp is the tmpfs mount point (its contents are on the tmpfs, outside -xdev).
writable=$("${compose[@]}" exec -T site-classic sh -c 'find / -xdev \( -path /proc -o -path /sys \) -prune -o -writable -print 2>/dev/null' | grep -Ev '^/tmp$' || true)
[ -z "$writable" ] || fail "site-classic can write its root file system: $(echo "$writable" | head -5 | tr '\n' ' ')"
"${compose[@]}" exec -T site-classic sh -c 'touch /app/.accept-probe 2>/dev/null' && fail "site-classic wrote /app"
"${compose[@]}" exec -T site-classic sh -c 'f=/tmp/.accept-probe; touch "$f" && rm "$f"' || fail "site-classic cannot write /tmp"
[ "$(state site-classic '{{.HostConfig.ReadonlyRootfs}}')" = true ] || fail "site-classic root file system is not read-only"
pass "cms and cms-worker write only /app/data (media volume) and temporary directories; site-classic only its /tmp tmpfs"

# ---------------------------------------------------------------------------------------------------------------
step volumes "down and up keep data"
token=$(login __default__)
auth=(-H "authorization: Bearer $token" -H 'x-heopress-site: __default__')
curl -fs "$base/api/v1/media/smoke/red.png" "${auth[@]}" -o "$out/media-before.png" || fail "media read before restart"
items_before=$(p06_psql "SELECT count(*) FROM lumibase_items WHERE site_id LIKE 'accept-%'")
runs_before=$(p06_psql "SELECT count(*) FROM lumibase_schedule_runs")
for svc in cms cms-worker; do
  mounts=$(state "$svc" '{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}')
  case "$mounts" in *volume:/app/data/storage*) ;; *) fail "$svc has no media volume at /app/data/storage ($mounts)" ;; esac
done
case "$(state postgres '{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}')" in *volume:/var/lib/postgresql*) ;; *) fail "postgres has no data volume" ;; esac
"${compose[@]}" down >/dev/null
"${compose[@]}" up -d --no-build >/dev/null
wait_for 120 "readiness after down/up" ready
token=$(login __default__)
[ -n "$token" ] || fail "the administrator cannot log in after down/up"
auth=(-H "authorization: Bearer $token" -H 'x-heopress-site: __default__')
curl -fs "$base/api/v1/media/smoke/red.png" "${auth[@]}" -o "$out/media-after.png" || fail "media read after down/up"
cmp -s "$out/media-before.png" "$out/media-after.png" || fail "media changed across down/up"
items_after=$(p06_psql "SELECT count(*) FROM lumibase_items WHERE site_id LIKE 'accept-%'")
runs_after=$(p06_psql "SELECT count(*) FROM lumibase_schedule_runs")
[ "$items_after" = "$items_before" ] || fail "items $items_before before, $items_after after"
[ "$runs_after" -ge "$runs_before" ] || fail "job history shrank ($runs_before → $runs_after)"
wait_for 60 "site home page after down/up" site_ok
pass "media bytes, $items_after items, the administrator account and $runs_before job runs survive down/up"

# ---------------------------------------------------------------------------------------------------------------
step signals "SIGTERM ends each service cleanly"
wait_for 120 "worker readiness before the signal check" worker_ready
for svc in cms-worker site-classic cms; do
  started=$(date +%s)
  "${compose[@]}" stop -t 30 "$svc" >/dev/null
  took=$(( $(date +%s) - started ))
  code=$(state "$svc" '{{.State.ExitCode}}')
  [ "$code" = 0 ] || fail "$svc exited with $code after SIGTERM (137 = killed after the grace period)"
  [ "$took" -lt 20 ] || fail "$svc took ${took}s to stop"
  case "$svc" in cms|cms-worker)
    "${compose[@]}" logs --no-color "$svc" 2>&1 | tail -50 | grep -q 'SIGTERM received' || fail "$svc did not log its shutdown" ;;
  esac
  echo "  $svc: exit 0 after ${took}s"
done
# A worker stopped while it starts: the server (PID 1 after the entrypoint's exec) is up, its jobs not all
# registered yet — before the graceful handler exists. (A signal during the first moment, while Node loads the
# bundle and no handler exists at all, is still lost to PID 1 semantics: see docs/benchmarks/p13-image-runtime.md.)
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"${compose[@]}" start cms-worker >/dev/null
wait_for 60 "the worker to start its health server" worker_starting "$since"
started=$(date +%s)
"${compose[@]}" stop -t 30 cms-worker >/dev/null
took=$(( $(date +%s) - started ))
code=$(state cms-worker '{{.State.ExitCode}}')
[ "$code" = 0 ] && [ "$took" -lt 20 ] || fail "cms-worker stopped during startup: exit $code after ${took}s"
how=$("${compose[@]}" logs --no-color --since "$since" cms-worker 2>&1 | grep -o 'SIGTERM received[a-z ,]*' | tail -1)
echo "  cms-worker during startup: exit 0 after ${took}s (${how:-no shutdown line})"
"${compose[@]}" up -d --no-build >/dev/null
wait_for 120 "readiness after the signal check" ready
wait_for 120 "worker readiness after the signal check" worker_ready
wait_for 60 "site home page after the signal check" site_ok
pass "cms-worker, site-classic and cms exit 0 on SIGTERM well inside the 30 s grace period, the worker also while it starts, and come back"

# ---------------------------------------------------------------------------------------------------------------
step db-outage "PostgreSQL temporarily unavailable"
token=$(login accept-a)
declare -A started_before
for svc in cms cms-worker site-classic; do started_before[$svc]=$(state "$svc" '{{.State.StartedAt}}/{{.RestartCount}}'); done
"${compose[@]}" stop -t 30 postgres >/dev/null
[ "$(state postgres '{{.State.ExitCode}}')" = 0 ] || fail "postgres did not shut down cleanly"
wait_for 30 "readiness to report the outage" sh -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 $base/health/ready)\" = 503 ]"
[ "$(code_of "$base/health/live")" = 200 ] || fail "liveness failed during the outage"
code=$(code_of -X POST "$base/api/v1/items/articles" -H "authorization: Bearer $token" -H 'x-heopress-site: accept-a' -H 'content-type: application/json' -d '{"data":{"title":"x"}}')
case "$code" in 5*) ;; *) fail "a write during the outage answered $code, expected a 5xx" ;; esac
# Long enough for scheduled jobs, queue polling and event consumers to hit the outage.
sleep 45
for svc in cms cms-worker site-classic; do
  [ "$(state "$svc" '{{.State.Running}}')" = true ] || fail "$svc stopped during the outage"
done
for svc in cms cms-worker site-classic; do
  [ "$(state "$svc" '{{.State.StartedAt}}/{{.RestartCount}}')" = "${started_before[$svc]}" ] || fail "$svc restarted during the outage"
done
# The worker stopped during the outage: its graceful shutdown cannot flush to the database, gives up after 10 s
# (logged, exit 1) — bounded, never the 30 s kill. Started again, it waits for the database.
t0=$(date +%s)
"${compose[@]}" stop -t 30 cms-worker >/dev/null
took=$(( $(date +%s) - t0 ))
code=$(state cms-worker '{{.State.ExitCode}}')
case "$code" in
  0) ;;
  1) "${compose[@]}" logs --no-color --tail=20 cms-worker 2>&1 | grep -q 'Graceful shutdown timed out' || fail "cms-worker exited 1 without its shutdown timeout" ;;
  *) fail "cms-worker stopped during the outage with exit $code" ;;
esac
[ "$took" -lt 20 ] || fail "cms-worker took ${took}s to stop during the outage"
echo "  cms-worker stopped during the outage: exit $code after ${took}s"
"${compose[@]}" start cms-worker >/dev/null
back=$(date +%s)
"${compose[@]}" start postgres >/dev/null
wait_for 120 "readiness after PostgreSQL is back" ready
wait_for 120 "worker readiness after PostgreSQL is back" worker_ready
recovered=$(( $(date +%s) - back ))
# The API and the rendering service rode out the outage in the same process (the worker was restarted on purpose above).
for svc in cms site-classic; do
  [ "$(state "$svc" '{{.State.StartedAt}}/{{.RestartCount}}')" = "${started_before[$svc]}" ] || fail "$svc restarted during the outage"
done
id=$(create_article accept-a "$token" 'Outagerecovered' outage-recovered)
[ -n "$id" ] || fail "no write after the outage"
wait_for 120 "search indexing after the outage" searchable accept-a "$token" Outagerecovered
wait_for 60 "site home page after the outage" site_ok
pass "readiness 503 and liveness 200 during the outage, writes refused; no process exited; a worker stopped meanwhile ends within its 10 s shutdown limit; API and worker ready again ${recovered}s after PostgreSQL started, then writing and indexing, the API without a restart"

# ---------------------------------------------------------------------------------------------------------------
step task-state "jobs across worker restarts"
stop_at=$(p06_psql "SELECT now()")
"${compose[@]}" stop -t 30 cms-worker >/dev/null
for i in $(seq 1 10); do create_article accept-a "$token" "Queuedwhiledown$i" "queued-$i" >/dev/null; done
restart_at=$(p06_psql "SELECT now()")
# Jobs queued while the worker was down: due now, waiting (no process takes them).
down_jobs="FROM pgboss.job WHERE created_on > '$stop_at' AND created_on < '$restart_at' AND start_after <= now()"
queued=$(p06_psql "SELECT count(*) $down_jobs")
[ "$queued" -gt 0 ] || fail "no job queued while the worker was down"
waiting=$(p06_psql "SELECT count(*) $down_jobs AND state IN ('created', 'retry')")
[ "$waiting" = "$queued" ] || fail "$((queued - waiting)) of $queued jobs ran without a worker"
"${compose[@]}" start cms-worker >/dev/null
wait_for 180 "the jobs queued while the worker was down to complete" sh -c "[ \"\$(docker compose ${files[*]} exec -T postgres psql -U heopress -d heopress -tAc \"SELECT count(*) $down_jobs AND state <> 'completed'\")\" = 0 ]"
for i in $(seq 1 10); do wait_for 30 "item $i searchable after the restart" searchable accept-a "$token" "Queuedwhiledown$i"; done
wait_for 150 "a scheduled job after the restart" sh -c "[ \"\$(docker compose ${files[*]} exec -T postgres psql -U heopress -d heopress -tAc \"SELECT count(*) FROM lumibase_schedule_runs WHERE status = 'succeeded' AND started_at > '$restart_at'\")\" -gt 0 ]"
docker kill -s KILL "$(cid cms-worker)" >/dev/null
"${compose[@]}" start cms-worker >/dev/null
wait_for 120 "worker readiness after SIGKILL" worker_ready
kill_at=$(p06_psql "SELECT now()")
create_article accept-a "$token" 'Afterworkerkill' after-kill >/dev/null
after_kill="FROM pgboss.job WHERE created_on > '$kill_at' AND start_after <= now()"
[ "$(p06_psql "SELECT count(*) $after_kill")" -gt 0 ] || fail "no job queued after the SIGKILL"
wait_for 120 "jobs after SIGKILL to complete" sh -c "[ \"\$(docker compose ${files[*]} exec -T postgres psql -U heopress -d heopress -tAc \"SELECT count(*) $after_kill AND state <> 'completed'\")\" = 0 ]"
wait_for 60 "search after SIGKILL" searchable accept-a "$token" Afterworkerkill
pass "$queued jobs queued while the worker was stopped waited, then all completed once it was back; scheduled jobs resumed; after SIGKILL the worker restarts and processes new jobs"

# ---------------------------------------------------------------------------------------------------------------
step mixed-load "front + Studio + events + background jobs"
token_a=$(login accept-a)
token_b=$(login accept-b)
p06_psql "SELECT h.hostname || ' ' || i.path || CASE WHEN right(i.path, 1) = '/' THEN '' ELSE '/' END FROM lumibase_public_items i JOIN lumibase_public_hosts h ON h.site_id = i.site_id AND h.is_primary
      WHERE i.site_id LIKE 'accept-%' AND i.collection = 'articles'" > "$out/pages.txt"
for s in accept-a accept-b; do echo "$s.$HEOPRESS_FREE_DOMAIN_SUFFIX /"; done >> "$out/pages.txt"
ACCEPT_TOKENS="accept-a=$token_a accept-b=$token_b" node docker/scripts/accept-mixed-load.mjs \
  --cms "$base" --sites "$sites_base" --pages "$out/pages.txt" --out "$out/mixed-load.json" \
  --seconds "${ACCEPT_LOAD_SECONDS:-60}" --compose "docker compose ${files[*]}" > "$out/mixed-load.txt" 2>&1 \
  || { tail -40 "$out/mixed-load.txt" >&2; fail "mixed load"; }
for svc in cms cms-worker site-classic postgres; do
  [ "$(state "$svc" '{{.State.Running}}')" = true ] || fail "$svc stopped under load"
done
pass "no request error, every Studio write accepted, backlogs drained (details: mixed-load.json)"

echo "[accept] all checks passed"
cat "$results"
