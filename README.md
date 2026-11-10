# co-larger

An open-source photo collage maker that runs entirely in your browser. Photos
never leave your machine: there is no backend.

Unlike most collage makers, tile sizes are configurable, from uniform to a few
very large "feature" photos among many small ones. See [spec.md](spec.md) for
the planned scope. The app is at an early stage: you can add photos (file picker
or drag and drop), choose which are included, see them as a mosaic with a
size-variation dial and Shuffle, and set the canvas: a ratio preset, a custom
size in pixels, the border and the background colour. Physical sizes, swap,
crop, undo, export and save are not built yet.

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
other side follows the active preset's exact ratio). The border slider has a
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

## Licence

[MIT](LICENSE)
