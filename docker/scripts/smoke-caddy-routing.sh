#!/usr/bin/env bash
# The production Caddy routing of a site network (HeoPress P06 task 5.2; design R10): runs
# docker/Caddyfile.domains in the Caddy image, with stand-ins for the CMS (which also answers the
# certificate gate) and the rendering service that echo who answered and the path, and checks over
# HTTPS which service each host and path reaches:
#
#   - the administration host → the CMS;
#   - a site's domain and the preview origin → the rendering service;
#   - /admin, /api and /internal on a site's domain → 404 at the edge, never forwarded anywhere;
#   - /_ext/<plugin>/<endpoint> on a site's domain → the CMS (plugin public endpoints, HeoPress P12);
#   - /internal on the administration host → 404;
#   - a name the certificate gate refuses gets no certificate (no TLS handshake).
#
#   docker/scripts/smoke-caddy-routing.sh
#
# Needs Docker and curl. Certificates come from Caddy's local CA (the only change made to the
# file under test), so nothing reaches a public ACME CA. Exits non-zero on the first failure.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
image="${CADDY_IMAGE:-caddy:2-alpine}"
run="hp-caddy-smoke-$$"
tmp="$(mktemp -d)"
cleanup() {
  docker rm -f "$run-edge" "$run-cms" "$run-site" >/dev/null 2>&1 || true
  docker network rm "$run" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

ADMIN=admin.example.test
SITE=site.example.test
PREVIEW=preview.example.test

# The file under test, with Caddy's local CA instead of ACME.
sed '0,/^{$/s//{\n\tlocal_certs/' "$here/../Caddyfile.domains" > "$tmp/Caddyfile"
grep -q 'local_certs' "$tmp/Caddyfile"

# The CMS: the certificate gate knows the site and the preview origin; everything else echoes.
cat > "$tmp/cms" <<EOF
:1989 {
	@known {
		path /internal/tls/ask
		expression {query.domain} == "$SITE" || {query.domain} == "$PREVIEW"
	}
	header X-Smoke-Backend cms
	respond @known "ok" 200
	respond /internal/tls/ask "unknown domain" 404
	respond "cms {path}" 200
}
EOF
cat > "$tmp/site" <<'EOF'
:2027 {
	header X-Smoke-Backend site-classic
	respond "site-classic {path}" 200
}
EOF

docker network create "$run" >/dev/null
docker run -d --name "$run-cms" --network "$run" --network-alias cms -v "$tmp/cms:/etc/caddy/Caddyfile:ro" "$image" >/dev/null
docker run -d --name "$run-site" --network "$run" --network-alias site-classic -v "$tmp/site:/etc/caddy/Caddyfile:ro" "$image" >/dev/null
docker run -d --name "$run-edge" --network "$run" -p 127.0.0.1::443 \
  -e PUBLIC_DOMAIN="$ADMIN" -e ACME_EMAIL=ops@example.test \
  -v "$tmp/Caddyfile:/etc/caddy/Caddyfile:ro" "$image" >/dev/null
port="$(docker port "$run-edge" 443/tcp | head -1 | sed 's/.*://')"

# GET https://<host><path> through the edge: "<status> <body>", or "tls-failed".
get() {
  local host="$1" path="$2" out
  if out="$(curl -sk --path-as-is --max-time 10 --resolve "$host:$port:127.0.0.1" -w ' %{http_code}' "https://$host:$port$path")"; then
    printf '%s %s' "${out##* }" "${out% *}"
  else
    printf 'tls-failed'
  fi
}
fails=0
# Whatever the service answers, it is not the CMS: an encoded slash or backslash reaches the rendering
# service as a path it refuses itself; the CMS stand-in (its X-Smoke-Backend header, HEAD included)
# must never answer.
expect_not_cms() {
  local host="$1" path="$2" method="${3:-GET}" head
  local how=(-X "$method")
  [ "$method" = HEAD ] && how=(-I)
  if ! head="$(curl -sk --path-as-is "${how[@]}" -o /dev/null -D - --max-time 10 --resolve "$host:$port:127.0.0.1" "https://$host:$port$path")"; then
    echo "FAIL $method $host$path → no answer"; fails=$((fails + 1)); return
  fi
  local status backend
  status="$(printf '%s' "$head" | sed -n '1s/^HTTP[^ ]* \([0-9]*\).*/\1/p')"
  backend="$(printf '%s' "$head" | tr -d '\r' | sed -n 's/^[Xx]-[Ss]moke-[Bb]ackend: //p')"
  if [ "$backend" = cms ]; then
    echo "FAIL $method $host$path → $status from the CMS"; fails=$((fails + 1))
  else
    echo "ok   $method $host$path → $status ${backend:-edge}"
  fi
}
expect() {
  local host="$1" path="$2" want="$3" got
  got="$(get "$host" "$path")"
  if [ "$got" = "$want" ]; then
    echo "ok   $host$path → $got"
  else
    echo "FAIL $host$path → '$got', expected '$want'"
    fails=$((fails + 1))
  fi
}

# Wait for the edge (the admin certificate is issued at startup by the local CA).
for _ in $(seq 1 30); do
  [ "$(get "$ADMIN" /)" = "200 cms /" ] && break
  sleep 1
done

expect "$ADMIN" / "200 cms /"
expect "$ADMIN" /admin/login "200 cms /admin/login"
expect "$ADMIN" /api/v1/items "200 cms /api/v1/items"
expect "$ADMIN" /internal/tls/ask "404 "
expect "$SITE" / "200 site-classic /"
expect "$SITE" /2026/hello/ "200 site-classic /2026/hello/"
expect "$SITE" /admin "404 "
expect "$SITE" /admin/login "404 "
expect "$SITE" /ADMIN/x "404 "
expect "$SITE" /api "404 "
expect "$SITE" /api/v1/items "404 "
expect "$SITE" /internal/tls/ask "404 "
expect "$SITE" /internal/preview/resolve "404 "
# The same paths spelled differently: escapes, case, dot segments, doubled and trailing slashes.
expect "$SITE" /admin/ "404 "
expect "$SITE" /api/ "404 "
expect "$SITE" /internal/ "404 "
expect "$SITE" /%61dmin "404 "
expect "$SITE" /%41PI/v1/items "404 "
expect "$SITE" /%69nternal/tls/ask "404 "
expect "$SITE" //admin "404 "
expect "$SITE" /x/../admin "404 "
expect "$SITE" /./api/v1/items "404 "
expect "$SITE" /x/%2e%2e/admin "404 "
# Plugin public endpoints (HeoPress P12): only the reserved prefix reaches the CMS.
expect "$SITE" /_ext/linkcheck/subscribe "200 cms /_ext/linkcheck/subscribe"
expect "$SITE" /_ext/../admin "404 "
expect "$SITE" /_ext/../api/v1/items "404 "
expect "$SITE" /_extras/page "200 site-classic /_extras/page"
expect "$PREVIEW" /site_a/view "200 site-classic /site_a/view"
expect "$PREVIEW" /api/v1/items "404 "
expect "$PREVIEW" /admin "404 "
expect "$PREVIEW" /internal/preview/resolve "404 "
for path in /%2fadmin /%2Fapi/v1/items /%5cadmin /%252fadmin /%2561dmin; do
  expect_not_cms "$SITE" "$path"
done
for method in POST PUT DELETE HEAD; do
  expect_not_cms "$SITE" /admin "$method"
  expect_not_cms "$SITE" /api/v1/items "$method"
  expect_not_cms "$PREVIEW" /internal/preview/resolve "$method"
done
expect unknown.example.test / "tls-failed"

if [ "$fails" -ne 0 ]; then
  echo "$fails routing check(s) failed"
  docker logs "$run-edge" 2>&1 | tail -40
  exit 1
fi
echo "Caddy routing: all checks passed"
