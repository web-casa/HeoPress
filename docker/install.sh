#!/usr/bin/env bash
# HeoPress one-command installer (HeoPress P13 task 3.1; docs/zh-CN/operations/install.md).
#
# On a clean Ubuntu 24.04 server, as root:
#
#   curl -fsSL https://raw.githubusercontent.com/web-casa/HeoPress/main/docker/install.sh -o install.sh
#   sudo bash install.sh --admin-domain admin.example.com --acme-email ops@example.com
#
# installs Docker (from Docker's apt repository) when it is missing, fetches the release, builds the database image,
# pulls (or builds) the application images, generates every secret, starts PostgreSQL, the CMS, the worker and the
# rendering service, creates the first administrator, then starts Caddy (the administration domain to the CMS, every
# verified site domain to the rendering service, no administration path on a site domain) and checks readiness and
# the administrator's login.
#
# Secrets are written to files readable by root only and never printed or logged: the summary names the file that
# holds the administrator's login address, password and backup codes. An existing installation (this directory's
# configuration, or the Compose project's volumes or containers) is never touched: the script says so and exits 3.
#
# Exit codes: 0 installed; 1 failed; 2 bad arguments; 3 an installation exists already (nothing changed).
set -Eeuo pipefail
umask 077

DEFAULT_VERSION='1.0.0-rc.4'
DEFAULT_REPOSITORY='web-casa/HeoPress'
DEFAULT_REGISTRY='ghcr.io/web-casa'
MIN_COMPOSE='2.24.4'

usage() {
  cat <<'EOF'
Usage: sudo bash install.sh --admin-domain <host> [options]

Required:
  --admin-domain HOST     the administration domain (Studio and API); its DNS points at this server
  --acme-email EMAIL      the ACME account email for certificates (not needed with --tls internal)

Options:
  --admin-email EMAIL     the first administrator's email (default: admin@<admin-domain>)
  --dir DIR               installation directory (default /opt/heopress)
  --project NAME          Docker Compose project name (default heopress)
  --version VERSION       release to install (default: this script's release)
  --source DIR            use this source tree (a release or a checkout) instead of downloading the release
  --build                 build the CMS and rendering images from the source instead of pulling them
  --cms-image REF         CMS image (default <registry>/heopress-cms:<version>; used as is when present locally)
  --site-image REF        rendering service image (default <registry>/heopress-site-classic:<version>)
  --db-image REF          database image (default: built from the source's docker/postgres as heopress-postgres:<version>)
  --image-archive FILE    load images from a `docker save` archive first (offline installs; then name them above)
  --tls acme|internal     certificates from ACME (default) or Caddy's local CA (tests and private networks)
  --http-port PORT        host port for HTTP (default 80)
  --https-port PORT       host port for HTTPS (default 443)
  --extra-compose FILE    an additional Compose file, applied after the installer's (repeatable; kept for later runs)
  --skip-os-check         allow a system other than Ubuntu 24.04 (unsupported)
  -h, --help              this help

Exit codes: 0 installed; 1 failed; 2 bad arguments; 3 an installation exists already (nothing changed).
EOF
}

# ── Output: everything goes to the terminal and the install log; secrets never do. ─────────────────────────────────
LOG_FILE="${HEOPRESS_INSTALL_LOG:-/var/log/heopress-install.log}"
say() { printf '[heopress-install] %s\n' "$*"; }
warn() { printf '[heopress-install] WARNING: %s\n' "$*" >&2; }
die() {
  printf '[heopress-install] ERROR: %s\n' "$*" >&2
  exit 1
}
on_error() {
  local code=$? line=$1
  printf '[heopress-install] ERROR: failed at line %s (exit %s). The log is %s; nothing is printed with secrets.\n' \
    "$line" "$code" "$LOG_FILE" >&2
  exit 1
}

# ── Arguments ───────────────────────────────────────────────────────────────────────────────────────────────────────
admin_domain=''
acme_email=''
admin_email=''
install_dir='/opt/heopress'
project='heopress'
version="$DEFAULT_VERSION"
source_dir=''
build_images=false
cms_image=''
site_image=''
db_image=''
image_archive=''
tls_mode='acme'
http_port=80
https_port=443
skip_os_check=false
extra_compose=()

need_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || { printf 'install.sh: %s needs a value\n' "$1" >&2; exit 2; }; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --admin-domain) need_value "$@"; admin_domain="$2"; shift 2 ;;
    --acme-email) need_value "$@"; acme_email="$2"; shift 2 ;;
    --admin-email) need_value "$@"; admin_email="$2"; shift 2 ;;
    --dir) need_value "$@"; install_dir="$2"; shift 2 ;;
    --project) need_value "$@"; project="$2"; shift 2 ;;
    --version) need_value "$@"; version="${2#v}"; shift 2 ;;
    --source) need_value "$@"; source_dir="$2"; shift 2 ;;
    --build) build_images=true; shift ;;
    --cms-image) need_value "$@"; cms_image="$2"; shift 2 ;;
    --site-image) need_value "$@"; site_image="$2"; shift 2 ;;
    --db-image) need_value "$@"; db_image="$2"; shift 2 ;;
    --image-archive) need_value "$@"; image_archive="$2"; shift 2 ;;
    --tls) need_value "$@"; tls_mode="$2"; shift 2 ;;
    --http-port) need_value "$@"; http_port="$2"; shift 2 ;;
    --https-port) need_value "$@"; https_port="$2"; shift 2 ;;
    --extra-compose) need_value "$@"; extra_compose+=("$2"); shift 2 ;;
    --skip-os-check) skip_os_check=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) printf 'install.sh: unknown option %s (see --help)\n' "$1" >&2; exit 2 ;;
  esac
