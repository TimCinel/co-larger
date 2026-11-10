# co-larger

An open-source photo collage maker, modelled on https://gandr.io/, with one
major difference: tile sizes are configurable, from uniform to a few very large
"feature" photos among many small ones.

## Why

- gandr.io is proprietary, so it cannot be modified.
- gandr.io's tile sizes are too uniform. Sometimes that is fine, sometimes it
  is not, so it should be configurable.

## Principles

- Static, client-side web app. Photos never leave the browser. No backend.
- Desktop browsers only in v1 (mouse and keyboard).
- Good enough for print: posters up to A2 at 300 DPI.
- MIT licensed. Self-hosted as a static site (likely GitHub Pages).
- Stack: TypeScript and Vite.

## v1 scope

### Photos

- Add photos by file picker or drag and drop. No limit on the number.
- A tray below the canvas shows every added photo, with a per-photo toggle to
  include it in or exclude it from the collage, plus "add all" and "remove all".
- Originals are kept at full resolution for export. The editor uses downscaled
  previews so it stays responsive with 100+ photos.

### Canvas

- Ratio presets: 1:1, 1:2, 2:1, 3:4, 4:3, 4:5, 5:4, 5:7, 7:5, 9:16, 16:9.
- Custom size in pixels (width and height, with an aspect lock).
- Custom size in physical units: width and height in mm, plus DPI. Presets for
  A4, A3 and A2 in portrait and landscape, at 300 DPI by default.
- Maximum output: A2 at 300 DPI (4961 × 7016 px) must work. This fits in a
  single browser canvas, so no tiled rendering is needed.
- Border slider: one control that sets both the outer margin and the gap
  between tiles.
- Background colour, visible in the border and gaps.

### Layout

- One layout: a mosaic that fills the canvas edge to edge with rectangular
  tiles, one tile per included photo, with no empty space.
- A size-variation dial:
  - At the minimum, all tiles have roughly equal area.
  - At the maximum, a few tiles are very large and many are very small.
  - In between, the spread of tile areas grows smoothly.
- Auto-placement matches photos to slots by shape: portrait photos go in
  portrait slots, landscape in landscape, to minimise cropping.
- Photos are cropped to fill their tile (cover). They are never letterboxed
  or distorted.
- Shuffle re-rolls the arrangement: both which slots exist and which photo
  goes where.
- Changing the dial, the ratio, or the set of included photos also re-rolls
  the arrangement.
- Layout generation is deterministic for a given seed, so a saved project
  reopens identically.

### Manual control

- Swap: select a tile, choose Swap, then pick a second tile. The two photos
  trade places. This is how the user chooses which photos get the large slots.
- Crop: each tile can be zoomed and panned to choose which part of the photo
  shows. Zoom cannot go below "cover", and pan cannot expose empty space.
- Remove: take a photo out of the collage from its tile (same as excluding it
  in the tray).
- Crops belong to the photo and survive a re-roll. When a photo lands in a
  slot of a different shape, the crop is re-fitted around the same focal point.
- Swaps do not survive a re-roll. The intended workflow is: set the dial,
  shuffle until the shape is right, then swap and crop.
- Undo and redo, covering at least re-rolls, swaps, crops and removals, so an
  accidental Shuffle is recoverable.

### Export

- Download the collage as PNG or JPEG at the full canvas resolution, rendered
  from the original photos, not the previews.
- The export matches the editor preview exactly, apart from resolution.

### Save and load

- Save project: downloads a single zip containing the original photos and a
  JSON file describing the canvas settings, layout seed and arrangement,
  per-photo crops, and include/exclude state.
- Open project: loads that zip and restores the editor to the same state.
- The JSON carries a format version number.
- No automatic persistence in the browser. A reload starts empty.

## v2 (not in v1)

- Lock a photo as a feature, so re-rolls keep it in a large slot.
- Warn when a photo's resolution is too low for its printed tile size.
- Drag the dividers between tiles to resize them.
- Touch and mobile support.
- Text overlay.
- PDF export.
- Grid layout.

## Out of scope

- Brick layout.
- Native mobile apps.
- Accounts, cloud storage, or any server-side processing.
