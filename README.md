# co-larger

An open-source photo collage maker that runs entirely in your browser. Photos
never leave your machine: there is no backend.

**Try it: <https://timcinel.github.io/co-larger/>**

The GitHub repository is a read-only mirror. Issues and pull requests are
handled on the author's self-hosted Git server, so please do not open them
here. The site above is published from the mirror to GitHub Pages on every
change to `master`; the same build is also available as a Docker image (see
[Run with Docker](#run-with-docker)).

Unlike most collage makers, tile sizes are configurable, from uniform to a few
very large "feature" photos among many small ones. See [spec.md](spec.md) for
the planned scope. The app is at an early stage: you can add photos (file picker
or drag and drop), choose which are included, see them as a mosaic with a
size-variation dial and Shuffle, and set the canvas: a ratio preset, a custom
size in pixels or in millimetres and DPI (with A4, A3 and A2 presets), the
border and the background colour. Swap, crop, undo, export and save are not
built yet.

## Development

Requires Node.js 24 or later.

```sh
npm install
npm run dev
```

| Command                 | What it does                                                        |
| ----------------------- | ------------------------------------------------------------------- |
| `npm run dev`           | Start the Vite dev server.                                          |
| `npm run build`         | Build the static site into `dist/`.                                 |
| `npm run preview`       | Serve the built site locally.                                       |
| `npm test`              | Run the unit tests once (Vitest).                                   |
| `npm run lint`          | Run ESLint and check formatting with Prettier.                      |
| `npm run format`        | Format all files with Prettier.                                     |
| `npm run typecheck`     | Type check with `tsc`.                                              |
| `npm run check`         | Run lint, type check, tests and build, as CI does.                  |
| `npm run check:browser` | Real-browser check of import and editor (local only; needs Chrome). |

CI runs in a builder image with dependencies pre-fetched. After changing
`package-lock.json`, rebuild it with `ci/build.sh` (see `ci/README.md`) and
update the tag in `.forgejo/workflows/ci.yaml`.

The layout engine (`src/layout/`) is a pure TypeScript library. To see it
working, run `npm run dev` and open `/demo/layout.html`: a development-only page
that draws layouts as coloured rectangles at several dial values. Its "View"
control also shows how well photos fit their slots under auto-placement
(`assignPhotos`) and under random placement. It is not part of the build.

Photo import (`src/photos/`) is split into a pure `PhotoStore` (the photos, their
included flags and subscribe/notify, unit-tested in Node), a `PhotoImporter`
(a bounded-concurrency queue that skips duplicates and undecodable files) and
`decodePhoto` (browser-only: decodes one photo at a time, applies EXIF
orientation, and keeps a 1024 px preview and a 256 px thumbnail as JPEG blobs
plus the original `File`). Decoding, EXIF handling and drag and drop cannot run
in Node, so `npm run check:browser` drives a real Chrome through them using the
synthetic photos in `tests/fixtures/` (regenerate them with
`scripts/make-fixtures.sh`). Pass `-- --dir <folder>` to also import a folder of
real photos and print timing and memory numbers. It is not part of CI, which
has no browser.

The editor (`src/editor/`) keeps everything that decides the collage in one
plain, JSON-serialisable `EditorState` (canvas settings, dial, seed, plan,
assignment, per-photo crops), changed only by pure actions in `state.ts` and
held by an `EditorStore` with subscribe/notify. `renderCollage` (`render.ts`)
draws a state onto any 2D context at any size; the editor calls it with
decoded previews and thumbnails from a bounded `ImageCache`, and the export
will call it with the originals. The cover-and-crop maths is `coverSource` in
`crop.ts`. `npm run check:browser` also checks the collage, the dial and
Shuffle; with `--dir` it reports frame times while dragging the dial.

The canvas settings panel (`src/editor/canvas-controls.ts`, beside the collage)
has ratio presets, a width and height in pixels with an aspect lock, a border
slider and a background colour. A preset sets the ratio and keeps the canvas's
longer side (the resolution): from the default 1920 × 1080, 16:9 is 1920 × 1080,
1:1 is 1920 × 1920 and 4:5 is 1536 × 1920; from 3840 × 2160, 1:1 is
3840 × 3840, and the preset already active does nothing. Sizes are checked by
the pure functions in `canvas-settings.ts` (whole pixels, 1 to 20000; bad input
gets an inline message per field and is never applied; with the lock on, the
other side follows the active preset's exact ratio).

The size section has a units choice, Pixels or Millimetres (`physical.ts` holds
the arithmetic). In millimetres there are paper presets (A4, A3 and A2, portrait
and landscape, ISO 216), width and height in mm (up to three decimals, a point
or a comma) and a DPI (a whole number, 1 to 2400, 300 by default). The pixel
size is each side rounded to the nearest whole pixel, so A2 portrait at 300 DPI
is 4961 × 7016 and A3 landscape is 4961 × 3508; a size that would leave 1 to
20000 px is refused with an inline message. The top bar then reads for example
"420 × 594 mm at 300 DPI · 4961 × 7016 px", and the border label adds its width
in mm. The pixel `width` and `height` in the state stay the source of truth for
layout and rendering; `canvas.physical` (`{widthMm, heightMm, dpi}`) is
optional and only records how the user gave the size, so a project reopens in
the same mode with the same numbers. It is validated against the pixels
(finite, in range, and each side what the mm and DPI round to). It is set by
`setPhysicalSize` and `switchToPhysical` (which keeps the pixels and converts
them at the last DPI used, or 300), dropped by `switchToPixels` and by any
`setCanvasSize`, and kept by border and background changes. A ratio preset in
millimetres keeps the longer side in mm and the DPI. Changing the DPI at a fixed
paper size changes the pixels but keeps the arrangement (within the 0.5% ratio
tolerance) and, because the border is a fraction of the shorter side, the
border's relative and physical width. The border slider has a
fixed scale of 0 to 10% of the shorter side and its thumb shows what was asked
for, so a re-roll never moves it. The part of the track the current arrangement
cannot draw (`borderAt().max`) is hatched, and a note says what is drawn when
that is less than asked for; the stored border is always what you asked for.
The slider and the colour picker use the same `GestureInput` as the dial
(`gesture.ts`): one drag, click or key press gives exactly one committed
change. The tray below the collage is one scrolling row of thumbnails (a
single tab stop; arrow keys move between them); "Show all" expands it into a
grid. The settings panel comes before the tray in tab order.

The build uses relative asset URLs, so `dist/` can be hosted at the root of a
domain or under any sub-path.

## Run with Docker

The app ships as a small multi-architecture image (`linux/amd64` and
`linux/arm64`) on Docker Hub: [`timcinel/co-larger`](https://hub.docker.com/r/timcinel/co-larger).
It is unprivileged nginx serving the static site, with no Node in it. Photos
never leave the browser; the container serves files and nothing else.

```sh
docker run --rm -p 8080:8080 timcinel/co-larger
# open http://localhost:8080/
```

Tags: `latest`, and the 12-character git commit (`timcinel/co-larger:<commit>`)
that the image was built from. Pin the commit tag, or the digest, in
deployments.

- **Port:** 8080 (the container runs as uid 101, so it cannot bind port 80).
- **Health:** `GET /healthz` returns `200 ok`. Use it for Docker and Kubernetes
  probes.
- **Read-only root filesystem:** works. nginx writes only to `/tmp`, so run
  with `--read-only --tmpfs /tmp` (Kubernetes: an `emptyDir` at `/tmp`).
- **Caching and compression:** files under `assets/` have content hashes and are
  cached for a year; `index.html` is always revalidated. Text assets are gzipped.
- **Security headers:** a Content-Security-Policy limited to the app's own
  files plus `blob:` (photo previews, export, save) and `data:` images, and
  `nosniff`, `no-referrer`, `X-Frame-Options: DENY` and a restrictive
  Permissions-Policy. TLS and HSTS are the reverse proxy's job.

### Behind a reverse proxy, under a sub-path

The site uses relative URLs, so it works at any path. Have the proxy strip the
prefix and redirect `/collage` to `/collage/` (the trailing slash matters,
because relative URLs resolve against it). With nginx:

```nginx
absolute_redirect off;               # keep redirects relative
location = /collage { return 301 /collage/; }
location /collage/ {
    proxy_pass http://co-larger:8080/;   # trailing slash strips /collage/
}
```

A Kubernetes example (Deployment and Service, non-root, read-only root
filesystem, probes on `/healthz`) is in [docs/kubernetes.md](docs/kubernetes.md).

### Rebuilding and publishing the image

The image is built and pushed from a developer's machine, for both
architectures at once, with one command (CI does not build images yet; see
issue #37):

```sh
docker login   # Docker Hub, once
docker/build.sh
```

The script refuses to run with uncommitted changes, so every image matches a
commit, and pushes one manifest list tagged with the short commit and `latest`
(and with the version from `package.json` once it is not `0.0.0`). `PUSH=0
docker/build.sh` builds for the local architecture only, without pushing.

The page shows the `package.json` version and the short commit it was built
from (also as `<meta name="version">` and `<meta name="commit">`). Builds in a
Git checkout read the commit from Git; the image build has no `.git`, so
`docker/build.sh` passes it as `--build-arg GIT_COMMIT=<hash>` (set the
`GIT_COMMIT` environment variable for any other build). Without a commit the
page shows the version alone.

To check an image the way it was verified, run it and point a real Chrome at it
(needs Chrome; add `--subpath` to check it behind a proxy under `/collage/`):

```sh
docker run -d --rm --name co-larger -p 8080:8080 timcinel/co-larger
node scripts/docker-check.ts http://localhost:8080/
docker stop co-larger
```

## Licence

[MIT](LICENSE)
