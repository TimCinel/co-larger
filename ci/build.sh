#!/usr/bin/env bash
# Build the CI builder image (ci/Dockerfile, linux/amd64) and, with PUSH=1,
# push it to Docker Hub as :<tag> and :latest, where <tag> is from ci/tag.sh.
# CI runs this on master (.forgejo/workflows/builder-image.yaml); the caller
# logs in to Docker Hub first. See ci/README.md.
#
#   PUSH=0 (default)  build only, push nothing (pull requests, local checks)
#   PUSH=1            push :<tag> and :latest. A tag names the image's
#                     content, so an existing tag is never rebuilt or
#                     overwritten; :latest is then pointed at it.
#   TAG=..., LATEST=0 testing only: push a throwaway tag and leave :latest.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=docker.io/timcinel/co-larger-builder
TAG=${TAG:-$(ci/tag.sh)}
PUSH=${PUSH:-0}
LATEST=${LATEST:-1}

if [ "$PUSH" = 1 ]; then
  if docker buildx imagetools inspect "$REPO:$TAG" >/dev/null 2>&1; then
    echo "$REPO:$TAG already exists; not rebuilding it."
    if [ "$LATEST" = 1 ]; then
      docker buildx imagetools create --tag "$REPO:latest" "$REPO:$TAG"
      echo "Pointed $REPO:latest at $REPO:$TAG"
    fi
    exit 0
  fi
  TAGS=(-t "$REPO:$TAG")
  if [ "$LATEST" = 1 ]; then TAGS+=(-t "$REPO:latest"); fi
  OUTPUT=(--push)
else
  TAGS=(-t "co-larger-builder:$TAG")
  OUTPUT=()
fi

# No source or url labels: they would point at an internal host name.
docker buildx build --platform linux/amd64 -f ci/Dockerfile \
  --provenance=false --sbom=false \
  --build-arg "BUILDER_TAG=$TAG" \
  --label org.opencontainers.image.title=co-larger-builder \
  --label "org.opencontainers.image.description=co-larger CI builder: Node with the project's npm dependencies installed" \
  --label "org.opencontainers.image.version=$TAG" \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  --label org.opencontainers.image.licenses=MIT \
  "${TAGS[@]}" "${OUTPUT[@]}" .

if [ "$PUSH" = 1 ]; then
  echo "Pushed $REPO:$TAG"
  if [ "$LATEST" = 1 ]; then echo "Pushed $REPO:latest"; fi
  docker buildx imagetools inspect "$REPO:$TAG"
else
  echo "Built $REPO:$TAG (not pushed)"
fi
