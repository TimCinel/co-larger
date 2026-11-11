# CI builder image

`ci/Dockerfile` builds the public Docker Hub image
`docker.io/timcinel/co-larger-builder`: Node 24 (pinned by digest) with the
project's open-source dependencies already installed. It contains no source
code or credentials.

- `/opt/deps/node_modules` is an install for the lockfile whose sha256 is in
  `/opt/deps/lock.sha256`. CI symlinks it into the checkout when the checkout's
  `package-lock.json` has the same hash. The CI runner's CPU is slow, and
  unpacking packages dominated the install time, so nothing is unpacked.
- `/opt/npm-cache` (`npm_config_cache`) is the npm cache, used by the fallback
  `npm ci --prefer-offline` when the lockfile has moved on, so CI still works,
  more slowly, with a stale image.

Images are tagged `latest` and
`lock-<first 12 hex of sha256(package-lock.json)>-<rev>`. The workflow uses the
full tag so runs are reproducible.

## Rebuilding

After changing `package-lock.json` (or `ci/Dockerfile`, in which case bump `REV`
in `ci/build.sh`):

```sh
docker login   # Docker Hub, once
ci/build.sh
```

then update the tag in `.forgejo/workflows/ci.yaml`.
