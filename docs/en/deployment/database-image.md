# Database image and extensions

HeoPress needs only PostgreSQL 18. Two capabilities depend on extensions that a stock `postgres:18` image does not ship, so the repository provides a database image that adds them:

| Extension | Source | Needed for | Without it |
|---|---|---|---|
| `pg_trgm` | PostgreSQL contrib (every image) | fuzzy search; Chinese search fallback | **required**: migrations and readiness fail |
| `vector` | pgvector (PGDG package) | vector search (`HEOPRESS_VECTOR_SEARCH=true`) | readiness fails only when vector search is enabled |
| `zhparser` | zhparser + SCWS, built from pinned commits | Chinese word segmentation in full-text search | still ready; Chinese search uses `pg_trgm` matching and readiness reports a notice |

## Building the image

```bash
docker build -f docker/postgres/Dockerfile -t heopress-postgres:18 docker/postgres
docker/postgres/verify-extensions.sh heopress-postgres:18
```

The Dockerfile pins zhparser and SCWS to commits and checks their SHA-256 before building. CI builds and verifies the image for `linux/amd64` and `linux/arm64` (job `db-image`). The license texts of zhparser and SCWS are copied to `/usr/share/doc/heopress-postgres/` in the image.

### Restricted networks

The build fetches the SCWS and zhparser tarballs from github.com by default. When the build host cannot reach it,
either point the two build arguments at a mirror:

```bash
docker build -f docker/postgres/Dockerfile -t heopress-postgres:18 \
  --build-arg SCWS_URL=https://mirror.example/scws.tar.gz \
  --build-arg ZHPARSER_URL=https://mirror.example/zhparser.tar.gz \
  docker/postgres
```

or vendor the tarballs, which needs no outbound access at all:

```bash
# name each file after the SHA-256 the Dockerfile pins, then build normally
curl -fsSL -o docker/postgres/vendor/c4f83883bf453aa9829a36abea76a11d546016fe639838b72b66bfca9f7f4d0d.tar.gz \
  https://github.com/hightman/scws/archive/a04ef5e655213eb6b07fb57761d0eac72c281ad4.tar.gz
```

`docker/postgres/vendor/README.md` lists both names. `*.tar.gz` there is ignored by Git. Either way the SHA-256 check
runs before anything is unpacked: a mirror that serves different bytes fails the build rather than reaching the image.
With `docker/install.sh`, pass the same value through `--db-build-arg SCWS_URL=…`, or skip the image entirely with
`--db-image postgres:18` (see below).

### Installing without the extensions

`--db-image postgres:18` runs HeoPress on the stock image: no `vector` and no `zhparser`. `pg_trgm` still ships with
PostgreSQL, so Chinese search falls back to trigram matching (readiness reports a notice) and vector search must stay
off. This is a deliberate degradation for hosts that cannot build the image — not the recommended deployment.

The image replaces the upstream `gosu` binary (Go, used by the official entrypoint to drop from root to the `postgres` user) with a small shell script that does the same through `setpriv` from util-linux. `gosu user[:group] command…` keeps working, including in your own init scripts; the server still runs as `postgres`, never as root, and `verify-extensions.sh` checks that.

## Who creates the extensions

The migrate script (`pnpm db:migrate`) runs as the table owner and, before applying migrations, creates the extensions this deployment uses:

- `pg_trgm` always (a trusted extension; failing to create it stops the migration);
- `vector` only when `HEOPRESS_VECTOR_SEARCH=true` — if the server does not offer it or the role may not install it, the migration stops and says why. After enabling vector search on an existing deployment, run the migrate script again;
- `zhparser` when the server offers it and the role may install it, plus the text search configuration `heopress_zh`. If it cannot be installed (it is not a trusted extension, so a non-superuser owner usually cannot), the migration continues and Chinese search uses `pg_trgm`.

The application role never needs `CREATE` privileges. Availability is not permission: see [CREATE EXTENSION](https://www.postgresql.org/docs/18/sql-createextension.html).

## Readiness

`/health/ready` (API) and the worker's `/health/ready` include an `extensions` check. It reads `pg_extension` and compares it with what the deployment enables:

- `pg_trgm` missing → not ready;
- `HEOPRESS_VECTOR_SEARCH=true` and `vector` missing → not ready, naming the missing extension;
- vector search off → the `vector` extension is not required;
- `zhparser` missing → ready; trusted callers see `capabilities.chineseSearch: "trgm"` and a notice.
