#!/usr/bin/env sh
# Print the builder image tag for this checkout:
#   lock-<12 hex of sha256(package-lock.json)>-<8 hex of sha256(ci/Dockerfile)>
# The tag names the image's content, so it is never reused for a different
# image: a new lockfile or Dockerfile gives a new tag. See ci/README.md.
set -eu
cd "$(dirname "$0")/.."
if command -v sha256sum >/dev/null 2>&1; then
  sum() { sha256sum "$1" | cut -c1-"$2"; }
else
  sum() { shasum -a 256 "$1" | cut -c1-"$2"; }
fi
echo "lock-$(sum package-lock.json 12)-$(sum ci/Dockerfile 8)"
