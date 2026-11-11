# Releasing

Versions are calendar-based, `YYYY.MM.N`: the year, the month, and a counter
that starts at 0 each month (`2026.11.0`, `2026.11.1`, then `2026.12.0`). Tags
have no `v` prefix. The same string is `version` in `package.json` and
`package-lock.json`, the git tag, the Forgejo release name, the Docker tag and
the version shown in the app.

Replace `VERSION` below with the new version. Run everything from a clean
checkout unless a step says otherwise. Track the release in an issue and tick
its criteria as each step is done.

## 1. Bump the version in a pull request

```sh
git fetch core
git switch -c release-VERSION core/master
npm ci
npm version VERSION --no-git-tag-version
git diff            # only the version fields in package.json and package-lock.json
```

Add a `## VERSION - YYYY-MM-DD` entry at the top of `CHANGELOG.md`, based on
`git log --merges <previous-tag>..core/master`, written as plain facts, with
known limits. Run `npm run check`; `npm run build` should leave
`dist/index.html` with `<meta name="version" content="VERSION">`.

Commit, `git push -u core release-VERSION`, and open the pull request with
`fj pr create --repo tim/co-larger`. Use "Refs #N", not "Closes #N", in the
description, because the issue stays open until the tag, release and image
exist.

Changing `package-lock.json` changes the hash the CI builder image is keyed on
(see `ci/README.md`), so the pull request's CI falls back to `npm ci` and is a
little slower than usual. After the merge, CI rebuilds and pushes the builder
image by itself; there is nothing to do by hand.

## 2. Wait for CI, then merge

```sh
forgejo-logs pr <number>
fj pr merge <number>
```

Fix any failure on the branch first. Do not merge on red.

## 3. Tag the merge commit

```sh
git fetch core
git switch --detach core/master    # the merge commit; check `git log -1`
git tag VERSION
git push core VERSION
```

The push mirror carries the tag to GitHub. The GitHub Pages workflow runs on
pushes to `master`, so the site is already deploying the merge commit. Check
the tag is on both remotes and points at the same commit:

```sh
git ls-remote core 'refs/tags/VERSION*'
git ls-remote https://github.com/timcinel/co-larger.git 'refs/tags/VERSION*'
```

## 4. Create the Forgejo release

Put the new changelog entry (without its heading) in a file and use it as the
notes. The tag already exists, so use `--tag`, not `--create-tag`:

```sh
fj release create --repo tim/co-larger --tag VERSION \
  --body-file /path/to/notes.md VERSION
```

Check it with `fj release view --repo tim/co-larger VERSION`.

## 5. Check the Docker image CI built

Pushing the tag in step 3 starts the "Release image" workflow
(`.forgejo/workflows/release-image.yaml`). It checks the tag is `YYYY.MM.N` and
equals the `version` in `package.json`, logs in to Docker Hub with the
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` Actions secrets, and runs
`docker/build.sh` on the tagged commit. That builds `linux/amd64` and
`linux/arm64` at once and pushes one multi-arch manifest tagged with the
version, the 12-character commit and `latest`. Labels carry no internal host
names. No emulation is involved: the `Dockerfile`'s build stage runs on the
runner's own architecture (its output is static files) and the arm64 image
only copies those files onto the arm64 nginx base. Wait for it:

```sh
forgejo-logs runs | head    # the "Build app image" job for the tag
```

If it fails, read the log (`forgejo-logs log <run>`), fix the cause in a pull
request if it is in the repository, and re-run the workflow
(`forgejo-logs rerun <run>`). Do not move or re-create the tag. If CI cannot
build it at all, build it by hand as below.

### By hand (fallback)

From a clean working tree at the tagged commit, with Docker Hub login done by
the owner beforehand (`docker login`; do not script it, and do not put
credentials in a script, a file or a command line):

```sh
git switch --detach VERSION
docker/build.sh
```

`docker/build.sh` tags `timcinel/co-larger` like CI does (it skips the version
tag only while `version` is the placeholder `0.0.0`). `PUSH=0` builds for the
local architecture only and loads it into the local Docker instead of pushing.
If the push is refused, stop and ask the owner.

### Check

Check the pushed tags are the same manifest and cover both architectures:

```sh
docker buildx imagetools inspect timcinel/co-larger:VERSION
docker buildx imagetools inspect timcinel/co-larger:latest
```

The digests must match, and both `linux/amd64` and `linux/arm64` must be listed.

## 6. Verify

Run the pushed image and check it with a real Chrome (`--expect-commit` makes
the checker require the commit shown in the app):

```sh
docker run -d --rm --name co-larger -p 8080:8080 timcinel/co-larger:VERSION
node scripts/docker-check.ts --expect-commit "$(git rev-parse VERSION^{commit})" http://localhost:8080/
docker stop co-larger
```

Then check the public site once its workflow has finished on GitHub:

```sh
node scripts/docker-check.ts --expect-commit "$(git rev-parse VERSION^{commit})" https://timcinel.github.io/co-larger/
```

Both pages must show `VERSION` and the tagged commit's short hash. Tick the
criteria in the release issue and close it.
