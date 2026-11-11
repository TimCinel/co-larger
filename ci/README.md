# CI builder image

`ci/Dockerfile` builds the public Docker Hub image
`docker.io/timcinel/co-larger-builder`: Node 24 (pinned by digest) with the
project's open-source dependencies already installed. It contains no source
code or credentials.

- `/opt/deps/node_modules` is an install for the lockfile whose sha256 is in
  `/opt/deps/lock.sha256`. CI symlinks it into the checkout when the checkout's
  `package-lock.json` has the same hash.
- `/opt/npm-cache` (`npm_config_cache`) is the npm cache, used by the fallback
  `npm ci --prefer-offline` when the lockfile has moved on.
- `/opt/deps/image-tag` is the image's own tag, which the CI log prints.

## Tags

- `lock-<12 hex>-<8 hex>` (from `ci/tag.sh`): the first 12 hex digits of the
  sha256 of `package-lock.json`, then the first 8 of the sha256 of
  `ci/Dockerfile`. The tag is a key for the image's inputs, not a hash of the
  image: the lockfile and the Dockerfile (which pins the base image by digest)
  decide what is in it. Changing only the build scripts or labels keeps the
  key, so the existing image is kept; change `ci/Dockerfile` to force a new
  one. Nobody bumps a revision number by hand.
- `latest`: the image for `master`'s newest build, for people. CI does not
  rely on it (see below).
- Older tags (`lock-cddf86d9b162`, `lock-cddf86d9b162-r2`) were built by hand
  before CI did it.

A `lock-*` tag is written once and never overwritten.

## What is automatic

The "Builder image" workflow (`.forgejo/workflows/builder-image.yaml`) runs
when the image's inputs (`package-lock.json`, `ci/Dockerfile`) or the scripts
that build and publish it (`ci/build.sh`, `ci/tag.sh`, `ci/hub-tag.sh`, the
workflow) change:

- On `master`, it logs in with the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`
  Actions secrets and runs `PUSH=1 ci/build.sh`:
  - `ci/hub-tag.sh` asks Docker Hub whether `:<tag>` exists. A definite
    "missing" (HTTP 404) builds and pushes it; a definite "found" (HTTP 200
    naming the tag) skips the build; anything else (network error, rate
    limit, server error, odd answer) fails the job, so a failed lookup can
    never overwrite a tag.
  - `:latest` moves to `:<tag>` only if the commit is still master's tip,
    checked with `git ls-remote` just before moving it. An older run that
    finishes late pushes its `lock-*` tag and leaves `:latest` alone.
  - Runs are serialised by the workflow's `concurrency` group (queued, not
    cancelled). Forgejo documents this as best-effort; the two rules above
    keep a rare overlap harmless.
- On pull requests, it only builds (`PUSH=0`) and does not log in.

The image is `linux/amd64` only: the runners are amd64 and have no arm64
emulation, and the `npm ci` in `ci/Dockerfile` would need it.

## How CI picks up a new image

Nobody edits `.forgejo/workflows/ci.yaml` when the image changes. A job's
container image is fixed before any of its steps run, so CI has two jobs:

1. "Pick builder image" (in the small `docker:cli` image) fetches
   `package-lock.json` and `ci/` at the commit under test and runs
   `ci/resolve-image.sh`. It uses the tag from `ci/tag.sh` if Docker Hub's web
   API answers with a JSON body naming it. Otherwise (a pull request that
   changes the lockfile or `ci/Dockerfile`, `master` in the minutes before the
   new image is pushed, or a Docker Hub problem) it takes the newest valid
   `lock-*` name from the 100 most recently updated tags. If that fails too,
   it uses `:latest`. Each request has a time limit, so the script always
   finishes within about 20 seconds and always prints a usable image.
2. "Lint, type check, test and build" runs in that image. Its install step
   compares the checkout's lockfile hash with the image's: if they match (the
   normal case) it links the baked `node_modules`, with no install at all;
   otherwise it runs `npm ci --prefer-offline`, slower but with the same
   result. The log names the image ("Builder image: lock-…").

So the run uses the image for its own commit when there is one, and is never
wrong when there is not.

Why not just run in `:latest`? Jobs pull images through the cluster's
pull-through cache (zot), and it keeps serving the copy it first fetched for a
tag: in a test (issue #37) a tag re-pushed to Docker Hub was still served with
its old content more than ten minutes later, to both `docker pull` and a job's
container. A moved `:latest` might never reach CI. A new tag is a cache miss,
so it is fetched from Docker Hub, which is why tags are never re-pushed and CI
asks for the exact tag. The cost is the extra small job: about 7 seconds, plus
waiting for a free runner.

`ci/test-scripts.sh` (`npm run test:scripts`, part of `npm run check` and CI)
tests `ci/resolve-image.sh`, `ci/hub-tag.sh`, the publishing decisions of
`ci/build.sh` and `docker/release-tags.sh` with stubbed network, Docker and
Git.

## Security model

Anyone who can push a branch to this repository can use the Docker Hub
publishing token. Forgejo hides secrets only from pull requests opened from
forks; a pull request from a branch in this repository runs that branch's
version of the workflows with the secrets available, so a changed workflow
could read the token. The workflows here log in only on `master` and on
release tags, but that is not a security boundary.

The mitigations are the owner's:

- use a Docker Hub access token scoped to only `timcinel/co-larger` and
  `timcinel/co-larger-builder`, with read and write but not delete or admin;
- limit who has push access to the repository;
- rotate the token (and update the `DOCKERHUB_TOKEN` secret) when someone's
  access ends or a leak is suspected.

## Building by hand

Not normally needed. `ci/build.sh` builds without pushing (`PUSH=0`, the
default). To rebuild from CI, run the "Builder image" workflow on `master` from
the Actions page (`workflow_dispatch`). Pushing by hand needs `docker login` to
Docker Hub and `PUSH=1 ci/build.sh`; it follows the same rules. An existing
tag is never rebuilt: change `ci/Dockerfile` to get a new image.

## Browser checks in CI

`npm run check:browser` is not run in CI, and the image has no Chrome. The
browser checks have flaked locally, the runner is about five times slower than
a development machine, so timing-sensitive checks would flake more there, and
every job pulls the whole image again (each job gets a fresh Docker daemon;
the image is already about 500 MB), so Chrome would make every run slower.
They stay a local check before merging changes to the editor or import (see
issue #37).
