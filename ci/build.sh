#!/usr/bin/env bash
# Build, tag and push the CI builder image (Docker Hub) for the current
# package-lock.json. Requires `docker login` (Docker Hub) beforehand.
# Bump REV when ci/Dockerfile changes without the lockfile changing.
set -euo pipefail
cd "$(dirname "$0")/.."
REV=r2
REPO=docker.io/timcinel/co-larger-builder
LOCK=lock-$(shasum -a 256 package-lock.json | cut -c1-12)-$REV
docker buildx build --platform linux/amd64 -f ci/Dockerfile \
  --provenance=false --sbom=false \
  -t "$REPO:latest" -t "$REPO:$LOCK" --push .
echo "Pushed $REPO:$LOCK"
echo "Update the image tag in .forgejo/workflows/ci.yaml to $LOCK"
