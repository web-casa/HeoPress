# The Astro build image (HeoPress v1.5, spec rendering/astro-build-sandbox)
#
# A build runs in this image as one throw-away container: read-only root, only the build's input and output mounted, and
# no network at all. The image therefore provides the *runtime* only — Node and the few system libraries Astro's toolchain
# needs. Dependencies come from the mounted template (`/in/node_modules`), which is why a theme cannot add a package at
# build time: there is no registry to reach.
#
# Build and tag it as `heopress-astro-build:1` (or set HEOPRESS_ASTRO_BUILD_IMAGE):
#
#   docker build -t heopress-astro-build:1 docker/astro-build
#   podman build -t heopress-astro-build:1 docker/astro-build
#
# Keep the Node major aligned with the CMS's: an Astro build is a Node program, and a mismatch between the host's
# `node_modules` binaries and this runtime is exactly the kind of difference that only shows up under a real theme.
FROM node:24-bookworm-slim

# The build runs as a non-root user; its HOME is a tmpfs the plan mounts at /tmp.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin builder \
 && mkdir -p /in /out \
 && chown builder:builder /out

# `git` is deliberately absent: a build has no network, and a theme that wants a dependency must have it in the template.
# `ca-certificates` stays because Astro's toolchain reads bundled certificates at import time even without network.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    ASTRO_TELEMETRY_DISABLED=1

USER builder:builder
WORKDIR /in

# The container command is the template's Astro, supplied by the plan (sandboxPlan). A default makes the image runnable
# on its own for a smoke test (`docker run --rm heopress-astro-build:1 node --version`).
CMD ["node", "--version"]
