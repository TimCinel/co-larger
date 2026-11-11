#!/usr/bin/env bash
# Tests for the image scripts, with stubbed network, Docker and Git:
# ci/resolve-image.sh, ci/hub-tag.sh, ci/build.sh (PUSH=1 decisions) and
# docker/release-tags.sh. Nothing here talks to the network or a registry.
# Run: npm run test:scripts (also part of npm run check and CI).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD
S=$(mktemp -d)
trap 'rm -rf "$S"' EXIT
fails=0
pass() { echo "ok   $1"; }
fail() {
  echo "FAIL $1"
  fails=$((fails + 1))
}
expect_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: expected '$3', got '$2'"; fi; }

# --- Stubs -----------------------------------------------------------------
mkdir -p "$S/bin" "$S/fetch" "$S/hub"
# HUB_FETCH stub for resolve-image.sh: body from $S/fetch/<tag> or
# $S/fetch/LIST; a missing file is an HTTP error; "SLEEP" hangs.
cat >"$S/bin/fetch" <<'EOF'
#!/usr/bin/env bash
case $1 in *page_size=*) f=$STUB/fetch/LIST ;; *) f=$STUB/fetch/${1##*/} ;; esac
[ -f "$f" ] || exit 22
[ "$(cat "$f")" = SLEEP ] && sleep 30
cat "$f"
EOF
# HUB_CURL stub for hub-tag.sh: $S/hub/<tag> holds "<code> <body>"; a
# missing file is a 404; code "fail" is a network failure.
cat >"$S/bin/curl" <<'EOF'
#!/usr/bin/env bash
out=; url=
while [ $# -gt 0 ]; do
  case $1 in -o) out=$2; shift ;; -w | --max-time) shift ;; -*) ;; *) url=$1 ;; esac
  shift
done
f=$STUB/hub/${url##*/}
if [ ! -f "$f" ]; then printf '{"message":"not found"}' >"$out"; printf 404; exit 0; fi
read -r code body <"$f"
[ "$code" = fail ] && exit 6
printf '%s' "$body" >"$out"
printf '%s' "$code"
EOF
# DOCKER stub: log the call.
cat >"$S/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB/docker.log"
EOF
# GIT stub: remote, rev-parse HEAD, ls-remote (from $S/ls-remote, or fails).
cat >"$S/bin/git" <<'EOF'
#!/usr/bin/env bash
case $1 in
  remote) echo origin ;;
  rev-parse) echo "$STUB_HEAD" ;;
  ls-remote) [ -f "$STUB/ls-remote" ] || exit 128; cat "$STUB/ls-remote" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$S/bin/"*
export STUB=$S

reset() {
  rm -f "$S/fetch/"* "$S/hub/"* "$S/docker.log" "$S/ls-remote"
  : >"$S/docker.log"
}

# --- ci/resolve-image.sh ---------------------------------------------------
IMG=docker.io/timcinel/co-larger-builder
TAG=$(ci/tag.sh)
resolve() { HUB_FETCH="$S/bin/fetch" RESOLVE_TIMEOUT=${RT:-5} ci/resolve-image.sh 2>/dev/null; }
LIST_OK='{"count":3,"next":null,"results":[{"name":"latest","images":[{"architecture":"amd64"}]},{"name":"citest-1234567"},{"name":"lock-aaaaaaaaaaaa-bbbbbbbb"},{"name":"lock-cccccccccccc-dddddddd"}]}'

reset
printf '{"creator":1,"id":2,"name":"%s","images":[]}' "$TAG" >"$S/fetch/$TAG"
expect_eq "resolve: exact tag found" "$(resolve)" "$IMG:$TAG"

reset
printf '{\n  "name" : "%s"\n}\n' "$TAG" >"$S/fetch/$TAG"
expect_eq "resolve: exact tag, pretty-printed JSON" "$(resolve)" "$IMG:$TAG"

reset
echo "$LIST_OK" >"$S/fetch/LIST"
expect_eq "resolve: 404 (or 500) falls back to the newest lock tag" "$(resolve)" "$IMG:lock-aaaaaaaaaaaa-bbbbbbbb"

reset
echo "not json" >"$S/fetch/$TAG"
echo "$LIST_OK" >"$S/fetch/LIST"
expect_eq "resolve: garbage 200 body is not a hit" "$(resolve)" "$IMG:lock-aaaaaaaaaaaa-bbbbbbbb"

reset
echo '{"name":"lock-000000000000-00000000"}' >"$S/fetch/$TAG"
expect_eq "resolve: body naming another tag is not a hit" "$(resolve)" "$IMG:latest"

reset
echo "<html>rate limited</html>" >"$S/fetch/LIST"
expect_eq "resolve: garbage listing falls back to latest" "$(resolve)" "$IMG:latest"

reset
echo '{"count":0,"next":null,"results":[]}' >"$S/fetch/LIST"
expect_eq "resolve: empty listing falls back to latest" "$(resolve)" "$IMG:latest"

