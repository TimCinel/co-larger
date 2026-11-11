#!/usr/bin/env sh
# Print the builder image CI should run in (see ci/README.md):
#   1. the image for this checkout's lockfile and ci/Dockerfile (ci/tag.sh),
#      if Docker Hub has it;
#   2. otherwise the most recently pushed lock-* image (master's newest);
#   3. otherwise :latest.
# 2 and 3 may not match this checkout; CI then installs with npm ci, slower
# but equally correct. Uses Docker Hub's web API, not the registry, so the
# lookups do not count against pull limits. Never fails: errors fall back.
# Needs curl or wget (busybox wget is enough).
set -u
NS=timcinel
NAME=co-larger-builder
IMAGE=docker.io/$NS/$NAME
API=https://hub.docker.com/v2/namespaces/$NS/repositories/$NAME/tags
cd "$(dirname "$0")/.." || { echo "$IMAGE:latest"; exit 0; }

get() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 15 --retry 2 "$1"
  else
    wget -q -T 15 -O - "$1"
  fi
}

tag=$(ci/tag.sh 2>/dev/null) || tag=
if [ -n "$tag" ] && get "$API/$tag" >/dev/null 2>&1; then
  echo "Builder image for this lockfile and ci/Dockerfile: $tag" >&2
  echo "$IMAGE:$tag"
  exit 0
fi

newest=$(get "$API?page_size=25&ordering=last_updated" 2>/dev/null |
  grep -o '"name": *"lock-[0-9a-z-]*"' | head -n 1 | sed 's/.*"\(lock-[^"]*\)"/\1/')
if [ -n "$newest" ]; then
  echo "No builder image ${tag:-?} yet; using the newest, $newest (CI installs with npm ci if it differs)" >&2
  echo "$IMAGE:$newest"
else
  echo "No builder image ${tag:-?} found; using latest (CI installs with npm ci if it differs)" >&2
  echo "$IMAGE:latest"
fi
