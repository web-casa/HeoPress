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
  DATABASE_OWNER_URL \
  HEOPRESS_APP_PASSWORD \
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

# The database roles (HeoPress P13, security review S-5). DATABASE_URL is the runtime's connection: the application
# role (heopress_app), to which row-level security applies. DATABASE_OWNER_URL, the owner of the tables, is used
# here only — migrations and role provisioning — and never reaches the server. Without it (a deployment from before
# this change) DATABASE_URL is the owner's and serves for both, as it always did; the check below warns about it.
OWNER_URL="${DATABASE_OWNER_URL:-${DATABASE_URL:-}}"
as_owner() { DATABASE_URL="${OWNER_URL}" "$@"; }

if [ "${SKIP_MIGRATIONS}" = "true" ]; then
  echo "[entrypoint] SKIP_MIGRATIONS=true, skipping database migrations."
else
  MAX_RETRIES=5
  RETRY_COUNT=0
  BACKOFF=1

  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if [ "${RUN_MIGRATION_PREFLIGHT:-true}" != "false" ]; then
      echo "[entrypoint] Running database migration preflight..."
      if ! as_owner node dist/migrate.cjs preflight 2>&1; then
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

    if as_owner node dist/migrate.cjs apply 2>&1; then
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

# The application role (security review S-5): created or updated, as the owner, by the API process whenever its
# password is configured, whether or not this start ran the migrations — new tables of a migration get its grants
# from the owner's default privileges, and this run re-applies the rest. Idempotent; a failure stops startup.
# Deployments that provision the role elsewhere set HEOPRESS_SKIP_APP_ROLE=true.
if [ -n "${HEOPRESS_APP_PASSWORD:-}" ] && [ "${HEOPRESS_PROCESS_ROLE:-web}" != "worker" ] && [ "${HEOPRESS_SKIP_APP_ROLE:-false}" != "true" ]; then
  echo "[entrypoint] Provisioning the application role..."
  if ! as_owner node dist/app-role.mjs 2>&1; then
    echo "[entrypoint] Application role provisioning failed (HEOPRESS_SKIP_APP_ROLE=true if it is provisioned elsewhere). Exiting."
    exit 1
  fi
fi

# The rendering service's read-only role (HeoPress P06, design R10, R20, R44): created or tightened,
# as the owner, whenever its password is configured — by the API process only (never the worker),
# whether or not this start ran the migrations. Idempotent; a failure stops startup. Deployments that
# provision the role elsewhere set HEOPRESS_SKIP_RENDER_ROLE=true.
if [ -n "${HEOPRESS_RENDER_PASSWORD:-}" ] && [ "${HEOPRESS_PROCESS_ROLE:-web}" != "worker" ] && [ "${HEOPRESS_SKIP_RENDER_ROLE:-false}" != "true" ]; then
  echo "[entrypoint] Provisioning the rendering role..."
  if ! as_owner node dist/app-role.mjs --render 2>&1; then
    echo "[entrypoint] Rendering role provisioning failed (HEOPRESS_SKIP_RENDER_ROLE=true if it is provisioned elsewhere). Exiting."
    exit 1
  fi
fi
# The CMS never needs the rendering role's credentials past this point, nor does the worker need the
# preview secret (only the API answers the rendering service): whatever docker/.env provides, they are
# not in the server's environment.
unset HEOPRESS_RENDER_PASSWORD HEOPRESS_RENDER_PASSWORD_FILE HEOPRESS_RENDER_DATABASE_URL HEOPRESS_RENDER_DATABASE_URL_FILE
# Nor the owner's connection or the application role's password (security review S-5): no server process, API or
# worker, keeps them, whatever docker/.env provides.
unset OWNER_URL DATABASE_OWNER_URL DATABASE_OWNER_URL_FILE HEOPRESS_APP_PASSWORD HEOPRESS_APP_PASSWORD_FILE
if [ "${HEOPRESS_PROCESS_ROLE:-web}" = "worker" ]; then
  unset HEOPRESS_INTERNAL_SECRET HEOPRESS_INTERNAL_SECRET_FILE
fi

# The runtime's own connection: row-level security must apply to it (security review S-5). The API process checks
# (the worker shares its DATABASE_URL and starts after it). With HEOPRESS_REQUIRE_APP_ROLE=true (docker/install.sh
# sets it) a connection that bypasses RLS stops startup; otherwise it is a warning, so a deployment from before this
# change keeps running until it is switched (docs/zh-CN/operations/install.md, "数据库角色"). A database that cannot
# be asked now is left to the server's readiness check.
if [ "${HEOPRESS_PROCESS_ROLE:-web}" != "worker" ] && [ "${HEOPRESS_SKIP_DB_ROLE_CHECK:-false}" != "true" ]; then
  set +e
  node dist/app-role.mjs --check 2>&1
  role_check=$?
  set -e
  if [ "${role_check}" = 1 ]; then
    if [ "${HEOPRESS_REQUIRE_APP_ROLE:-false}" = "true" ]; then
      echo "[entrypoint] HEOPRESS_REQUIRE_APP_ROLE=true and the runtime connection bypasses row-level security. Exiting."
      exit 1
    fi
    echo "[entrypoint] WARNING: the server connects as a role that bypasses row-level security (see above); switch DATABASE_URL to the application role."
  fi
fi

echo "[entrypoint] Starting server..."
exec node dist/serve.cjs