done

bad_args() { printf 'install.sh: %s\n' "$*" >&2; exit 2; }
[ -n "$admin_domain" ] || bad_args '--admin-domain is required (see --help)'
# A hostname: letters, digits, hyphens and dots; at least one dot; no scheme, port or path.
[[ "$admin_domain" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] \
  || bad_args "--admin-domain must be a hostname such as admin.example.com (got: $admin_domain)"
admin_domain="${admin_domain,,}"
case "$tls_mode" in acme | internal) ;; *) bad_args '--tls is acme or internal' ;; esac
[ "$tls_mode" = internal ] || [ -n "$acme_email" ] || bad_args '--acme-email is required for ACME certificates (or --tls internal)'
[ -n "$acme_email" ] || acme_email="ops@$admin_domain"
[ -n "$admin_email" ] || admin_email="admin@$admin_domain"
email_re='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
[[ "$acme_email" =~ $email_re ]] || bad_args "--acme-email is not an email address: $acme_email"
[[ "$admin_email" =~ $email_re ]] || bad_args "--admin-email is not an email address: $admin_email"
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || bad_args '--project: lowercase letters, digits, _ and - only'
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || bad_args "--version is not a release version: $version"
for p in "$http_port" "$https_port"; do
  [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -ge 1 ] && [ "$p" -le 65535 ] || bad_args "not a port: $p"
