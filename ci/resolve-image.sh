#!/usr/bin/env sh
# Print the builder image CI should run in (see ci/README.md):
#   1. the image for this checkout's lockfile and ci/Dockerfile (ci/tag.sh),
#      if Docker Hub's web API answers with a JSON body naming that tag;
#   2. otherwise the most recently pushed lock-* tag, from one page of the
#      100 most recently updated tags (Docker Hub's largest page; builder
#      tags are few, so the newest lock-* tag is always on it);
#   3. otherwise :latest.
# 2 and 3 may not match this checkout; CI then installs with npm ci, slower
# but equally correct. Only names of the forms lock-<12 hex>-<8 hex> and
# lock-<12 hex>[-rN] (built by hand before CI) are ever printed.
# Always exits 0 with a usable image reference. Each request is limited to
# RESOLVE_TIMEOUT seconds (default 8) and the whole script to two requests,
# so it finishes in well under 20 seconds whatever the network does.
# Needs curl or wget (busybox wget is enough); HUB_FETCH overrides the
# fetch command (tests): it gets the URL and prints the body, failing on any
# HTTP error.
set -u
NS=timcinel
NAME=co-larger-builder
IMAGE=docker.io/$NS/$NAME
API=https://hub.docker.com/v2/namespaces/$NS/repositories/$NAME/tags
LIMIT=${RESOLVE_TIMEOUT:-8}

fallback() {
  echo "Using $IMAGE:latest (CI installs with npm ci if it differs)" >&2
  echo "$IMAGE:latest"
  exit 0
}
cd "$(dirname "$0")/.." || fallback

# Run "$@" with a time limit when a timeout command exists (busybox, GNU).
limited() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$LIMIT" "$@"
  else
    "$@"
  fi
}
fetch() {
  if [ -n "${HUB_FETCH:-}" ]; then
    # shellcheck disable=SC2086 # HUB_FETCH may carry arguments
    limited $HUB_FETCH "$1"
  elif command -v curl >/dev/null 2>&1; then
    limited curl -fsS --max-time "$LIMIT" "$1"
  else
    limited wget -q -T "$LIMIT" -O - "$1"
  fi
}
# Squash a JSON body onto one line without whitespace (tag names have none).
compact() { tr -d ' \n\t\r'; }

tag=$(ci/tag.sh 2>/dev/null) || tag=
if printf '%s' "$tag" | grep -Eqx 'lock-[0-9a-f]{12}-[0-9a-f]{8}'; then
  body=$(fetch "$API/$tag" 2>/dev/null | compact) || body=
  case $body in
    "{"*"\"name\":\"$tag\""*)
      echo "Builder image for this lockfile and ci/Dockerfile: $tag" >&2
      echo "$IMAGE:$tag"
      exit 0
      ;;
  esac
  echo "No usable answer for $tag (missing, or Docker Hub did not say)" >&2
else
  tag=
  echo "Cannot compute this checkout's builder tag" >&2
fi

# Newest builder tag. The body must be a tag listing ({"count":...,
# "results":[...]}); names are taken in order and must match exactly.
list=$(fetch "$API?page_size=100&ordering=last_updated" 2>/dev/null | compact) || list=
case $list in
  "{"*"\"results\":["*) ;;
  *) list= ;;
esac
newest=$(printf '%s' "$list" | grep -o '"name":"[^"]*"' | sed 's/^"name":"//; s/"$//' |
  grep -Ex 'lock-[0-9a-f]{12}(-[0-9a-f]{8}|-r[0-9]+)?' | head -n 1)
if [ -n "$newest" ]; then
  echo "Using the newest builder image, $newest (CI installs with npm ci if it differs)" >&2
  echo "$IMAGE:$newest"
  exit 0
fi
fallback
