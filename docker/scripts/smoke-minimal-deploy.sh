#!/usr/bin/env bash
# Smoke test for a freshly started minimal deployment (HeoPress P03 tasks
# 6.1, 7.2): readiness, first-run setup, content, media upload and an image
# transform from local storage, PostgreSQL search through the worker, and a
# scheduled job recorded by the worker.
#
#   docker/scripts/smoke-minimal-deploy.sh [base-url] [compose args...]
#
# Expects an empty database. Exits non-zero on the first failure.
set -euo pipefail

base="${1:-http://127.0.0.1:1989}"
shift || true
compose=(docker compose "$@")
site='__default__'
email='smoke-admin@example.test'
password='Smoke-Test-Pass-1!'
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "[smoke] FAIL: $*" >&2; exit 1; }
step() { echo "[smoke] $*"; }

step "waiting for readiness at $base"
for _ in $(seq 1 90); do
  if curl -fs "$base/health/ready" -o "$tmp/ready.json"; then break; fi
  sleep 2
done
[ -s "$tmp/ready.json" ] || fail "/health/ready never answered 200"
grep -q '"status":"healthy"' "$tmp/ready.json" || fail "not healthy: $(cat "$tmp/ready.json")"

step "a request before setup (caches 'unknown site')"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/v1/auth/login" -H 'content-type: application/json' -H "x-heopress-site: $site" -d '{"email":"nobody@example.test","password":"x"}')
[ "$code" = 404 ] || fail "pre-setup login answered $code, expected 404"

step "first-run setup"
policy='{"userMaxFailedAttempts":5,"userLockoutDurationSeconds":900,"ipMaxFailedAttempts":20,"ipLockoutDurationSeconds":3600,"lockoutWindowSeconds":900,"geoAnomalyEnabled":true,"timeAnomalyEnabled":false,"deviceAnomalyEnabled":true,"anomalyScoreThreshold":0.7,"anomalyAction":"notify_only","notifyChannels":["email"],"loginStallMs":500}'
code=$(curl -s -o "$tmp/setup.json" -w '%{http_code}' -X POST "$base/api/v1/setup/complete" -H 'content-type: application/json' \
  -d "{\"account\":{\"email\":\"$email\",\"password\":\"$password\",\"firstName\":\"Smoke\",\"lastName\":\"Test\"},\"adminPath\":\"/smoke-admin\",\"policy\":$policy,\"project\":{\"defaultLanguage\":\"zh\",\"siteUrl\":\"https://smoke.example.test\",\"displayTitle\":\"Smoke\"}}")
[ "$code" = 201 ] || fail "setup answered $code: $(cat "$tmp/setup.json")"

token=$(curl -fs -X POST "$base/api/v1/auth/login" -H 'content-type: application/json' -H "x-heopress-site: $site" \
  -d "{\"email\":\"$email\",\"password\":\"$password\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || fail "login right after setup returned no token"
auth=(-H "authorization: Bearer $token" -H "x-heopress-site: $site")

step "preset collection and published item"
# Setup installs the site network preset (P05): articles exist already.
code=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/v1/collections/articles" "${auth[@]}")
[ "$code" = 200 ] || fail "preset collection articles answered $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/v1/items/articles" "${auth[@]}" -H 'content-type: application/json' \
  -d '{"data":{"title":"站群运营指南","slug":"site-network-guide","locale":"zh"},"status":"published"}')
[ "$code" = 201 ] || fail "create item answered $code"

step "media upload, read back and preset-less transform refusal"
# 4x4 red PNG
echo 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==' | base64 -d > "$tmp/red.png"
code=$(curl -s -o "$tmp/up.json" -w '%{http_code}' -X POST "$base/api/v1/media/smoke/red.png" "${auth[@]}" -H 'content-type: image/png' --data-binary "@$tmp/red.png")
[ "$code" = 200 ] || [ "$code" = 201 ] || fail "upload answered $code: $(cat "$tmp/up.json")"
curl -fs "$base/api/v1/media/smoke/red.png" "${auth[@]}" -o "$tmp/back.png" || fail "media read failed"
cmp -s "$tmp/red.png" "$tmp/back.png" || fail "media read back different bytes"
code=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/v1/media/smoke/red.png?width=999" "${auth[@]}")
[ "$code" = 403 ] || fail "unsigned transform answered $code, expected 403"

step "search (PostgreSQL, indexed by the worker)"
found=''
for _ in $(seq 1 30); do
  if curl -fs "$base/api/v1/search?collection=articles&q=%E8%BF%90%E8%90%A5%E6%8C%87%E5%8D%97" "${auth[@]}" | grep -q '站群运营指南'; then found=1; break; fi
  sleep 2
done
[ -n "$found" ] || fail "the item never became searchable"

if [ "${#compose[@]}" -gt 2 ]; then
  step "scheduled jobs recorded by the worker"
  ran=''
  for _ in $(seq 1 45); do
    n=$("${compose[@]}" exec -T postgres psql -U heopress -d heopress -tAc "SELECT count(*) FROM lumibase_schedule_runs WHERE status = 'succeeded'" 2>/dev/null | tr -d '[:space:]')
    if [ "${n:-0}" -gt 0 ]; then ran=1; break; fi
    sleep 2
  done
  [ -n "$ran" ] || fail "no scheduled job slot succeeded"
  failed=$("${compose[@]}" exec -T postgres psql -U heopress -d heopress -tAc "SELECT count(*) FROM lumibase_schedule_runs WHERE status = 'failed'" | tr -d '[:space:]')
  [ "$failed" = 0 ] || fail "$failed scheduled job slot(s) failed"
fi

step "ok"
