#!/usr/bin/env sh
# Does Docker Hub have timcinel/<repo>:<tag>?  Usage: ci/hub-tag.sh REPO TAG
# Prints "found" or "missing" and exits 0 only when Docker Hub's web API gives
# a definite answer: HTTP 200 with a JSON body naming that tag, or HTTP 404.
# Anything else (network error, rate limit, server error, unexpected body)
# prints the reason on stderr and exits 2, so callers can fail closed: an
# existing tag must never be overwritten because a lookup failed.
# HUB_CURL overrides the curl command (tests).
set -u
REPO=${1:?repository name}
TAG=${2:?tag}
CURL=${HUB_CURL:-curl}
URL=https://hub.docker.com/v2/namespaces/timcinel/repositories/$REPO/tags/$TAG

body=$(mktemp) || exit 2
trap 'rm -f "$body"' EXIT
code=$($CURL -sS --max-time 20 -o "$body" -w '%{http_code}' "$URL") || {
  echo "hub-tag: request for $REPO:$TAG failed (curl exit $?)" >&2
  exit 2
}
case $code in
  200)
    # Compact or spaced JSON; the body must name exactly this tag.
    compact=$(tr -d ' \n\t\r' <"$body")
    if [ "${compact%"${compact#?}"}" = "{" ] &&
      printf '%s' "$compact" | grep -qF "\"name\":\"$TAG\""; then
      echo found
      exit 0
    fi
    echo "hub-tag: HTTP 200 for $REPO:$TAG but the body does not name it" >&2
    exit 2
    ;;
  404)
    echo missing
    exit 0
    ;;
  *)
    echo "hub-tag: HTTP $code for $REPO:$TAG; not sure whether it exists" >&2
    exit 2
    ;;
esac
