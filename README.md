# co-larger

An open-source photo collage maker that runs entirely in your browser. Photos
never leave your machine: there is no backend.

Unlike most collage makers, tile sizes are configurable, from uniform to a few
very large "feature" photos among many small ones. See [spec.md](spec.md) for
the planned scope. The app is at an early stage: you can add photos (file picker
or drag and drop) and choose which are included, but the collage canvas is not
built yet.

## Development

Requires Node.js 24 or later.

```sh
npm install
npm run dev
```

| Command                 | What it does                                                   |
| ----------------------- | -------------------------------------------------------------- |
| `npm run dev`           | Start the Vite dev server.                                     |
| `npm run build`         | Build the static site into `dist/`.                            |
| `npm run preview`       | Serve the built site locally.                                  |
| `npm test`              | Run the unit tests once (Vitest).                              |
| `npm run lint`          | Run ESLint and check formatting with Prettier.                 |
| `npm run format`        | Format all files with Prettier.                                |
| `npm run typecheck`     | Type check with `tsc`.                                         |
| `npm run check`         | Run lint, type check, tests and build, as CI does.             |
| `npm run check:browser` | Real-browser check of photo import (local only; needs Chrome). |

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

The build uses relative asset URLs, so `dist/` can be hosted at the root of a
domain or under any sub-path.

## Licence

[MIT](LICENSE)
