#!/usr/bin/env bash
# Acceptance of an installation made by docker/install.sh (HeoPress P13 tasks 3.1, 3.4), run as root on the
# installed server right after the installer, with the installer's own arguments after `--`:
#
#   sudo docker/scripts/accept-install.sh /opt/heopress -- --admin-domain admin.example.test --tls internal \
#     --extra-compose docker/docker-compose.install-test.yml [the other installer arguments…]
#
# The installation must use --tls internal and docker/docker-compose.install-test.yml (free test subdomains). Checks:
#   - only PostgreSQL, the CMS, the worker, the rendering service and Caddy run (no other stateful service);
#   - readiness through Caddy on the administration domain; the administrator signs in with the generated
#     credentials; the Studio answers on the private admin path of the administration domain; setup is closed;
#   - a site on its own domain is served by the rendering service through Caddy, and on that domain the
#     administration is unreachable: /admin, /api, /setup, /internal and the private admin path answer 404 and
#     never the Studio; /internal is 404 on the administration domain as well; an unknown name gets no certificate;
#   - the database roles (security review S-5): the CMS and the worker connect as the application role heopress_app,
#     the rendering service as heopress_render — no superuser, not the tables' owner, row-level security applies
#     (catalogue and a live probe on the servers' own connections); no server keeps the owner's connection; the
#     installation requires it (HEOPRESS_REQUIRE_APP_ROLE=true); checked after everything above (setup, login, a site,
#     publishing, serving) ran with these roles;
#   - secrets: the configuration and the credentials are root-only files; no generated secret, password, backup
#     code or the private admin path appears in the install log or in any service's log;
#   - running the installer again exits 3 and changes nothing (files, containers and data are the same).
#
# Prints check names and counts only — never a secret. Exits non-zero on the first failure.
set -euo pipefail

dir="${1:?usage: accept-install.sh <install-dir> -- <installer arguments>}"
shift
[ "${1:-}" = -- ] || { echo 'usage: accept-install.sh <install-dir> -- <installer arguments>' >&2; exit 2; }
shift
installer_args=("$@")
here="$(cd "$(dirname "$0")" && pwd)"
installer="$here/../install.sh"
log_file="${HEOPRESS_INSTALL_LOG:-/var/log/heopress-install.log}"
compose="$dir/heopress-compose"
out="${ACCEPT_OUT:-$(mktemp -d)}"
mkdir -p -- "$out"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

fail() { echo "[accept-install] FAIL: $*" >&2; exit 1; }
step() { echo "[accept-install] $*"; }
[ "$(id -u)" = 0 ] || fail 'run as root'
[ -x "$compose" ] && [ -f "$dir/heopress.conf" ] && [ -f "$dir/.env" ] || fail "no installation in $dir"

# Settings without printing them: one value of an env-style file.
value_of() { sed -n "s/^$2=//p" "$1" | head -1; }
admin_domain="$(value_of "$dir/heopress.conf" admin_domain)"
https_port="$(value_of "$dir/.env" HEOPRESS_HTTPS_PORT)"
credentials="$dir/secrets/admin-credentials"
[ -n "$admin_domain" ] && [ -n "$https_port" ] || fail 'the installation has no administration domain or HTTPS port'
suffix='sites.example.test'
site_id='accept-site'
site_host="$site_id.$suffix"

# HTTPS through Caddy (its local CA, hence -k), any host name resolved to this machine.
req() { # host method path [curl args…] → "<status>" (body in $tmp/body)
  local host="$1" method="$2" path="$3"
  shift 3
  curl -sk --path-as-is --max-time 20 -o "$tmp/body" -w '%{http_code}' -X "$method" \
    --resolve "$host:$https_port:127.0.0.1" "https://$host:$https_port$path" "$@" || true
}
json_field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$tmp/body" | head -1; }

