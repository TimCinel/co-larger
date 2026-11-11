#!/usr/bin/env bash
# Build the CI builder image (ci/Dockerfile, linux/amd64) and, with PUSH=1,
# publish it to Docker Hub as :<tag> (ci/tag.sh) and move :latest to it.
# CI runs this on master (.forgejo/workflows/builder-image.yaml); the caller
# logs in to Docker Hub first. See ci/README.md.
#
#   PUSH=0 (default)  build only, push nothing (pull requests, local checks).
#   PUSH=1            publish. <tag> is never overwritten: if Docker Hub has it
#                     the build is skipped, and if Docker Hub cannot say
#                     (network, rate limit, error) the script fails.
#                     :latest is moved only when HEAD is the tip of master on
#                     $REMOTE (checked just before moving it), so an older run
#                     finishing late cannot move it backwards.
#   REMOTE            the Git remote for that check (default: origin, or core
#                     when it exists, as in a developer checkout).
#   TAG=..., LATEST=0 testing only: publish a throwaway tag, leave :latest.
#   DOCKER, GIT, HUB_CURL override those commands (tests only).
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=co-larger-builder
REPO=docker.io/timcinel/$NAME
TAG=${TAG:-$(ci/tag.sh)}
PUSH=${PUSH:-0}
LATEST=${LATEST:-1}
DOCKER=${DOCKER:-docker} # overridable for tests (ci/test-scripts.sh)
GIT=${GIT:-git}
if [ -z "${REMOTE:-}" ]; then
  if $GIT remote | grep -qx core; then REMOTE=core; else REMOTE=origin; fi
fi

build() {
  # No source or url labels: they would point at an internal host name.
  $DOCKER buildx build --platform linux/amd64 -f ci/Dockerfile \
    --provenance=false --sbom=false \
    --build-arg "BUILDER_TAG=$TAG" \
    --label org.opencontainers.image.title=co-larger-builder \
    --label "org.opencontainers.image.description=co-larger CI builder: Node with the project's npm dependencies installed" \
    --label "org.opencontainers.image.version=$TAG" \
    --label "org.opencontainers.image.revision=$($GIT rev-parse HEAD)" \
    --label org.opencontainers.image.licenses=MIT \
    "$@" .
}

if [ "$PUSH" != 1 ]; then
  build -t "co-larger-builder:$TAG"
  echo "Built co-larger-builder:$TAG (not pushed)"
  exit 0
fi

if ! state=$(ci/hub-tag.sh "$NAME" "$TAG"); then
  echo "Cannot tell whether $REPO:$TAG exists; not pushing (see above)." >&2
  exit 1
fi
if [ "$state" = found ]; then
  echo "$REPO:$TAG already exists; not rebuilding or overwriting it."
else
  build -t "$REPO:$TAG" --push
  echo "Pushed $REPO:$TAG"
fi

if [ "$LATEST" != 1 ]; then
  echo "LATEST=0: $REPO:latest left alone."
  exit 0
fi
head=$($GIT rev-parse HEAD)
if ! tip=$($GIT ls-remote --exit-code "$REMOTE" refs/heads/master | cut -f1); then
  echo "Cannot read master's tip from $REMOTE; $REPO:latest not moved." >&2
  exit 1
fi
if [ "$tip" != "$head" ]; then
  echo "HEAD ($head) is no longer master's tip ($tip); $REPO:latest left alone."
  exit 0
fi
$DOCKER buildx imagetools create --tag "$REPO:latest" "$REPO:$TAG"
echo "Moved $REPO:latest to $REPO:$TAG"
