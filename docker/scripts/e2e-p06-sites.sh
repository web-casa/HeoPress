#!/usr/bin/env bash
# Multi-site acceptance in a browser against the production images (HeoPress
# P06 task 7.4): starts the minimal deployment with the rendering service
# published on the host (docker-compose.sites.yml), runs first-run setup,
# creates two sites on free subdomains with their own starter themes and one
# article each, then runs packages/public-site/e2e/*.stack.ts in Chromium.
#
#   docker/scripts/e2e-p06-sites.sh [cms-port] [site-port] [compose args...]
#
# Runs as its own compose project (COMPOSE_PROJECT_NAME, default
# heopress-e2e-p06) on fresh volumes; builds the production images from this
# checkout (cached layers make this quick after a build). Both ports are bound
# to 127.0.0.1. Needs curl, node, pnpm.
set -euo pipefail
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-heopress-e2e-p06}"
case "$COMPOSE_PROJECT_NAME" in
  *e2e*) ;;
  *) echo "[e2e-sites] COMPOSE_PROJECT_NAME must name an e2e project (contain 'e2e'): its volumes are deleted" >&2; exit 1 ;;
esac

cms_port="${1:-1989}"
site_port="${2:-2027}"
shift 2 || true
base="http://127.0.0.1:$cms_port"
export CMS_PORT="$cms_port" SITE_PORT="$site_port"
export HEOPRESS_FREE_DOMAIN_SUFFIX="${HEOPRESS_FREE_DOMAIN_SUFFIX:-sites.example.test}"
compose=(docker compose -f docker/docker-compose.yml -f docker/docker-compose.sites.yml "$@")

fail() { echo "[e2e-sites] FAIL: $*" >&2; exit 1; }
step() { echo "[e2e-sites] $*"; }
# shellcheck source=lib-p06-sites.sh
. docker/scripts/lib-p06-sites.sh

step "starting the stack ($COMPOSE_PROJECT_NAME)"
"${compose[@]}" down -v >/dev/null
"${compose[@]}" up -d --build >/dev/null
docker/scripts/smoke-minimal-deploy.sh "$base" -f docker/docker-compose.yml -f docker/docker-compose.sites.yml "$@" >/dev/null

for pair in alpha:news beta:minimal; do
  name="${pair%%:*}" theme="${pair##*:}" id="e2e-${pair%%:*}"
  title="$(tr '[:lower:]' '[:upper:]' <<< "${name:0:1}")${name:1} first"
  step "site $id on $id.$HEOPRESS_FREE_DOMAIN_SUFFIX, theme $theme"
  new_site "$id" "E2E $name" "$theme"
  api POST /api/v1/items/articles "$id" "{\"data\":{\"title\":\"$title\",\"slug\":\"$name-first\",\"locale\":\"en\",\"excerpt\":\"About $title.\",\"body\":\"<p>$title body.</p>\"},\"status\":\"published\"}" >/dev/null
done

# A new site is served once its projection is built (the worker's rebuild job): wait for both homes.
step "waiting for both sites"
for id in e2e-alpha e2e-beta; do
  code=
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "host: $id.$HEOPRESS_FREE_DOMAIN_SUFFIX" "http://127.0.0.1:$site_port/" || true)
    [ "$code" = 200 ] && break
    sleep 2
  done
  [ "$code" = 200 ] || fail "$id answered $code"
done

step "browser"
# Each site's administrator token, for the tests' own publishing (site-bound: one per site).
alpha_token=$(login e2e-alpha)
beta_token=$(login e2e-beta)
[ -n "$alpha_token" ] && [ -n "$beta_token" ] || fail "no administrator token for the test sites"
HEOPRESS_E2E_SITE_PORT="$site_port" HEOPRESS_E2E_CMS_URL="$base" HEOPRESS_E2E_TOKEN_ALPHA="$alpha_token" HEOPRESS_E2E_TOKEN_BETA="$beta_token" \
  HEOPRESS_E2E_SUFFIX="$HEOPRESS_FREE_DOMAIN_SUFFIX" \
  pnpm --filter @heopress/public-site exec playwright test --config playwright.sites.config.ts
