#!/usr/bin/env bash
# The installer on a simulated VPS (HeoPress P13 tasks 3.1, 3.2, 3.4): a privileged ubuntu:24.04 container with a
# fixed CPU and memory budget stands in for a fresh server. docker/install.sh runs inside it as root and installs
# Docker Engine from Docker's apt repository itself; Docker-in-Docker means every container of the installation
# runs inside that budget, as on a VM of that size. Then docker/scripts/accept-install.sh checks the installation.
#
#   SIM_CPUS=2 SIM_MEMORY=4g docker/scripts/sim-vps-install.sh
#
# Environment (defaults in brackets):
#   SIM_NAME      container name, must contain "sim" — the container and its Docker volume are replaced [heopress-sim-vps]
#   SIM_CPUS      CPUs [2]                 SIM_MEMORY  memory, swap included [4g]
#   SIM_PORT      host port (127.0.0.1) for the VM's HTTPS port [random]
#   SIM_OUT       results directory [a new temporary directory]
#   SIM_CMS_IMAGE / SIM_SITE_IMAGE / SIM_DB_IMAGE   images built on this machine, handed to the installer as an
#                 image archive (an offline install) [heopress-cms:local, heopress-site-classic:local, heopress-postgres:18]
#   SIM_EXTRA     more installer arguments (word-split)
#   SIM_KEEP=1    keep the VM running afterwards (for the scale benchmark); otherwise it is removed
#
# Differences from a real VPS: no systemd in the container, so the installer starts Docker with `service`; the
# images come from an archive instead of a registry and the build. The CI job `install` runs the same installer
# on a GitHub-hosted ubuntu-24.04 runner (systemd, Docker preinstalled) and builds the images there.
set -euo pipefail

name="${SIM_NAME:-heopress-sim-vps}"
case "$name" in *sim*) ;; *) echo "[sim-vps] SIM_NAME must contain 'sim' (the container and its volume are replaced)" >&2; exit 1 ;; esac
[[ "$name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo '[sim-vps] SIM_NAME: lowercase letters, digits, _ and - only' >&2; exit 1; }
cpus="${SIM_CPUS:-2}"
memory="${SIM_MEMORY:-4g}"
cms_image="${SIM_CMS_IMAGE:-heopress-cms:local}"
site_image="${SIM_SITE_IMAGE:-heopress-site-classic:local}"
db_image="${SIM_DB_IMAGE:-heopress-postgres:18}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
out="${SIM_OUT:-$(mktemp -d)}"
mkdir -p -- "$out"
out="$(cd -- "$out" && pwd)"
step() { echo "[sim-vps] $*"; }

step "VM $name: ubuntu:24.04, $cpus CPUs, $memory memory"
docker rm -f "$name" >/dev/null 2>&1 || true
docker volume rm "$name-docker" >/dev/null 2>&1 || true
# Whole CPUs are pinned (the last ones of this machine), so `nproc` in the VM says the same as a VPS would.
cpuset=()
if [[ "$cpus" =~ ^[0-9]+$ ]]; then
  total="$(nproc)"
  [ "$cpus" -le "$total" ] || { echo "[sim-vps] only $total CPUs here" >&2; exit 1; }
  cpuset=(--cpuset-cpus "$((total - cpus))-$((total - 1))")
fi
docker run -d --privileged --name "$name" --hostname "$name" --cpus "$cpus" "${cpuset[@]}" --memory "$memory" --memory-swap "$memory" \
  -v "$name-docker:/var/lib/docker" -v "$repo:/src:ro" -v "$out:/sim" \
  -p "127.0.0.1:${SIM_PORT:-0}:443" ubuntu:24.04 sleep infinity >/dev/null
# cgroup v2 nesting, as the docker:dind image does: move this container's processes into a leaf group so that the
# inner Docker can delegate controllers to its containers (all within this container's budget).
docker exec "$name" sh -c 'mkdir -p /sys/fs/cgroup/init && xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs || :
  sed -e "s/ / +/g" -e "s/^/+/" < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control'
port="$(docker port "$name" 443/tcp | head -1 | sed 's/.*://')"
echo "$port" > "$out/https-port"
step "HTTPS of the VM on 127.0.0.1:$port"

step "image archive ($cms_image, $site_image, $db_image, caddy:2-alpine)"
docker image inspect caddy:2-alpine >/dev/null 2>&1 || docker pull -q caddy:2-alpine >/dev/null
docker save -o "$out/images.tar" "$cms_image" "$site_image" "$db_image" caddy:2-alpine

args=(--admin-domain admin.example.test --admin-email ops@example.test --tls internal --source /src
  --extra-compose docker/docker-compose.install-test.yml --image-archive /sim/images.tar
  --cms-image "$cms_image" --site-image "$site_image" --db-image "$db_image")
# shellcheck disable=SC2206
[ -z "${SIM_EXTRA:-}" ] || args+=(${SIM_EXTRA})

step 'installer'
started=$(date +%s)
set +e
docker exec "$name" bash /src/docker/install.sh "${args[@]}" > "$out/install.out" 2>&1
code=$?
set -e
echo "$(( $(date +%s) - started ))" > "$out/install-seconds"
tail -15 "$out/install.out"
[ "$code" = 0 ] || { step "the installer exited $code (output: $out/install.out)"; exit 1; }
rm -f -- "$out/images.tar"

step 'acceptance'
docker exec -e ACCEPT_OUT=/sim/accept "$name" bash /src/docker/scripts/accept-install.sh /opt/heopress -- "${args[@]}" | tee "$out/accept.out"
docker inspect -f 'cpus={{.HostConfig.NanoCpus}} cpuset={{.HostConfig.CpusetCpus}} memory={{.HostConfig.Memory}}' "$name" > "$out/vm-limits.txt"
docker exec "$name" sh -c 'echo "nproc=$(nproc) loadavg=$(cat /proc/loadavg)"' >> "$out/vm-limits.txt"

if [ "${SIM_KEEP:-0}" = 1 ]; then
  step "kept running: docker exec -it $name bash; remove with: docker rm -f $name && docker volume rm $name-docker"
else
  docker rm -f "$name" >/dev/null
  docker volume rm "$name-docker" >/dev/null
fi
step "ok (results in $out)"
