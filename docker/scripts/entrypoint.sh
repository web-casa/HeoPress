#!/bin/bash
# Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
set -e

load_secret_file() {
  local key="$1"
  local file_var="${key}_FILE"
  local file_path="${!file_var:-}"

  if [ -n "${file_path}" ] && [ -z "${!key:-}" ]; then
    if [ ! -r "${file_path}" ]; then
      echo "[entrypoint] ${file_var} points to an unreadable file: ${file_path}"
      exit 1
    fi
    export "${key}=$(tr -d '\r\n' < "${file_path}")"
  fi
}

for key in \
  DATABASE_URL \
  JWT_SECRET \
  ENCRYPTION_KEY \
  S3_ACCESS_KEY \
  S3_SECRET_KEY \
  MEILISEARCH_API_KEY \
  HEOPRESS_RENDER_PASSWORD \
  HEOPRESS_INTERNAL_SECRET
do
  load_secret_file "${key}"
done

# Checked before anything else runs, migrations included. Behind docker-compose.domains.yml the sites
# are served by the rendering service: without its role configured, the deployment stops here instead
# of coming up with every site failing.
if [ "${HEOPRESS_REQUIRE_RENDER_ROLE:-false}" = "true" ] && [ "${HEOPRESS_PROCESS_ROLE:-web}" != "worker" ] \
  && [ -z "${HEOPRESS_RENDER_PASSWORD:-}" ] && [ "${HEOPRESS_SKIP_RENDER_ROLE:-false}" != "true" ]; then
  echo "[entrypoint] The public sites need the rendering role: set HEOPRESS_RENDER_PASSWORD (or _FILE), or HEOPRESS_SKIP_RENDER_ROLE=true if it is provisioned elsewhere. Exiting."
  exit 1
fi

if [ "${SKIP_MIGRATIONS}" = "true" ]; then
  echo "[entrypoint] SKIP_MIGRATIONS=true, skipping database migrations."
else
  MAX_RETRIES=5
  RETRY_COUNT=0
  BACKOFF=1

  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if [ "${RUN_MIGRATION_PREFLIGHT:-true}" != "false" ]; then
      echo "[entrypoint] Running database migration preflight..."
      if ! node dist/migrate.cjs preflight 2>&1; then
        RETRY_COUNT=$((RETRY_COUNT + 1))

        if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
          echo "[entrypoint] Migration preflight failed after $MAX_RETRIES attempts. Exiting."
          exit 1
        fi

        echo "[entrypoint] Migration preflight attempt $RETRY_COUNT/$MAX_RETRIES failed. Retrying in ${BACKOFF}s..."
        sleep $BACKOFF
        BACKOFF=$((BACKOFF * 2))
        continue
      fi

      if [ "${MIGRATION_MODE}" = "preflight" ] || [ "${MIGRATION_MODE}" = "dry-run" ]; then
        echo "[entrypoint] MIGRATION_MODE=${MIGRATION_MODE}; exiting after preflight without starting server."
        exit 0
      fi
    fi

    echo "[entrypoint] Running database migrations..."

    if node dist/migrate.cjs apply 2>&1; then
      echo "[entrypoint] Migrations completed successfully."
      break
    fi

    RETRY_COUNT=$((RETRY_COUNT + 1))

    if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
      echo "[entrypoint] Migration failed after $MAX_RETRIES attempts. Exiting."
      exit 1
    fi

    echo "[entrypoint] Migration attempt $RETRY_COUNT/$MAX_RETRIES failed. Retrying in ${BACKOFF}s..."
    sleep $BACKOFF
    BACKOFF=$((BACKOFF * 2))
  done
fi

# The rendering service's read-only role (HeoPress P06, design R10, R20, R44): created or tightened,
# as the owner, whenever its password is configured — by the API process only (never the worker),
# whether or not this start ran the migrations. Idempotent; a failure stops startup. Deployments that
# provision the role elsewhere set HEOPRESS_SKIP_RENDER_ROLE=true.
if [ -n "${HEOPRESS_RENDER_PASSWORD:-}" ] && [ "${HEOPRESS_PROCESS_ROLE:-web}" != "worker" ] && [ "${HEOPRESS_SKIP_RENDER_ROLE:-false}" != "true" ]; then
  echo "[entrypoint] Provisioning the rendering role..."
  if ! node dist/app-role.mjs --render 2>&1; then
    echo "[entrypoint] Rendering role provisioning failed (HEOPRESS_SKIP_RENDER_ROLE=true if it is provisioned elsewhere). Exiting."
    exit 1
  fi
fi
# The CMS never needs the rendering role's credentials past this point, nor does the worker need the
# preview secret (only the API answers the rendering service): whatever docker/.env provides, they are
# not in the server's environment.
unset HEOPRESS_RENDER_PASSWORD HEOPRESS_RENDER_PASSWORD_FILE HEOPRESS_RENDER_DATABASE_URL HEOPRESS_RENDER_DATABASE_URL_FILE
if [ "${HEOPRESS_PROCESS_ROLE:-web}" = "worker" ]; then
  unset HEOPRESS_INTERNAL_SECRET HEOPRESS_INTERNAL_SECRET_FILE
fi

echo "[entrypoint] Starting server..."
exec node dist/serve.cjs