reset
cat >"$S/fetch/LIST" <<'EOF'
{"count":7,"results":[{"name":"lock-aaaaaaaaaaaa-bbbbbbbb;rm -rf /"},{"name":"lock-$(id)"},
{"name":"LOCK-AAAAAAAAAAAA-BBBBBBBB"},{"name":"lock-aaaaaaaaaaaa-bbbbbbbbX"},
{"name":"../lock-aaaaaaaaaaaa-bbbbbbbb"},{"name":"lock-aaaaaaaaaaaa-bbbb\"bbbb"},
{"name":"lock-111111111111-22222222"}]}
EOF
expect_eq "resolve: hostile names skipped, first valid name used" "$(resolve)" "$IMG:lock-111111111111-22222222"

reset
printf '%s\n' '{"count":2,"results":[{"name":"lock-aaaa bbbb"},{"name":"lock-x\nlock-aaaaaaaaaaaa-bbbbbbbb"}]}' >"$S/fetch/LIST"
expect_eq "resolve: only hostile names gives latest" "$(resolve)" "$IMG:latest"

reset
echo '{"count":1,"results":[{"name":"lock-cddf86d9b162-r2"}]}' >"$S/fetch/LIST"
expect_eq "resolve: legacy -rN tag accepted" "$(resolve)" "$IMG:lock-cddf86d9b162-r2"

if command -v timeout >/dev/null 2>&1; then
  reset
  echo SLEEP >"$S/fetch/$TAG"
  echo SLEEP >"$S/fetch/LIST"
  start=$(date +%s)
  got=$(RT=2 resolve)
  took=$(($(date +%s) - start))
  expect_eq "resolve: hanging requests give latest" "$got" "$IMG:latest"
  if [ "$took" -le 8 ]; then pass "resolve: hanging requests time out (${took}s)"; else fail "resolve: took ${took}s"; fi
else
  echo "skip resolve: timeout case (no timeout command here; CI runs it)"
fi

reset
HUB_FETCH="$S/bin/fetch" ci/resolve-image.sh >/dev/null 2>&1
expect_eq "resolve: exits 0 when everything fails" "$?" 0

# --- ci/hub-tag.sh -----------------------------------------------------------
hub() { HUB_CURL="$S/bin/curl" ci/hub-tag.sh "$@" 2>/dev/null; }
reset
echo '200 {"name":"lock-aaaaaaaaaaaa-bbbbbbbb","images":[]}' >"$S/hub/lock-aaaaaaaaaaaa-bbbbbbbb"
expect_eq "hub-tag: 200 naming the tag is found" "$(hub co-larger-builder lock-aaaaaaaaaaaa-bbbbbbbb)/$?" "found/0"
expect_eq "hub-tag: 404 is missing" "$(hub co-larger-builder lock-000000000000-00000000)/$?" "missing/0"
echo '200 {"name":"something-else"}' >"$S/hub/x1"
expect_eq "hub-tag: 200 with another name is an error" "$(hub co-larger x1)/$?" "/2"
echo '200 not json' >"$S/hub/x2"
expect_eq "hub-tag: 200 with garbage is an error" "$(hub co-larger x2)/$?" "/2"
echo '500 oops' >"$S/hub/x3"
expect_eq "hub-tag: 500 is an error" "$(hub co-larger x3)/$?" "/2"
echo '429 {"message":"rate limited"}' >"$S/hub/x4"
expect_eq "hub-tag: 429 is an error" "$(hub co-larger x4)/$?" "/2"
echo '401 {"message":"unauthorized"}' >"$S/hub/x5"
expect_eq "hub-tag: 401 is an error" "$(hub co-larger x5)/$?" "/2"
echo 'fail' >"$S/hub/x6"
expect_eq "hub-tag: network failure is an error" "$(hub co-larger x6)/$?" "/2"

# --- ci/build.sh, PUSH=1 -----------------------------------------------------
HEAD=0123456789abcdef0123456789abcdef01234567
OTHER=fedcba9876543210fedcba9876543210fedcba98
BT=lock-aaaaaaaaaaaa-bbbbbbbb
cibuild() {
  PUSH=1 TAG=$BT DOCKER="$S/bin/docker" GIT="$S/bin/git" HUB_CURL="$S/bin/curl" \
    STUB_HEAD=$HEAD ci/build.sh >/dev/null 2>&1
}
calls() { grep -c "$1" "$S/docker.log"; }

reset
printf '%s\trefs/heads/master\n' "$HEAD" >"$S/ls-remote"
cibuild
expect_eq "build: missing tag at master tip: exit 0" "$?" 0
expect_eq "build: missing tag at master tip: pushes the tag" "$(calls "buildx build.*-t docker.io/timcinel/co-larger-builder:$BT --push")" 1
expect_eq "build: missing tag at master tip: moves latest" "$(calls "imagetools create --tag docker.io/timcinel/co-larger-builder:latest")" 1

