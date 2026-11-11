#!/usr/bin/env bash
# Build the app image for linux/amd64 and linux/arm64 and push one multi-arch
# manifest to Docker Hub, tagged with the short commit, `latest` and (when
# package.json carries one) the version. Requires `docker login` (Docker Hub)
# beforehand and a clean working tree, so an image always matches a commit.
# Set PUSH=0 to build for the local platform only and load it instead.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "Working tree is not clean; commit or remove changes first." >&2
  exit 1
fi

REPO=docker.io/timcinel/co-larger
REV=$(git rev-parse --short=12 HEAD)
FULL=$(git rev-parse HEAD)
VERSION=$(node -p "require('./package.json').version")
CREATED=$(git log -1 --format=%cI)

TAGS=(-t "$REPO:latest" -t "$REPO:$REV")
# 0.0.0 is the placeholder before the first release; it is not a version.
if [ "$VERSION" != "0.0.0" ]; then TAGS+=(-t "$REPO:$VERSION"); fi

if [ "${PUSH:-1}" = 0 ]; then
  TARGET=(--load)
  PLATFORM=
else
  TARGET=(--push)
  PLATFORM=linux/amd64,linux/arm64
fi

docker buildx build ${PLATFORM:+--platform "$PLATFORM"} -f Dockerfile \
  --provenance=false --sbom=false \
  --label org.opencontainers.image.title=co-larger \
  --label "org.opencontainers.image.description=co-larger: a client-side photo collage maker, served as a static site by nginx" \
  --label "org.opencontainers.image.version=$REV" \
  --label "org.opencontainers.image.revision=$FULL" \
  --label "org.opencontainers.image.created=$CREATED" \
  --label "org.opencontainers.image.url=" \
  --label org.opencontainers.image.licenses=MIT \
  "${TAGS[@]}" "${TARGET[@]}" .

if [ "${PUSH:-1}" = 0 ]; then
  echo "Built $REPO:$REV locally (not pushed)"
else
  echo "Pushed $REPO:$REV (also latest)"
  docker buildx imagetools inspect "$REPO:$REV"
fi
