# HeoPress database image (P03 task 1.1, ADR-0002): PostgreSQL 18 with the
# extensions HeoPress can use.
#   - pgvector (PostgreSQL License): vector similarity search, from the PGDG apt repo
#   - zhparser (PostgreSQL License) + SCWS (BSD): Chinese word segmentation for full-text search
#   - pg_trgm ships with PostgreSQL (contrib)
# Extensions are only installed into the image; migrations and the readiness
# check decide which ones a deployment needs (see docs/en/deployment/database-image.md).
#
#   docker build -f docker/postgres/Dockerfile -t heopress-postgres:18 .
#
# Sources are pinned to commits and verified by SHA-256.

ARG PG_MAJOR=18

FROM postgres:${PG_MAJOR} AS build
ARG PG_MAJOR
ARG SCWS_COMMIT=a04ef5e655213eb6b07fb57761d0eac72c281ad4
ARG SCWS_SHA256=c4f83883bf453aa9829a36abea76a11d546016fe639838b72b66bfca9f7f4d0d
ARG ZHPARSER_COMMIT=2e995c4df672563992b4d7a147b8fa2d0d4cda6c
ARG ZHPARSER_SHA256=ce5d5e21a1c1f8b3f466998fba0efe51928aad6e12026b5e30ecd2afbfa3285e

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      autoconf automake ca-certificates curl gcc libtool make pkg-config \
      "postgresql-server-dev-${PG_MAJOR}" \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN curl -fsSL -o scws.tar.gz "https://github.com/hightman/scws/archive/${SCWS_COMMIT}.tar.gz" \
 && echo "${SCWS_SHA256}  scws.tar.gz" | sha256sum -c - \
 && tar xzf scws.tar.gz && cd "scws-${SCWS_COMMIT}" \
 && autoreconf -fi && ./configure --prefix=/usr/local && make -j"$(nproc)" && make install

RUN curl -fsSL -o zhparser.tar.gz "https://github.com/amutu/zhparser/archive/${ZHPARSER_COMMIT}.tar.gz" \
 && echo "${ZHPARSER_SHA256}  zhparser.tar.gz" | sha256sum -c - \
 && tar xzf zhparser.tar.gz && cd "zhparser-${ZHPARSER_COMMIT}" \
 && SCWS_HOME=/usr/local make -j"$(nproc)" \
 && SCWS_HOME=/usr/local make install DESTDIR=/out \
 && mkdir -p /out/usr/local/lib /out/licenses \
 && cp -a /usr/local/lib/libscws.so* /out/usr/local/lib/ \
 && cp COPYRIGHT /out/licenses/zhparser-COPYRIGHT \
 && cp "/src/scws-${SCWS_COMMIT}/COPYING" /out/licenses/scws-COPYING

FROM postgres:${PG_MAJOR}
ARG PG_MAJOR
LABEL org.opencontainers.image.title="heopress-postgres" \
      org.opencontainers.image.description="PostgreSQL ${PG_MAJOR} with pgvector and zhparser for HeoPress"

# Debian security updates published since the base image was built are installed too (P07 task 8.1): dist-upgrade
# (nothing kept back for a new dependency), and the build fails if any update is still pending — or if the
# simulation itself fails (its output is captured first, so a failing apt-get is never read as "nothing pending").
RUN apt-get update \
 && apt-get -y --no-install-recommends dist-upgrade \
 && pending="$(apt-get -s dist-upgrade)" \
 && if printf '%s\n' "$pending" | grep -E '^Inst |kept back'; then echo 'Debian updates are still pending (kept back): the image must take every published fix' >&2; exit 1; fi \
 && apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}-pgvector" \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/usr/ /usr/
COPY --from=build /out/licenses/ /usr/share/doc/heopress-postgres/
RUN ldconfig \
 && test -f "/usr/share/postgresql/${PG_MAJOR}/extension/vector.control" \
 && test -f "/usr/share/postgresql/${PG_MAJOR}/extension/zhparser.control"
