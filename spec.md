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
- MIT licensed. Ships as a multi-architecture (amd64 and arm64) Docker image that serves the static site, for self-hosting; any static host also works.
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

- Two layouts, chosen in the settings panel; both fill the canvas edge to
  edge with rectangular tiles, one tile per included photo, with no empty
  space:
  - Mosaic (the default): tiles of varied sizes, set by the dial below.
  - Grid: rows of equal height, every full row with the same number of
    equal-width cells. When the photos do not fill the last row, its cells
    are wider so that it still spans the canvas. Columns are "Auto" by
    default (the column count whose cells crop the photos least) or set by
    hand from 1 to the number of photos. The dial has no meaning in a grid:
    it is disabled, and keeps its value for when the user returns to Mosaic.
    Switching layout and changing columns re-roll the arrangement.
- A size-variation dial (Mosaic):
  - At the minimum, all tiles have roughly equal area.
  - At the maximum, a few tiles are very large and many are very small.
  - In between, the spread of tile areas grows smoothly.
- Auto-placement matches photos to slots by shape: portrait photos go in
  portrait slots, landscape in landscape, to minimise cropping.
- Photos are cropped to fill their tile (cover). They are never letterboxed
  or distorted.
- Shuffle re-rolls the arrangement: both which slots exist and which photo
  goes where (in a grid: which photo goes in which cell).
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
- Resize: drag the divider between tiles to move it. The pointer shows a
  resize cursor over a divider and the whole divider line (every tile it
  borders) is highlighted; the collage redraws live while dragging and
  commits on release, and Escape cancels the drag. No tile gets smaller than
  4% of the canvas's shorter side in either direction; a tile already
  smaller than that (from the planner, with many photos) can grow but not
  shrink, and while it is thinner than 4% one way it cannot be stretched the
  other way beyond the planner's own shape limit (2.5:1, more on a very long
  canvas): otherwise a drag could pull a hairline sliver out of it, which a
  saved project could not tell apart from a damaged one. Tiles of at least
  4% both ways have no shape limit. Where the selected tile's menu is drawn
  over a divider, the menu gets the press there and the divider shows no
  highlight; the rest of the line can be dragged, Escape removes the menu,
  and the keyboard reaches every divider. Crops are re-fitted around the
  same focal point as tiles change shape, and no photo moves, featured or
  not. A drag that the system cancels (lost pointer capture, a cancelled
  pointer, the window losing focus) puts the layout back. Each divider can also be
  focused with Tab and moved with the arrow keys (Shift for bigger steps);
  one key sequence or one drag is one undo step.
- Hand resizing does not survive a re-roll: Shuffle, the dial, the canvas
  ratio and including or excluding photos all lay the tiles out afresh. A
  border, background or same-ratio size change, a swap, a crop or a feature
  keeps it. Saving and opening restore it exactly.
- Feature: mark a photo from its tile's menu ("Feature", or F on the selected
  tile; "Unfeature" to clear it) so re-rolls keep it in a large slot. Any
  number of photos can be featured, with no ranking among them. Featuring
  moves the photo at once into the largest slot not held by another featured
  photo (one swap; nothing moves if it is already among the largest), and
  unfeaturing never moves anything. On every re-roll (Shuffle, the dial, the
  canvas ratio, including or excluding photos, importing) the k featured
  photos take the k largest slots, matched among them by shape with the usual
  placement cost, and the other photos fill the rest as before. "Largest" is
  measured on the tiles as drawn and exported (border and pixel snapping
  included), at the moment of each re-roll or feature. A border change is not
  a re-roll and moves no photo, so it can leave a featured tile slightly
  smaller than another until the next re-roll. With nothing
  featured the arrangement is exactly what it was without the feature. The
  mark belongs to the photo: it survives exclusion and is saved in the
  project. A star marks featured tiles and their tray thumbnails (editor
  chrome only, never exported). Featuring or unfeaturing is one undo step.
- Undo and redo, covering at least re-rolls, swaps, crops, removals and
  divider moves, so an accidental Shuffle is recoverable.

### Export

- Download the collage as PNG or JPEG at the full canvas resolution, rendered
  from the original photos, not the previews.
- The export matches the editor preview exactly, apart from resolution.

### Low-resolution warnings

- A tile whose photo is too small for the size it is exported or printed at
  gets a badge: the upscale factor (export pixels per original pixel, for the
  region the crop shows) above 1.5 is "low" (amber triangle), above 3 is "very
  low" (red octagon). On a canvas with a physical size the explanation gives
  the effective DPI (below 200 and 100 at 300 DPI); on a pixel canvas, the
  enlargement.
- The same marker is on the tray thumbnails of photos in the collage, and a
  one-line summary sits next to Export. Hover or keyboard focus on a badge
  explains it. Export is never blocked, and the warning never moves photos.
- "Show resolution warnings" in the settings panel turns it off for the
  session. It is derived from the editor state and is never exported or saved.

### Save and load

- Save project: downloads a single zip containing the original photos and a
  JSON file describing the canvas settings, layout (Mosaic or Grid, and the
  grid's columns), layout seed and arrangement,
  per-photo crops, featured photos, and include/exclude state.
- Open project: loads that zip and restores the editor to the same state.
- The JSON carries a format version number.
- No automatic persistence in the browser. A reload starts empty.

## v2 (not in v1)

- Touch and mobile support.
- Text overlay.
- PDF export.

## Out of scope

- Brick layout.
- Native mobile apps.
- Accounts, cloud storage, or any server-side processing.
