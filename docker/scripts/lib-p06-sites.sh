# Shared by docker/scripts/bench-p06-classic.sh and e2e-p06-sites.sh (HeoPress P06 tasks 6.1, 7.4):
# public sites on a fresh minimal deployment. Sourced; expects `base` (the CMS URL), `compose` (the
# docker compose command as an array) and `fail`.
#
#   new_site <id> <name> <starter-theme>   → sets `token` (the administrator's, for that site)
#
# Through the API only (P07 task 0.1): the instance administrator creates the site (and so becomes its
# Administrator), then adds a free subdomain made primary and installs and activates a starter theme.
# `p06_psql` is for the scripts' read-only checks.

p06_email='smoke-admin@example.test'
p06_password='Smoke-Test-Pass-1!'

p06_psql() { "${compose[@]}" exec -T postgres psql -U heopress -d heopress -v ON_ERROR_STOP=1 -tAc "$1"; }
p06_json() { node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).data[process.argv[1]]))' "$1"; }

# Tokens are bound to a site: the administrator logs in to each one.
login() {
  curl -fs -X POST "$base/api/v1/auth/login" -H 'content-type: application/json' -H "x-heopress-site: $1" \
    -d "{\"email\":\"$p06_email\",\"password\":\"$p06_password\"}" | p06_json token
}

api() { # method path site [json]
  curl -fsS -X "$1" "$base$2" -H "authorization: Bearer $token" -H "x-heopress-site: $3" -H 'content-type: application/json' ${4:+-d "$4"}
}

new_site() { # id name theme
  local id="$1" name="$2" theme="$3" domain version
  # Interpolated into JSON below: a site id is lowercase letters, digits and hyphens only.
  [[ "$id" =~ ^[a-z0-9][a-z0-9-]{0,62}$ && "$theme" =~ ^[a-z]+$ && "$name" =~ ^[A-Za-z0-9\ ]+$ ]] || fail "bad site id, name or theme"
  token=$(login __default__)
  [ -n "$token" ] || fail "no administrator token"
  # The instance administrator creates the site and becomes its Administrator in the same step (P07 task 0.1).
  api POST /api/v1/instance/sites __default__ "{\"id\":\"$id\",\"name\":\"$name\"}" >/dev/null
  token=$(login "$id")
  [ -n "$token" ] || fail "no token for $id"
  domain=$(api POST /api/v1/domains "$id" "{\"kind\":\"subdomain\",\"hostname\":\"$id\"}" | p06_json id)
  api POST "/api/v1/domains/$domain/primary" "$id" >/dev/null
  version=$(api POST "/api/v1/themes/starters/$theme" "$id" | p06_json id)
  api POST "/api/v1/themes/versions/$version/activate" "$id" >/dev/null
}
