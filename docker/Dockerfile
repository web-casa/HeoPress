# Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
# Stage 1: Build
FROM node:24-slim AS builder
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Every workspace tsconfig extends this. The CMS bundles fine without it because
# esbuild does not typecheck, but the Studio build runs `tsc -b` and
# without the base config it silently falls back to defaults — ES5 target and no
# `@types/node`, which surfaces as a wall of TS2307/TS2802 errors from packages
# that compile perfectly outside the image.
COPY tsconfig.base.json ./
COPY scripts/ ./scripts/
COPY packages/ ./packages/
COPY apps/cms/ ./apps/cms/
# The Studio SPA ships inside this image so a Docker deployment has an admin UI
# at all. Until now nothing shipped it: no compose file referenced it and this
# stage copied only apps/cms, so `docker compose up` gave an API and `GET /setup`
# answered 404. `serve.ts` mounts whatever lands in /app/studio below.
COPY apps/studio/ ./apps/studio/
# The rendering service (HeoPress P06), built only for `--target site-classic`.
COPY apps/site-classic/ ./apps/site-classic/
RUN pnpm install --frozen-lockfile
# Build metadata for `/api/v1/system/version` and the Studio footer. The build
# context has no .git, so the commit must come in as a build arg; the version
# is read from the root package.json. Unset args fall back to "unknown" /
# "development" (scripts/with-build-metadata.mjs).
ARG HEOPRESS_GIT_SHA
ARG HEOPRESS_RELEASE_CHANNEL
# Build the Node.js server entrypoint (serve.cjs) and migration runner (migrate.cjs)
RUN pnpm --filter @heopress/cms build
# VITE_API_URL is deliberately left unset: the Studio and the CMS answer on the
# same origin here, so the SPA uses relative requests and no CORS entry is
# needed. Setting it would hard-code an origin into the bundle.
RUN pnpm --filter @heopress/studio build

# The public-site rendering service (HeoPress P06 task 5.2; docs/zh-CN/rendering/site-classic.md):
#   docker build -f docker/Dockerfile --target site-classic -t heopress-site-classic .
# One bundle (the server and its theme worker), no source, no package manager (removed below). It connects as the
# read-only rendering role and listens on 2027 behind Caddy. The default target below stays the CMS.
FROM builder AS site-classic-build
RUN pnpm --filter @heopress/site-classic build

FROM node:24-slim AS site-classic
# Node only: no package manager in the image that serves the public.
# Debian security updates published since the base image was built are installed at build time (P07 task 8.1):
# dist-upgrade (an update that needs a new dependency is not kept back), and the build fails if anything is still
# pending — a fixable finding must be fixed here, not excepted. The simulation's own failure fails the build too
# (its output is captured first, so a failing apt-get is never read as "nothing pending").
RUN apt-get update && apt-get -y --no-install-recommends dist-upgrade \
  && pending="$(apt-get -s dist-upgrade)" \
  && if printf '%s\n' "$pending" | grep -E '^Inst |kept back'; then echo 'Debian updates are still pending (kept back): the image must take every published fix' >&2; exit 1; fi \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && addgroup --system heopress && adduser --system --ingroup heopress heopress
WORKDIR /app
COPY --from=site-classic-build /app/apps/site-classic/dist ./dist
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
USER heopress
ENV NODE_ENV=production PORT=2027
EXPOSE 2027
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://127.0.0.1:2027/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/serve.mjs"]

# Stage 2: Runtime
FROM node:24-slim AS runtime
# Node only, as in the rendering service: the CMS runs no package manager at run time (the entrypoint and the
# server call `node` only; extensions are bundles, not installs), and npm's own bundled dependencies were the
# fixable findings of the image scan (P07 task 8.1).
# Debian security updates published since the base image was built are installed at build time (P07 task 8.1):
# dist-upgrade (an update that needs a new dependency is not kept back), and the build fails if anything is still
# pending — a fixable finding must be fixed here, not excepted. The simulation's own failure fails the build too
# (its output is captured first, so a failing apt-get is never read as "nothing pending").
RUN apt-get update && apt-get -y --no-install-recommends dist-upgrade \
  && pending="$(apt-get -s dist-upgrade)" \
  && if printf '%s\n' "$pending" | grep -E '^Inst |kept back'; then echo 'Debian updates are still pending (kept back): the image must take every published fix' >&2; exit 1; fi \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && addgroup --system heopress && adduser --system --ingroup heopress heopress
WORKDIR /app
COPY --from=builder /app/apps/cms/dist ./dist
# Drizzle migration SQL files must be present at ./drizzle relative to CWD
COPY --from=builder /app/packages/database/drizzle ./drizzle
# Studio bundle, resolved by serve.ts as ./studio relative to CWD. Override with
# HEOPRESS_STUDIO_DIST, or set HEOPRESS_SERVE_STUDIO=false to run API-only when
# the Studio is hosted separately (e.g. Cloudflare Pages) and two copies would
# risk version skew.
COPY --from=builder /app/apps/studio/dist ./studio
# License and attribution files (AGPL-3.0-only, upstream Apache-2.0, NOTICE).
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY LICENSES ./LICENSES
COPY docker/scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# Local media storage (HEOPRESS_STORAGE=local, the default): a volume mounted
# here inherits this ownership, so the unprivileged user can write to it.
RUN mkdir -p /app/data/storage && chown -R heopress:heopress /app/data
USER heopress
EXPOSE 1989
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://localhost:1989/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/entrypoint.sh"]
