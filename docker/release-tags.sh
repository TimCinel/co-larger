#!/usr/bin/env bash
# Decide which tags of docker.io/timcinel/co-larger a release build may push.
# Usage: docker/release-tags.sh VERSION COMMIT   (COMMIT: the full hash of HEAD)
# Prints one tag per line (the version, the 12-character commit, maybe
# latest) or explains on stderr and exits 1. Used by docker/build.sh.
#
# Version and commit tags are immutable by convention:
# - VERSION must be YYYY.MM.N, and the tag VERSION on $REMOTE must exist and
#   point at COMMIT (so a moved or missing tag publishes nothing);
# - the version tag must not exist on Docker Hub yet, unless ALLOW_RETAG=1
#   (a deliberate rebuild by hand); an existing commit tag is left alone;
# - if Docker Hub cannot say whether a tag exists, stop (ci/hub-tag.sh);
# - latest is included only when VERSION is the highest YYYY.MM.N tag on
#   $REMOTE, so an older or re-run release leaves latest alone.
# REMOTE defaults to core when that remote exists, else origin. GIT and
# HUB_CURL override the commands (tests).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${1:?version}
FULL=${2:?commit}
REV=${FULL:0:12}
GIT=${GIT:-git}
if [ -z "${REMOTE:-}" ]; then
  if $GIT remote | grep -qx core; then REMOTE=core; else REMOTE=origin; fi
fi
release='^[0-9]{4}\.[0-9]{2}\.[0-9]+$'

if ! [[ "$VERSION" =~ $release ]]; then
  echo "Version $VERSION is not a release version (YYYY.MM.N); not publishing." >&2
  exit 1
fi
if ! [[ "$FULL" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Commit $FULL is not a full commit hash; not publishing." >&2
  exit 1
fi

# Without --refs, annotated tags also list "<commit> refs/tags/X^{}".
if ! remote_tags=$($GIT ls-remote --tags "$REMOTE"); then
  echo "Cannot list tags on $REMOTE; not publishing." >&2
  exit 1
fi
tagged=$(printf '%s\n' "$remote_tags" | awk -v r="refs/tags/$VERSION^{}" '$2 == r { print $1 }')
if [ -z "$tagged" ]; then
  tagged=$(printf '%s\n' "$remote_tags" | awk -v r="refs/tags/$VERSION" '$2 == r { print $1 }')
fi
if [ -z "$tagged" ]; then
  echo "Tag $VERSION does not exist on $REMOTE; tag the release first (docs/releasing.md)." >&2
  exit 1
fi
if [ "$tagged" != "$FULL" ]; then
  echo "Tag $VERSION on $REMOTE points at $tagged, not $FULL; not publishing." >&2
  exit 1
fi
highest=$(printf '%s\n' "$remote_tags" | awk '{ print $2 }' | sed -n 's#^refs/tags/##p' |
  grep -E "$release" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)

if ! version_state=$(ci/hub-tag.sh co-larger "$VERSION"); then
  echo "Cannot tell whether co-larger:$VERSION exists on Docker Hub; not publishing." >&2
  exit 1
fi
if ! commit_state=$(ci/hub-tag.sh co-larger "$REV"); then
  echo "Cannot tell whether co-larger:$REV exists on Docker Hub; not publishing." >&2
  exit 1
fi

if [ "$version_state" = found ] && [ "${ALLOW_RETAG:-0}" != 1 ]; then
  echo "co-larger:$VERSION already exists; not overwriting it. To rebuild it deliberately, run docker/build.sh by hand with ALLOW_RETAG=1." >&2
  exit 1
fi
echo "$VERSION"
if [ "$commit_state" = found ] && [ "${ALLOW_RETAG:-0}" != 1 ]; then
  echo "co-larger:$REV already exists; leaving it as it is." >&2
else
  echo "$REV"
fi
if [ "$VERSION" = "$highest" ]; then
  echo latest
else
  echo "$VERSION is not the highest release tag ($highest); latest left alone." >&2
fi
