# CI builder image: node plus this project's dependencies, ready to use.
# See ci/README.md. Build with ci/build.sh (context is the repo root).
FROM docker.io/library/node:24-bookworm@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40

# Fixed, world-readable and writable npm cache, independent of the job's user
# or HOME. Used as a fallback when the lockfile has moved on.
ENV npm_config_cache=/opt/npm-cache

# /opt/deps holds an installed node_modules for the lockfile whose sha256 is in
# /opt/deps/lock.sha256. The CI job symlinks it into the checkout when the
# hashes match, avoiding the (CPU-bound) unpack on a slow runner. Lifecycle
# scripts are skipped; nothing in this project needs them.
RUN --mount=type=bind,source=package.json,target=/src/package.json \
    --mount=type=bind,source=package-lock.json,target=/src/package-lock.json \
    mkdir -p /opt/npm-cache /opt/deps \
    && cp /src/package.json /src/package-lock.json /opt/deps/ \
    && cd /opt/deps \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && sha256sum package-lock.json | cut -d' ' -f1 > lock.sha256 \
    && rm package.json package-lock.json \
    && cd / && rm -rf /tmp/node-compile-cache /root/.cache \
       /opt/npm-cache/_logs /opt/npm-cache/_update-notifier-last-checked \
    && chmod -R a+rwX /opt/npm-cache /opt/deps
