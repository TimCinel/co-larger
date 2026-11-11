#!/usr/bin/env bash
# Build the app image for linux/amd64 and linux/arm64 and push one multi-arch
# manifest to Docker Hub, tagged with the short commit, `latest` and (when
# package.json carries one) the version. Requires `docker login` (Docker Hub)
# beforehand and a clean working tree, so an image always matches a commit.
# CI runs it when a release tag is pushed (.forgejo/workflows/release-image.yaml).
# The source and url labels are set empty on purpose: they would otherwise be
# inherited from the nginx base image and point at its repository. Add a public
# URL once the project has one; do not use an internal host name here.
# Set PUSH=0 to build for the local platform only and load it instead;
# PLATFORM=linux/amd64,linux/arm64 with PUSH=0 builds both without pushing
# (needs a Docker with the containerd image store).
# Set EXPECT_VERSION to fail unless package.json has that version (CI passes
# the release tag, so an image is never pushed under the wrong version).
# Publishing (PUSH=1) first runs docker/release-tags.sh: the release tag must
# exist on the remote at HEAD, an existing version is never overwritten
# (ALLOW_RETAG=1 deliberately rebuilds one, by hand only), and latest moves
# only for the highest release. REMOTE names the remote (default: core if it
# exists, else origin).
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

if [ -n "${EXPECT_VERSION:-}" ] && [ "$EXPECT_VERSION" != "$VERSION" ]; then
  echo "package.json has version $VERSION, expected $EXPECT_VERSION; not building." >&2
  exit 1
fi

if [ "${PUSH:-1}" = 0 ]; then
  TAGS=(-t "$REPO:latest" -t "$REPO:$REV")
  # 0.0.0 is the placeholder before the first release; it is not a version.
  if [ "$VERSION" != "0.0.0" ]; then TAGS+=(-t "$REPO:$VERSION"); fi
  TARGET=(--load)
  PLATFORM=${PLATFORM:-}
else
  # Publishing: docker/release-tags.sh decides which tags may be pushed
  # (never an existing version, latest only for the highest release).
  if ! release_tags=$(docker/release-tags.sh "$VERSION" "$FULL"); then
    exit 1
  fi
  TAGS=()
  for t in $release_tags; do TAGS+=(-t "$REPO:$t"); done
  TARGET=(--push)
  PLATFORM=linux/amd64,linux/arm64
fi

docker buildx build ${PLATFORM:+--platform "$PLATFORM"} -f Dockerfile \
  --provenance=false --sbom=false \
  --build-arg "GIT_COMMIT=$FULL" \
  --label org.opencontainers.image.title=co-larger \
  --label "org.opencontainers.image.description=co-larger: a client-side photo collage maker, served as a static site by nginx" \
  --label "org.opencontainers.image.version=$REV" \
  --label "org.opencontainers.image.revision=$FULL" \
  --label "org.opencontainers.image.created=$CREATED" \
  --label "org.opencontainers.image.url=" \
  --label "org.opencontainers.image.source=" \
  --label org.opencontainers.image.licenses=MIT \
  "${TAGS[@]}" "${TARGET[@]}" .

if [ "${PUSH:-1}" = 0 ]; then
  echo "Built $REPO:$REV${PLATFORM:+ for $PLATFORM} locally (not pushed)"
else
  for t in $release_tags; do echo "Pushed $REPO:$t"; done
  docker buildx imagetools inspect "$REPO:$VERSION"
fi
