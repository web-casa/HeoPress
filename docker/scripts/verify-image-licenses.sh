#!/usr/bin/env sh
# Verify a built HeoPress image carries the license and attribution files
# (P01 platform/runtime-baseline: "镜像包含归属文件").
# Usage: docker/scripts/verify-image-licenses.sh <image>
set -eu
image="${1:?usage: verify-image-licenses.sh <image>}"
docker run --rm --entrypoint sh "$image" -c '
  set -e
  for f in /app/LICENSE /app/LICENSES/Apache-2.0.txt /app/NOTICE; do
    test -s "$f" || { echo "missing or empty: $f" >&2; exit 1; }
  done
  grep -q "GNU AFFERO GENERAL PUBLIC LICENSE" /app/LICENSE || { echo "/app/LICENSE is not AGPL-3.0" >&2; exit 1; }
  grep -q "Apache License" /app/LICENSES/Apache-2.0.txt || { echo "/app/LICENSES/Apache-2.0.txt is not Apache-2.0" >&2; exit 1; }
  grep -q "This product includes software developed by the LumiBase project" /app/NOTICE || { echo "/app/NOTICE lacks the LumiBase attribution" >&2; exit 1; }
'
echo "OK: $image contains LICENSE, LICENSES/Apache-2.0.txt and NOTICE with the LumiBase attribution"
