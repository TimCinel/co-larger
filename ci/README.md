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
  `ci/Dockerfile`. A tag names the image's content, so it is never reused for a
  different image, and nobody has to bump a revision number by hand.
- `latest`: the image for `master`'s current lockfile and `ci/Dockerfile`, for
  people. CI does not rely on it (see below).
- Older tags (`lock-cddf86d9b162`, `lock-cddf86d9b162-r2`) were built by hand
  before CI did it.

## What is automatic

The "Builder image" workflow (`.forgejo/workflows/builder-image.yaml`) runs
when `package-lock.json`, `ci/Dockerfile`, `ci/build.sh` or `ci/tag.sh` changes:

- On `master`, it runs `PUSH=1 ci/build.sh`, which builds `linux/amd64` and
  pushes `:<tag>` and `:latest`. If `:<tag>` already exists (for example the
  lockfile went back to an earlier state), it is not rebuilt; `:latest` is
  pointed at it. It logs in with the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`
  Actions secrets.
- On pull requests, it only builds (`PUSH=0`), without secrets.

The image is `linux/amd64` only: the runners are amd64 and have no arm64
emulation, and the `npm ci` in `ci/Dockerfile` would need it.

## How CI picks up a new image

Nobody edits `.forgejo/workflows/ci.yaml` when the image changes. A job's
container image is fixed before any of its steps run, so CI has two jobs:

1. "Pick builder image" (in the small `docker:cli` image) fetches
   `package-lock.json` and `ci/` at the commit under test and runs
   `ci/resolve-image.sh`, which asks Docker Hub's web API whether the tag from
   `ci/tag.sh` exists. If it does, that is the image. If not (a pull request
   that changes the lockfile or `ci/Dockerfile`, or `master` in the minutes
   before the new image is pushed), it takes the most recently pushed `lock-*`
   tag. Any error falls back to `:latest`.
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
asks for the exact tag. The cost is the extra small job, about 15 to 20
seconds per run (another job start and a small image pull).

## Building by hand

Not normally needed. `ci/build.sh` builds without pushing (`PUSH=0`, the
default). To rebuild from CI, run the "Builder image" workflow on `master` from
the Actions page (`workflow_dispatch`). Pushing by hand needs `docker login` to
Docker Hub and `PUSH=1 ci/build.sh`. Either way an existing tag is not rebuilt:
change `ci/Dockerfile` to get a new image.

## Browser checks in CI

`npm run check:browser` is not run in CI, and the image has no Chrome. The
browser checks have flaked locally, the runner is about five times slower than
a development machine, so timing-sensitive checks would flake more there, and
every job pulls the whole image again (each job gets a fresh Docker daemon;
the image is already about 500 MB), so Chrome would make every run slower. They stay a local check before merging
changes to the editor or import (see issue #37).