reset
printf '%s\trefs/heads/master\n' "$HEAD" >"$S/ls-remote"
echo "200 {\"name\":\"$BT\"}" >"$S/hub/$BT"
cibuild
expect_eq "build: existing tag: exit 0" "$?" 0
expect_eq "build: existing tag: no build or push" "$(calls 'buildx build')" 0
expect_eq "build: existing tag at master tip: moves latest" "$(calls 'imagetools create')" 1

reset
printf '%s\trefs/heads/master\n' "$HEAD" >"$S/ls-remote"
echo '503 unavailable' >"$S/hub/$BT"
cibuild
expect_eq "build: lookup error: fails" "$?" 1
expect_eq "build: lookup error: no Docker calls" "$(calls docker)" 0

reset
echo 'fail' >"$S/hub/$BT"
cibuild
expect_eq "build: network failure: fails" "$?" 1
expect_eq "build: network failure: no Docker calls" "$(calls docker)" 0

reset
printf '%s\trefs/heads/master\n' "$OTHER" >"$S/ls-remote"
cibuild
expect_eq "build: not master's tip: exit 0" "$?" 0
expect_eq "build: not master's tip: pushes the tag" "$(calls 'buildx build')" 1
expect_eq "build: not master's tip: latest untouched" "$(calls 'imagetools create')" 0

reset
cibuild
expect_eq "build: master's tip unknown: fails" "$?" 1
expect_eq "build: master's tip unknown: latest untouched" "$(calls 'imagetools create')" 0

# --- docker/release-tags.sh --------------------------------------------------
V=2026.11.1
rtags() {
  GIT="$S/bin/git" HUB_CURL="$S/bin/curl" docker/release-tags.sh "$@" 2>/dev/null | tr '\n' ' '
  return "${PIPESTATUS[0]}"
}
tags_file() { printf '%s\n' "$@" >"$S/ls-remote"; }

reset
tags_file "cfa559dc62a099cbdecc932ecf72cf5f7770d2cd	refs/tags/2026.11.0" "$HEAD	refs/tags/$V"
expect_eq "release: new highest release" "$(rtags $V $HEAD)/$?" "$V ${HEAD:0:12} latest /0"

reset
tags_file "$HEAD	refs/tags/$V" "$OTHER	refs/tags/2026.12.0"
expect_eq "release: older release leaves latest alone" "$(rtags $V $HEAD)/$?" "$V ${HEAD:0:12} /0"

reset
tags_file "$OTHER	refs/tags/2026.11.9" "$HEAD	refs/tags/2026.11.10"
expect_eq "release: numeric comparison (2026.11.10 > 2026.11.9)" "$(rtags 2026.11.10 $HEAD)/$?" "2026.11.10 ${HEAD:0:12} latest /0"

reset
tags_file "$HEAD	refs/tags/2026.11.9" "$OTHER	refs/tags/2026.11.10"
expect_eq "release: 2026.11.9 is not above 2026.11.10" "$(rtags 2026.11.9 $HEAD)/$?" "2026.11.9 ${HEAD:0:12} /0"

reset
tags_file "$HEAD	refs/tags/$V"
echo "200 {\"name\":\"$V\"}" >"$S/hub/$V"
expect_eq "release: existing version tag refused" "$(rtags $V $HEAD)/$?" "/1"
expect_eq "release: existing version with ALLOW_RETAG=1" "$(ALLOW_RETAG=1 rtags $V $HEAD)/$?" "$V ${HEAD:0:12} latest /0"

reset
tags_file "$HEAD	refs/tags/$V"
echo "200 {\"name\":\"${HEAD:0:12}\"}" >"$S/hub/${HEAD:0:12}"
expect_eq "release: existing commit tag left alone" "$(rtags $V $HEAD)/$?" "$V latest /0"

reset
tags_file "$HEAD	refs/tags/$V"
echo "500 oops" >"$S/hub/$V"
expect_eq "release: Docker Hub error refuses" "$(rtags $V $HEAD)/$?" "/1"

reset
tags_file "$OTHER	refs/tags/$V"
expect_eq "release: tag pointing elsewhere refuses" "$(rtags $V $HEAD)/$?" "/1"

reset
tags_file "abababababababababababababababababababab	refs/tags/$V" "$HEAD	refs/tags/$V^{}"
expect_eq "release: annotated tag at HEAD accepted" "$(rtags $V $HEAD)/$?" "$V ${HEAD:0:12} latest /0"

reset
tags_file "$HEAD	refs/tags/2026.11.0"
expect_eq "release: missing release tag refuses" "$(rtags $V $HEAD)/$?" "/1"

reset
expect_eq "release: tag listing failure refuses" "$(rtags $V $HEAD)/$?" "/1"

reset
tags_file "$HEAD	refs/tags/v1"
expect_eq "release: non-release version refuses" "$(rtags v1 $HEAD)/$?" "/1"

echo
if [ "$fails" -gt 0 ]; then
  echo "$fails failed"
  exit 1
fi
echo "all passed"
cd "$ROOT" || exit 1