done
case "$install_dir" in /*) ;; *) bad_args '--dir must be an absolute path' ;; esac
install_dir="${install_dir%/}"
[ -n "$install_dir" ] && [ "$install_dir" != / ] || bad_args '--dir must not be /'

# ── Root, log ───────────────────────────────────────────────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || die 'run as root (sudo bash install.sh …)'
mkdir -p -- "$(dirname -- "$LOG_FILE")"
touch -- "$LOG_FILE"
chmod 600 -- "$LOG_FILE"
exec > >(tee -a -- "$LOG_FILE") 2>&1
trap 'on_error $LINENO' ERR
say "HeoPress $version installer — $(date -u +%Y-%m-%dT%H:%M:%SZ); log: $LOG_FILE"

# ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
# Random hex from the kernel; od reads exactly the bytes asked for (no SIGPIPE under pipefail).
rand_hex() { od -An -tx1 -N "$1" /dev/urandom | tr -d ' \n'; }
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
have() { command -v "$1" >/dev/null 2>&1; }
conf_file="$install_dir/heopress.conf"
env_file="$install_dir/.env"
secrets_dir="$install_dir/secrets"
credentials_file="$secrets_dir/admin-credentials"
wrapper="$install_dir/heopress-compose"

already_installed() {
  printf '[heopress-install] An installation exists already (%s). Nothing was changed.\n' "$1"
  printf '[heopress-install] Manage it with %s (a docker compose wrapper); upgrades: docs/zh-CN/operations/install.md.\n' "$wrapper"
  exit 3
}

# ── 1. An existing installation is never touched ────────────────────────────────────────────────────────────────────
[ ! -e "$conf_file" ] || already_installed "$conf_file"
[ ! -e "$env_file" ] || already_installed "$env_file exists: an earlier run stopped before finishing; see the install guide to remove it"
if have docker && docker info >/dev/null 2>&1; then
  if [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]; then
    already_installed "Docker volumes of Compose project $project"
  fi
  if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]; then
    already_installed "containers of Compose project $project"
  fi
fi

# ── 2. Preflight ────────────────────────────────────────────────────────────────────────────────────────────────────
say 'checking the system'
os_id=''
os_version=''
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  os_id="$(. /etc/os-release && echo "${ID:-}")"
  os_version="$(. /etc/os-release && echo "${VERSION_ID:-}")"
fi
if [ "$os_id" != ubuntu ] || [ "$os_version" != 24.04 ]; then
  [ "$skip_os_check" = true ] || die "this installer supports Ubuntu 24.04 (found ${os_id:-unknown} ${os_version:-?}); --skip-os-check to try anyway"
  warn "unsupported system ${os_id:-unknown} ${os_version:-?} (--skip-os-check)"
fi
case "$(uname -m)" in x86_64 | aarch64) ;; *) die "unsupported architecture $(uname -m) (amd64 or arm64)" ;; esac
cpus="$(nproc)"
mem_mb="$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
say "CPUs: $cpus, memory: ${mem_mb} MB"
[ "$cpus" -ge 2 ] || warn 'fewer than 2 CPUs: below the minimum deployment (2 vCPU / 4 GB)'
[ "$mem_mb" -ge 3500 ] || warn 'less than 4 GB of memory: below the minimum deployment (2 vCPU / 4 GB)'
disk_parent="$install_dir"
while [ ! -d "$disk_parent" ]; do disk_parent="$(dirname -- "$disk_parent")"; done
disk_gb="$(df -Pk -- "$disk_parent" | awk 'NR == 2 { printf "%d", $4 / 1048576 }')"
[ "$disk_gb" -ge 10 ] || warn "only ${disk_gb} GB free under $disk_parent (10 GB or more recommended)"
if have ss; then
  for p in "$http_port" "$https_port"; do
    if ss -Hltn "sport = :$p" | grep -q .; then die "port $p is in use (Caddy needs it)"; fi
  done
fi

# ── 3. Docker ───────────────────────────────────────────────────────────────────────────────────────────────────────
start_docker() {
  if have systemctl && [ -d /run/systemd/system ]; then
    systemctl enable --now docker >/dev/null
  elif have service; then
    service docker start >/dev/null || true
  fi
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && return 0; sleep 1; done
  die 'the Docker daemon did not start'
}
install_docker_packages() { # packages…
  export DEBIAN_FRONTEND=noninteractive
  if [ ! -s /etc/apt/sources.list.d/docker.list ]; then
    say 'adding the Docker apt repository (download.docker.com)'
    apt-get update -q
    apt-get install -y -q ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    # shellcheck disable=SC1091
    codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-noble}")"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
      > /etc/apt/sources.list.d/docker.list
    chmod 644 /etc/apt/sources.list.d/docker.list
  fi
  apt-get update -q
  apt-get install -y -q "$@"
}
if ! have docker; then
  say 'installing Docker Engine and the Compose plugin'
  install_docker_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker info >/dev/null 2>&1 || start_docker
if ! docker compose version >/dev/null 2>&1; then
  say 'installing the Docker Compose plugin'
  install_docker_packages docker-compose-plugin
fi
compose_version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
version_ge "$compose_version" "$MIN_COMPOSE" || die "Docker Compose $compose_version is too old (need $MIN_COMPOSE or later)"
say "Docker $(docker version --format '{{.Server.Version}}'), Compose $compose_version"
have curl || install_docker_packages curl
# Re-check now that Docker runs (a Docker that was installed but stopped could hide a project).
if [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]; then
  already_installed "Docker volumes or containers of Compose project $project"
fi

# ── 4. The release ──────────────────────────────────────────────────────────────────────────────────────────────────
mkdir -p -- "$install_dir"
chmod 755 -- "$install_dir"
if [ -n "$source_dir" ]; then
  src="$(cd -- "$source_dir" && pwd -P)"
  say "using the source tree $src"
else
  src="$install_dir/releases/v$version"
  if [ ! -d "$src" ]; then
    url="https://github.com/$DEFAULT_REPOSITORY/archive/refs/tags/v$version.tar.gz"
    say "downloading $url"
    tmp_tar="$(mktemp)"
    curl -fsSL --retry 3 -o "$tmp_tar" "$url" || die "could not download release v$version (--source to install from a local tree)"
    mkdir -p -- "$src"
    tar -xzf "$tmp_tar" -C "$src" --strip-components=1
    rm -f -- "$tmp_tar"
  fi
fi
for f in docker/docker-compose.yml docker/docker-compose.prod.yml docker/docker-compose.tls.yml \
  docker/docker-compose.domains.yml docker/docker-compose.install.yml docker/Caddyfile.domains docker/postgres/Dockerfile; do
  [ -f "$src/$f" ] || die "the source tree $src has no $f"
done
extra_abs=()
for f in "${extra_compose[@]}"; do
  case "$f" in /*) ;; *) f="$src/$f" ;; esac
  [ -f "$f" ] || die "--extra-compose: no such file $f"
  extra_abs+=("$f")
done

# ── 5. Images ───────────────────────────────────────────────────────────────────────────────────────────────────────
[ -n "$cms_image" ] || cms_image="$DEFAULT_REGISTRY/heopress-cms:$version"
[ -n "$site_image" ] || site_image="$DEFAULT_REGISTRY/heopress-site-classic:$version"
if [ "$build_images" = true ]; then
  [ "${cms_image#"$DEFAULT_REGISTRY"/}" = "$cms_image" ] || cms_image="heopress-cms:$version"
  [ "${site_image#"$DEFAULT_REGISTRY"/}" = "$site_image" ] || site_image="heopress-site-classic:$version"
fi
image_present() { docker image inspect "$1" >/dev/null 2>&1; }
if [ -n "$image_archive" ]; then
  [ -r "$image_archive" ] || die "--image-archive: cannot read $image_archive"
  say "loading images from $image_archive"
  docker load -q -i "$image_archive"
fi
build_meta=(--build-arg "HEOPRESS_RELEASE_CHANNEL=self-hosted")
if [ "$build_images" = true ]; then
  if image_present "$cms_image" && image_present "$site_image"; then
    say "using the local images $cms_image and $site_image"
  else
    say "building $cms_image and $site_image from $src (several minutes)"
    docker build -q "${build_meta[@]}" -f "$src/docker/Dockerfile" -t "$cms_image" "$src" >/dev/null
    docker build -q "${build_meta[@]}" -f "$src/docker/Dockerfile" --target site-classic -t "$site_image" "$src" >/dev/null
  fi
else
  for image in "$cms_image" "$site_image"; do
    if image_present "$image"; then
      say "using the local image $image"
    else
      say "pulling $image"
      docker pull -q "$image" >/dev/null || die "could not pull $image (--build builds it from the source)"
    fi
  done
fi
if [ -z "$db_image" ]; then
  db_image="heopress-postgres:$version"
  if ! image_present "$db_image"; then
    say "building the database image $db_image (PostgreSQL 18 with pgvector and zhparser; several minutes)"
    docker build -q -f "$src/docker/postgres/Dockerfile" -t "$db_image" "$src/docker/postgres" >/dev/null
  fi
elif ! image_present "$db_image"; then
  say "pulling $db_image"
  docker pull -q "$db_image" >/dev/null || die "could not pull $db_image"
fi
caddy_image='caddy:2-alpine'
image_present "$caddy_image" || { say "pulling $caddy_image"; docker pull -q "$caddy_image" >/dev/null; }

# ── 6. Configuration and secrets (root only, never printed) ─────────────────────────────────────────────────────────
say "writing the configuration to $install_dir (secrets readable by root only)"
mkdir -p -- "$secrets_dir"
chmod 700 -- "$secrets_dir"
caddyfile="$src/docker/Caddyfile.domains"
if [ "$tls_mode" = internal ]; then
  # Caddy's own CA instead of ACME: the only change to the shipped file.
  caddyfile="$install_dir/Caddyfile.internal-ca"
  sed '0,/^{$/s//{\n\tlocal_certs/' "$src/docker/Caddyfile.domains" > "$caddyfile"
  grep -q 'local_certs' "$caddyfile" || die 'could not switch the Caddyfile to the local CA'
  chmod 644 -- "$caddyfile"
fi
pg_password="$(rand_hex 24)"
render_password="$(rand_hex 24)"
{
  echo "# HeoPress installation ($version), written by docker/install.sh. Secrets: keep this file root-only (0600)."
  echo "# The Compose interpolation file of the wrapper $wrapper; back it up with the encryption key (docs/zh-CN/operations/backup-restore.md)."
  echo "COMPOSE_PROJECT_NAME=$project"
  echo "HEOPRESS_VERSION=$version"
  echo "HEOPRESS_CMS_IMAGE=$cms_image"
  echo "HEOPRESS_SITE_IMAGE=$site_image"
  echo "HEOPRESS_DB_IMAGE=$db_image"
  echo "HEOPRESS_CADDYFILE=$caddyfile"
  echo "HEOPRESS_HTTP_PORT=$http_port"
  echo "HEOPRESS_HTTPS_PORT=$https_port"
  echo "PUBLIC_DOMAIN=$admin_domain"
  echo "ACME_EMAIL=$acme_email"
  echo "CORS_ALLOWED_ORIGINS=https://$admin_domain"
  # The bundled database is on the private Compose network only, without TLS.
  echo "DATABASE_SSL_MODE=disable"
  echo "POSTGRES_PASSWORD=$pg_password"
  echo "DATABASE_URL=postgresql://heopress:$pg_password@postgres:5432/heopress"
  echo "JWT_SECRET=$(rand_hex 32)"
  echo "ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  echo "HEOPRESS_RENDER_PASSWORD=$render_password"
  echo "HEOPRESS_RENDER_DATABASE_URL=postgresql://heopress_render:$render_password@postgres:5432/heopress"
  echo "HEOPRESS_INTERNAL_SECRET=$(rand_hex 32)"
} > "$env_file"
chmod 600 -- "$env_file"
unset pg_password render_password

compose_files=(-f "$src/docker/docker-compose.yml" -f "$src/docker/docker-compose.prod.yml" -f "$src/docker/docker-compose.tls.yml"
  -f "$src/docker/docker-compose.domains.yml" -f "$src/docker/docker-compose.install.yml")
for f in "${extra_abs[@]}"; do compose_files+=(-f "$f"); done
compose=(docker compose --project-name "$project" --env-file "$env_file" "${compose_files[@]}")
{
  echo '#!/bin/sh'
  echo "# docker compose for the HeoPress installation in $install_dir (written by docker/install.sh)."
  printf 'exec docker compose --project-name %q --env-file %q' "$project" "$env_file"
  for f in "${compose_files[@]}"; do [ "$f" = -f ] || printf ' -f %q' "$f"; done
  printf ' "$@"\n'
} > "$wrapper"
chmod 700 -- "$wrapper"

# ── 7. Start (no public ingress yet) ────────────────────────────────────────────────────────────────────────────────
say 'starting PostgreSQL, the CMS, the worker and the rendering service'
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 600 postgres cms cms-worker site-classic

# Requests to the CMS from inside its own container (no host port, no proxy). Input on stdin, so no secret is on a
# command line; the scripts print no secret.
cms_node() { "${compose[@]}" exec -T cms node -e "$1"; }
ready=''
for _ in $(seq 1 60); do
  if cms_node "fetch('http://127.0.0.1:1989/health/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
[ -n "$ready" ] || die "the CMS did not become ready (logs: $wrapper logs cms)"

# ── 8. The first administrator ──────────────────────────────────────────────────────────────────────────────────────
say "creating the first administrator ($admin_email)"
admin_password="Hp-$(rand_hex 16)-Z9!"
admin_path="/hp-$(rand_hex 8)"
# shellcheck disable=SC2016
setup_js='
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", async () => {
  const [email, password, adminPath] = s.split("\n");
  const r = await fetch("http://127.0.0.1:1989/api/v1/setup/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: { email, password, firstName: "HeoPress", lastName: "Administrator" }, adminPath }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status !== 201) {
    // Error codes only: the answer never carries the password.
    console.error("setup answered " + r.status + ": " + (body.errors || []).map((e) => e.code).join(", "));
    process.exit(1);
  }
  process.stdout.write((body.backupCodes || []).join("\n"));
});'
backup_codes="$(printf '%s\n%s\n%s' "$admin_email" "$admin_password" "$admin_path" | "${compose[@]}" exec -T cms node -e "$setup_js")" \
  || die 'the first-run setup failed (see the error code above)'
{
  echo "# HeoPress administrator — created $(date -u +%Y-%m-%dT%H:%M:%SZ) by docker/install.sh."
  echo '# Store these in a password manager, then delete this file (shred -u). Root only.'
  echo "login_url=https://$admin_domain$admin_path/"
  echo "email=$admin_email"
  echo "password=$admin_password"
  echo 'backup_codes:'
  printf '%s\n' "$backup_codes" | sed 's/^/  /'
} > "$credentials_file"
chmod 600 -- "$credentials_file"
unset backup_codes

# The administrator can sign in (the same API the Studio's login uses).
# shellcheck disable=SC2016
login_js='
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", async () => {
  const [email, password] = s.split("\n");
  const r = await fetch("http://127.0.0.1:1989/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-heopress-site": "__default__" },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  process.exit(r.status === 200 && body.data && body.data.token ? 0 : 1);
});'
printf '%s\n%s' "$admin_email" "$admin_password" | "${compose[@]}" exec -T cms node -e "$login_js" \
  || die 'the administrator could not sign in after setup'
unset admin_password

# ── 9. Public ingress ───────────────────────────────────────────────────────────────────────────────────────────────
say "starting Caddy on ports $http_port/$https_port (administration domain $admin_domain; site domains on demand)"
"${compose[@]}" up -d --no-build --pull never caddy
caddy_ok=''
curl_tls=()
[ "$tls_mode" = acme ] || curl_tls=(-k)
for _ in $(seq 1 30); do
  if curl -fsS "${curl_tls[@]}" --max-time 10 -o /dev/null --resolve "$admin_domain:$https_port:127.0.0.1" \
    "https://$admin_domain:$https_port/health/ready" 2>/dev/null; then
    caddy_ok=1
    break
  fi
  sleep 3
done
if [ -n "$caddy_ok" ]; then
  say "readiness through Caddy: https://$admin_domain/health/ready answered 200"
elif [ "$tls_mode" = acme ]; then
  warn "https://$admin_domain did not answer yet: point its DNS A/AAAA records at this server; Caddy obtains the certificate on the first request"
else
  die "Caddy did not answer for $admin_domain (logs: $wrapper logs caddy)"
fi

# ── 10. Done ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  echo "# HeoPress installation (docker/install.sh). Its presence makes the installer refuse to run again."
  echo "installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "version=$version"
  echo "project=$project"
  echo "source=$src"
  echo "admin_domain=$admin_domain"
  echo "tls=$tls_mode"
  echo "wrapper=$wrapper"
} > "$conf_file"
chmod 644 -- "$conf_file"

say 'installed.'
cat <<EOF

  HeoPress $version is running.

  Administration: https://$admin_domain/
  The login address (with its private path), the password and the backup codes are in
      $credentials_file   (root only: sudo cat $credentials_file)
  Store them in a password manager, then delete that file. They are not in this output or the log.

  Manage the services:  sudo $wrapper ps | logs | restart …
  Next: point each site's domain at this server and add it in the Studio (Sites › Domains);
        set up backups (docs/zh-CN/operations/backup-restore.md).

EOF
