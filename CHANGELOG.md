# Changelog

Versions are calendar-based, `YYYY.MM.N`: the year, the month, and a counter
that starts at 0 each month. Tags have no `v` prefix. See
[docs/releasing.md](docs/releasing.md) for how a release is made.

## Unreleased

### Editing

- Low-resolution warnings: a tile whose photo is too small for the size it is
  exported or printed at gets an amber triangle (low, more than 1.5 times
  enlarged) or a red octagon (very low, more than 3 times). Hover or focus the
  badge to see why, including the effective DPI on a canvas with a physical
  size. The same marker is on the tray thumbnails, and a summary next to
  Export counts the affected photos and highlights them. "Show resolution
  warnings" turns it off for the session. Export is never blocked and the
  warnings are not saved in the project.
- Feature a photo so it stays large: "Feature" in a tile's menu (or F on the
  selected tile) moves the photo into the largest tile, and from then on
  Shuffle, the dial, the canvas ratio and including or excluding photos keep
  every featured photo in the largest tiles. A star marks featured tiles and
  their tray thumbnails; it is not exported. "Unfeature" clears the mark
  without moving anything. Featuring is one undo step, and the marks are saved
  in the project. With nothing featured, arrangements are unchanged.

### Project files

- Projects now record featured photos in an optional `state.featured` list.
  The format version stays 1: projects saved by 2026.11.0 open with nothing
  featured, and 2026.11.0 opens newer projects, ignoring the marks (saving
  there drops them).

## 2026.11.0 - 2026-11-12

First release. co-larger is a photo collage maker that runs entirely in the
browser; there is no backend and photos are not uploaded anywhere.

### Photos

- Add photos with a file picker or by drag and drop. EXIF orientation is
  applied. Duplicates and files that cannot be decoded are skipped.
- A tray below the collage shows every photo as a thumbnail and lets you
  include or exclude each one. "Show all" expands the tray into a grid.

### Layout

- Mosaic layout with a size-variation dial, from uniform tiles to a few large
  tiles among many small ones. Shuffle re-rolls the arrangement.
- Placement takes orientation into account: landscape photos go in wide slots
  and portrait photos in tall ones where possible.
- The collage is laid out once when a batch of photos has been added.

### Canvas

- Ratio presets, or a custom width and height in pixels (1 to 20000, with an
  aspect lock).
- Physical sizes: millimetres and DPI, with A4, A3 and A2 presets in portrait
  and landscape.
- Border width (0 to 10% of the shorter side) and background colour.

### Editing

- Select a tile, swap it with another or remove it.
- Per-tile crop: zoom and pan.
- Undo and redo.
- Large tiles stay sharp: a tile bigger than its preview is drawn from a decode
  of the original, within a fixed 256 MB image cache.

### Export, save and open

- Export PNG or JPEG at the full canvas resolution, rendered from the original
  photos, up to A2 at 300 DPI (4961 by 7016 pixels).
- Save the project as a zip containing the original photos and a JSON file
  (canvas, layout seed, arrangement, crops, included photos). Open a saved zip
  to restore the editor to the same state. The format is described in
  [docs/project-format.md](docs/project-format.md).
- Nothing is stored in the browser between visits; a reload starts empty.

### Distribution

- The top bar and the page's `<meta>` tags show the version and the commit the
  build was made from.
- Multi-architecture Docker image (`linux/amd64` and `linux/arm64`),
  `timcinel/co-larger` on Docker Hub, serving the static site with unprivileged
  nginx.
- The site is published to GitHub Pages from the public mirror:
  <https://timcinel.github.io/co-larger/>.

### Known limits

- Desktop browsers only, with mouse and keyboard. There is no touch support.
- Not in this release, and listed as v2 in [spec.md](spec.md): locking a photo
  as a feature, a warning for photos too small for their printed size, dragging
  the dividers between tiles, touch and mobile support, text overlay, PDF
  export and a grid layout.
- Very large exports depend on the browser's canvas limits and available
  memory.
