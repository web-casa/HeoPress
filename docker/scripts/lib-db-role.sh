# shellcheck shell=bash
# The runtime's database role (HeoPress P13, security review S-5), checked from outside the processes. Sourced by
# docker/scripts/accept-image-runtime.sh and docker/scripts/accept-install.sh; expects `db_role_compose` (the docker
# compose command, an array) and `fail`.
#
#   check_runtime_db_roles   → prints one line per check; calls `fail` on the first that does not hold
#
# 1. heopress_app is no superuser, has no BYPASSRLS / CREATEROLE / CREATEDB / REPLICATION, is a member of no role,
#    owns none of the application tables (only the runtime's own: vector spaces, materialized tables) and cannot act
#    as their owner;
# 2. every database session of the CMS and the worker containers is heopress_app, every one of the rendering service
#    heopress_render, and no other role than those two holds a session (the owner holds none: it migrated and left);
# 3. in the CMS and the worker, the server's own connection (DATABASE_URL of PID 1) passes `app-role --check`: the
#    catalogue says RLS applies to it, and a live probe — a table with forced RLS, two sites' rows — shows it one;
# 4. no server process keeps the owner's connection or a role password in its environment (names only).
# Nothing secret is printed: the URLs never leave the containers.

# shellcheck disable=SC2154 # db_role_compose: set by the sourcing script
db_role_psql() { "${db_role_compose[@]}" exec -T postgres psql -U heopress -d heopress -v ON_ERROR_STOP=1 -tAc "$1"; }

db_role_ips() { # service → its container's addresses
  local id
  id="$("${db_role_compose[@]}" ps -q "$1")"
  [ -n "$id" ] || fail "no running $1 container"
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$id"
}

check_runtime_db_roles() {
  local attrs owned owns_items members svc ips list roles n out leaked roles_all
  attrs="$(db_role_psql "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = 'heopress_app'")"
  [ "$attrs" = 'f|f|f|f|f' ] || fail "heopress_app attributes (super, bypassrls, createrole, createdb, replication): ${attrs:-missing}"
  members="$(db_role_psql "SELECT count(*) FROM pg_auth_members WHERE member = 'heopress_app'::regrole")"
  [ "$members" = 0 ] || fail "heopress_app is a member of $members role(s)"
  owned="$(db_role_psql "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'drizzle', 'pgboss') AND c.relkind IN ('r', 'p', 'v', 'm')
      AND c.relowner = 'heopress_app'::regrole AND c.relname NOT LIKE 'lumibase\_vectors\_%' AND c.relname NOT LIKE 'mat\_%'")"
  [ "$owned" = 0 ] || fail "heopress_app owns $owned application table(s)"
  owns_items="$(db_role_psql "SELECT pg_has_role('heopress_app', c.relowner, 'USAGE') FROM pg_class c WHERE c.oid = 'lumibase_items'::regclass")"
  [ "$owns_items" = f ] || fail 'heopress_app can act as the owner of lumibase_items'
  echo "  heopress_app: no superuser, no BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION, no membership, owns no application table"

  for svc in cms cms-worker site-classic; do
    ips="$(db_role_ips "$svc")"
    list="$(for ip in $ips; do printf "'%s'," "$ip"; done)"
    list="${list%,}"
    [ -n "$list" ] || fail "$svc has no address"
    roles=''
    for _ in $(seq 1 30); do
      roles="$(db_role_psql "SELECT string_agg(DISTINCT usename, ',' ORDER BY usename) FROM pg_stat_activity
        WHERE datname = 'heopress' AND backend_type = 'client backend' AND host(client_addr) IN ($list)")"
      [ -n "$roles" ] && break
      sleep 1
    done
    case "$svc" in site-classic) want=heopress_render ;; *) want=heopress_app ;; esac
    [ "$roles" = "$want" ] || fail "$svc database sessions are ${roles:-none}, expected $want only"
    n="$(db_role_psql "SELECT count(*) FROM pg_stat_activity WHERE datname = 'heopress' AND host(client_addr) IN ($list)")"
    echo "  $svc: $n session(s), all $want"
  done
  roles_all="$(db_role_psql "SELECT coalesce(string_agg(DISTINCT usename, ',' ORDER BY usename), '') FROM pg_stat_activity
    WHERE datname = 'heopress' AND backend_type = 'client backend' AND pid <> pg_backend_pid()")"
  case ",$roles_all," in
    *,heopress_app,*) ;;
    *) fail "no heopress_app session at all (sessions: $roles_all)" ;;
  esac
  [ -z "$(echo "$roles_all" | tr ',' '\n' | grep -vxE 'heopress_app|heopress_render' || true)" ] \
    || fail "sessions of other roles than heopress_app and heopress_render: $roles_all"
  echo "  database sessions: $roles_all only (no owner session)"

  for svc in cms cms-worker; do
    # PID 1 is the server (the entrypoint exec'd it): its own DATABASE_URL, handed to the check inside the container.
    out="$("${db_role_compose[@]}" exec -T "$svc" sh -c \
      'u="$(tr "\0" "\n" < /proc/1/environ | sed -n "s/^DATABASE_URL=//p")"; exec env -i PATH="$PATH" HOME=/tmp DATABASE_URL="$u" node dist/app-role.mjs --check' 2>&1)" \
      || fail "$svc: the server's connection fails the role check: $out"
    case "$out" in *'heopress_app: row-level security applies'*) ;; *) fail "$svc: unexpected role check output: $out" ;; esac
    leaked="$("${db_role_compose[@]}" exec -T "$svc" sh -c "tr '\\0' '\\n' < /proc/1/environ | cut -d= -f1 | grep -E '^(DATABASE_OWNER_URL|HEOPRESS_APP_PASSWORD|HEOPRESS_RENDER_PASSWORD|HEOPRESS_RENDER_DATABASE_URL)' || true")"
    [ -z "$leaked" ] || fail "$svc server keeps $(echo "$leaked" | tr '\n' ' ')"
    echo "  $svc: the server's connection is heopress_app, RLS applies (live probe: 1 of 2 rows); no owner URL or role password in its environment"
  done
}