step 'services: PostgreSQL, CMS, worker, rendering service and Caddy only, all running'
services="$("$compose" ps --services --status running | sort | tr '\n' ' ')"
[ "$services" = 'caddy cms cms-worker postgres site-classic ' ] || fail "running services: $services"
all="$("$compose" ps -a --services | sort | tr '\n' ' ')"
[ "$all" = "$services" ] || fail "other services exist: $all"
"$compose" ps --format '{{.Service}}\t{{.State}}\t{{.Status}}' > "$out/services.tsv"
stats() { local ids; mapfile -t ids < <("$compose" ps -q); docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' "${ids[@]}"; }
stats > "$out/stats-after-install.tsv"

step 'files: configuration and credentials readable by root only'
for f in "$dir/.env" "$credentials"; do
  [ "$(stat -c '%a %U' "$f")" = '600 root' ] || fail "$f is $(stat -c '%a %U' "$f"), expected 600 root"
done
[ "$(stat -c '%a %U' "$dir/secrets")" = '700 root' ] || fail "$dir/secrets is not 700 root"
[ "$(stat -c '%a' "$log_file")" = 600 ] || fail "$log_file is not 600"

step 'readiness through Caddy on the administration domain'
code="$(req "$admin_domain" GET /health/ready)"
[ "$code" = 200 ] || fail "/health/ready answered $code"
grep -q '"status":"healthy"' "$tmp/body" || fail 'readiness is not healthy'

step 'the administrator signs in with the generated credentials'
email="$(value_of "$credentials" email)"
login_url="$(value_of "$credentials" login_url)"
admin_path="/${login_url#https://*/}"
admin_path="${admin_path%/}"
[[ "$admin_path" =~ ^/[a-z0-9-]+$ ]] || fail 'the credentials file has no private admin path'
login() { # site → token in $token
  { printf '{"email":"%s","password":"' "$email"; value_of "$credentials" password | tr -d '\n'; printf '"}'; } > "$tmp/login.json"
  code="$(req "$admin_domain" POST /api/v1/auth/login -H 'content-type: application/json' -H "x-heopress-site: $1" --data-binary "@$tmp/login.json")"
  rm -f -- "$tmp/login.json"
  [ "$code" = 200 ] || fail "login to $1 answered $code"
  token="$(json_field token)"
  [ -n "$token" ] || fail "login to $1 returned no token"
}
login __default__
api() { # method path site [json] → status (body in $tmp/body)
  req "$admin_domain" "$1" "$2" -H "authorization: Bearer $token" -H "x-heopress-site: $3" -H 'content-type: application/json' ${4:+--data-binary "$4"}
}

step 'the Studio on the private admin path of the administration domain; setup closed'
code="$(req "$admin_domain" GET "$admin_path/")"
[ "$code" = 200 ] || fail "the Studio answered $code on the private admin path"
grep -qi '<div id="root"' "$tmp/body" || fail 'the private admin path did not serve the Studio'
studio_marker="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "$tmp/body" | head -1 || true)"
code="$(req "$admin_domain" GET /api/v1/setup/capabilities)"
[ "$code" = 404 ] || fail "the setup wizard answered $code after installation (expected 404)"

step "a site on its own domain ($site_host), served by the rendering service through Caddy"
code="$(api POST /api/v1/instance/sites __default__ "{\"id\":\"$site_id\",\"name\":\"Accept Site\"}")"
[ "$code" = 201 ] || [ "$code" = 200 ] || fail "creating the site answered $code"
login "$site_id"
code="$(api POST /api/v1/domains "$site_id" "{\"kind\":\"subdomain\",\"hostname\":\"$site_id\"}")"
[ "$code" = 201 ] || [ "$code" = 200 ] || fail "adding the domain answered $code"
domain_id="$(json_field id)"
code="$(api POST "/api/v1/domains/$domain_id/primary" "$site_id")"
[ "$code" = 200 ] || fail "making the domain primary answered $code"
code="$(api POST /api/v1/themes/starters/news "$site_id")"
[ "$code" = 201 ] || [ "$code" = 200 ] || fail "installing the starter theme answered $code"
version_id="$(json_field id)"
code="$(api POST "/api/v1/themes/versions/$version_id/activate" "$site_id")"
[ "$code" = 200 ] || fail "activating the theme answered $code"
code="$(api POST /api/v1/items/articles "$site_id" '{"data":{"title":"Installed","slug":"installed","locale":"en","excerpt":"Installed by the installer.","body":"<p>Installed.</p>"},"status":"published"}')"
[ "$code" = 201 ] || fail "publishing an article answered $code"
psql_q() { "$compose" exec -T postgres psql -U heopress -d heopress -v ON_ERROR_STOP=1 -tAc "$1"; }
article_path=''
for _ in $(seq 1 60); do
  article_path="$(psql_q "SELECT path FROM lumibase_public_items WHERE site_id = '$site_id' AND collection = 'articles'")"
  [ -n "$article_path" ] && break
  sleep 2
done
[ -n "$article_path" ] || fail 'the article never reached the public projection'
article_path="${article_path%/}/"
for path in / "$article_path"; do
  code=000
  for _ in $(seq 1 60); do
    code="$(req "$site_host" GET "$path")"
    [ "$code" = 200 ] && break
    sleep 2
  done
  [ "$code" = 200 ] || fail "$site_host$path answered $code"
done
grep -q 'Installed' "$tmp/body" || fail 'the article page does not show the article'

step 'no administration on the site domain; /internal nowhere; no certificate for an unknown name'
is_studio() { grep -qi '<div id="root"' "$tmp/body" || { [ -n "$studio_marker" ] && grep -qF "$studio_marker" "$tmp/body"; }; }
for path in /admin /admin/ /admin/login /api /api/v1/items/articles /api/v1/auth/login /setup /api/v1/setup/state \
  "/internal/tls/ask?domain=$site_host" "$admin_path" "$admin_path/" "$admin_path/login" /health/ready /metrics; do
  code="$(req "$site_host" GET "$path")"
  [ "$code" = 404 ] || fail "$site_host answered $code for an administration path (expected 404)"
  ! is_studio || fail "$site_host served the Studio for an administration path"
done
code="$(req "$site_host" POST /api/v1/auth/login -H 'content-type: application/json' --data-binary '{}')"
[ "$code" = 404 ] || fail "$site_host answered $code to a login POST (expected 404)"
code="$(req "$admin_domain" GET "/internal/tls/ask?domain=$site_host")"
[ "$code" = 404 ] || fail "/internal answered $code on the administration domain"
code="$(req nobody.example.org GET /)"
[ "$code" = 000 ] || fail "an unknown name answered $code (expected no TLS handshake)"

# After a site was served: the rendering service connects lazily, on its first request.
step 'database roles: the runtime connects as the application role; row-level security applies (security review S-5)'
[ "$(value_of "$dir/.env" HEOPRESS_REQUIRE_APP_ROLE)" = true ] || fail 'the installation does not require the application role'
# shellcheck disable=SC2034 # used by lib-db-role.sh
db_role_compose=("$compose")
# shellcheck source=lib-db-role.sh
. "$here/lib-db-role.sh"
check_runtime_db_roles
"$compose" logs --no-color cms 2>&1 | grep -F 'heopress_app: row-level security applies' >/dev/null || fail 'the CMS entrypoint did not log its role check'

step 'secrets in no log (install log and every service log)'
patterns="$tmp/patterns"
: > "$patterns"
for key in POSTGRES_PASSWORD HEOPRESS_APP_PASSWORD JWT_SECRET ENCRYPTION_KEY HEOPRESS_RENDER_PASSWORD HEOPRESS_INTERNAL_SECRET; do
  v="$(value_of "$dir/.env" "$key")"
  [ "${#v}" -ge 16 ] || fail "$key is missing or short"
  printf '%s\n' "$v" >> "$patterns"
done
v="$(value_of "$credentials" password)"
[ "${#v}" -ge 16 ] || fail 'the administrator password is missing or short'
printf '%s\n' "$v" >> "$patterns"
sed -n 's/^  \(.\{6,\}\)$/\1/p' "$credentials" >> "$patterns"
[ "$(wc -l < "$patterns")" -ge 8 ] || fail 'no backup codes in the credentials file'
printf '%s\n' "$admin_path" >> "$patterns"
"$compose" logs --no-color --no-log-prefix > "$tmp/services.log" 2>&1
for f in "$log_file" "$tmp/services.log"; do
  n="$(grep -c -F -f "$patterns" "$f" || true)"
  [ "$n" = 0 ] || fail "$n line(s) of $(basename "$f") contain a secret or the private admin path"
done
wc -l < "$tmp/services.log" | sed 's/^/[accept-install]   service log lines checked: /'
rm -f -- "$patterns" "$tmp/services.log"

step 'running the installer again changes nothing (exit 3)'
snapshot() {
  sha256sum "$dir/.env" "$credentials" "$dir/heopress.conf" "$compose"
  "$compose" ps -q | sort
  psql_q 'SELECT count(*) FROM lumibase_items; SELECT count(*) FROM lumibase_users; SELECT count(*) FROM lumibase_sites'
}
snapshot > "$tmp/before"
set +e
bash "$installer" "${installer_args[@]}" > "$out/rerun.log" 2>&1
code=$?
set -e
[ "$code" = 3 ] || fail "the second run exited $code (expected 3)"
grep -q 'An installation exists already' "$out/rerun.log" || fail 'the second run did not say an installation exists'
snapshot > "$tmp/after"
cmp -s "$tmp/before" "$tmp/after" || fail 'the second run changed files, containers or data'
code="$(req "$site_host" GET "$article_path")"
[ "$code" = 200 ] || fail "the site answered $code after the second run"

stats > "$out/stats-after-accept.tsv"
step "ok (results in $out)"
