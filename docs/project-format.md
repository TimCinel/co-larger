# Project file format

A saved project is one zip, by default named `collage-project.colarger.zip`.
It holds a manifest, `project.json`, and every photo's original file.

```
collage-project.colarger.zip
├── project.json
└── photos/
    ├── photo-1-beach.jpg
    ├── photo-2-beach.jpg      two photos with the same name stay apart
    └── ...
```

## Zip

- Writers store: every entry uses the zip "store" method (no compression).
  Photos are already compressed, and storing keeps saving and opening fast and
  light on memory. Saved photos are byte for byte the originals.
- Readers accept Store and DEFLATE for photos (and for `project.json`), so a
  project unpacked, edited and re-zipped by a system tool (Finder, `zip -r`)
  opens. Any other method (bzip2, LZMA, ...) and encrypted entries are
  refused. Saving always writes a stored zip, even for a project opened from
  a deflated one.
- Excluded photos are saved too, so the tray comes back whole.
- Opening checks the CRC-32 of `project.json` and of every photo, streaming,
  before the current project is replaced. A mismatch is refused with "this
  project file is damaged". A stored photo is checked in a streaming pass and
  stays a slice of the zip (nothing is held in memory twice). A deflated photo
  is inflated once, by the browser's `DecompressionStream('deflate-raw')`
  (native, off the main thread, streaming), checking its length and CRC-32 as
  the data goes by; the inflated bytes are kept as the photo's file, so the
  photo is never inflated a second time. Inflation runs with the same bounded
  concurrency as decoding (two photos at once) and stops on Cancel.
- Memory bound: inflated photos are real copies in memory until the project is
  saved again (a save through a file handle rebinds every photo to the new
  stored file and releases them). Opening refuses a project whose deflated
  photos add up to more than 512 MiB, by their declared sizes and before
  inflating any of them, with a message naming the limit and suggesting to
  re-zip without compression. Inflation never produces more than a photo's
  declared size, so the bound is exact. 512 MiB is about a hundred 5 MB
  photos; it leaves a desktop tab room for the previews, thumbnails and decoder
  working memory that come on top, and stored photos (the usual case) do not
  count against it at all.
- Stray entries (`__MACOSX/` resource forks, `.DS_Store`, folder entries) that
  a system zip adds are ignored like any other file nobody lists, as long as
  their names are safe and their method is Store or DEFLATE. `project.json`
  must be at the root of the zip (zipping the containing folder from Finder
  puts it one level down, which is refused with a message saying so and
  suggesting compressing the folder's contents instead).
- Archives are limited to 4 GB (no ZIP64), 10 000 entries, 5 000 photos and
  1 GB per photo. `project.json` is limited to 32 MB.
- Names must be relative paths with no `..`, empty or `.` segments, no
  backslashes and no drive letters. A zip with any other name is refused, used
  or not. Folders and files nobody lists (extras) are otherwise ignored.

## `project.json`

```json
{
  "format": "co-larger-project",
  "version": 1,
  "state": {
    "canvas": {},
    "variation": 0.5,
    "seed": 1,
    "photos": [],
    "plan": {},
    "assignment": [],
    "crops": {},
    "featured": ["photo-1"]
  },
  "photos": [
    {
      "id": "photo-1",
      "path": "photos/photo-1-beach.jpg",
      "name": "beach.jpg",
      "type": "image/jpeg",
      "included": true,
      "width": 4000,
      "height": 3000,
      "aspect": 1.3333333333333333,
      "lastModified": 1700000000000
    }
  ]
}
```

- `format` is always `co-larger-project`. `version` is a positive integer.
  This build reads versions 1 and 2 and writes the lowest version that can
  hold the project (see [Version 2](#version-2-hand-resized-tiles)); a higher
  version is refused with "this project was saved by a newer version". A
  change that an older build could not read must bump the version.
- `state` is the editor snapshot (see `EditorState` in `src/editor/state.ts`):
  canvas size (and physical size), border, background, the dial value, the
  seed, the layout `plan` itself, the `assignment` (which photo is in which
  tile, swaps included) and the per-photo `crops`. Opening restores it as it
  is: nothing is laid out or assigned again, so the collage is identical, even
  in another browser or at another screen size. It is checked with
  `validateEditorState` before anything is used.
- `state.featured` (optional, since #14) lists the ids of the featured photos:
  photos that re-rolls keep in the largest tiles. It is written sorted (any order is read), has no
  repeats, and every id must be a photo in `photos` (an excluded photo can be
  featured; it takes no tile until included again). It is left out when no
  photo is featured, so a project with nothing featured is written exactly as
  before. A missing field or an empty list means nothing is featured; any
  other value (not a list, a non-string or unknown id, a repeated id) is
  refused: the project does not open and the open project is left as it was.

### Compatibility of `state.featured`

The field was added without changing `version`, because readers ignore fields
they do not know: `validateEditorState` reads the fields it knows and builds a
fresh state from them, and `parseProject` does the same for the top level.
That has been true since the first release (2026.11.0), so:

- A project saved before #14 (no `featured`) opens with nothing featured and
  exactly the saved collage: the stored plan and assignment are used as they
  are.
- A project with featured photos opens in 2026.11.0 with the same collage
  (plan, assignment, crops), and the marks are ignored. Saving it again from
  2026.11.0 drops them; nothing else is lost.

Both directions are covered by `node scripts/browser-check.ts --feature-only
--feature-compat <a 2026.11.0 checkout>`. Bump `version` instead if a later
field must not be silently dropped by an older build.

### Version 2: hand-resized tiles

Dragging a divider (#16) changes the `fraction` of a split node in
`state.plan`; no field is added. The plan is saved and restored exactly, so a
hand-resized collage reopens as it was.

2026.11.0 places the plan in its own shape (the canvas ratio, no border) and
refuses it as "squashed" if any tile is longer than the planner's aspect
limit allows: `max(2.5, canvas aspect / number of tiles)`, where the canvas
aspect is its long side over its short side. So the limit is 2.5:1, except on
a canvas so long and thin for its photo count that even a row of equal tiles
is more stretched (20 000 × 1 000 px with two photos: 10:1). Every plan the
planner makes passes. Hand resizing may go past the limit (a tile only has to
stay at least 4% of the canvas's shorter side in both directions), so:

- Version 2 is written exactly when 2026.11.0 would refuse the plan.
  `versionFor` (`src/project/format.ts`) decides it with
  `withinPlannerShape` (`src/layout/dividers.ts`), which is that release's
  tile check (same placement, same limit, same 1e-6 slack); a unit test
  compares it against a copy of the release's code.
- Every other project, hand resized or not, is written as version 1, and
  2026.11.0 opens it with exactly the same collage.
- 2026.11.0 refuses a version 2 file with its "saved by a newer version of
  co-larger (format version 2; this one reads up to 1)" message and leaves
  its current project as it was, instead of opening something it would call
  damaged.
- This build reads both. Version 1 and 2 files are checked the same way: a
  tile may be beyond the planner's limit only if it is at least 4% of the
  shorter side in both directions (`checkTileSizes`); anything else (a split
  `fraction` of 0, 1, below 0, above 1, not a number, or so close to 0 or 1
  that a tile has no size) is refused, and the open project is unchanged.

The version is decided per save, so dragging a stretched tile back within
the limit and saving again writes version 1. Saving, opening and saving
again gives a byte-identical `project.json` with the same version. Both
directions are covered by `node scripts/browser-check.ts --divider-only
--feature-compat <a 2026.11.0 checkout>`.

- `photos` lists every photo in tray order. `included` says whether the
  collage uses it, and must agree with `state.photos`. `width`, `height` and
  `aspect` are the size after EXIF orientation; opening decodes each photo
  again and refuses it if its size differs. `path` is where the file is in the
  zip (`photos/<id>-<name>`, both made safe, with `~2`, `~3`, ... added if two
  would clash, ignoring case). `name`, `type` and `lastModified` are put back
  on the reconstructed `File`, so the same photo dropped in again is
  recognised as a duplicate (same name, size and time).

## Opening

Everything is built off to the side and checked: the zip structure and limits,
the manifest, the snapshot, that every listed file is present, that every photo
decodes to the size the manifest says, and that the whole thing can be
restored. Only then is the current project replaced, in one step. Any failure,
or Cancel, leaves the current project untouched.

The opened stored photos are slices of the zip file you chose, not copies, so
keep that file where it is while you work on the project. Deflated photos are
in-memory copies and do not depend on the file.

## Saving over the file you opened

Opened photos read from the zip you chose, so saving back over it must not
disturb them. With a save dialog (`showSaveFilePicker`), the code writes with
`createWritable()` and no options: the browser writes a separate swap file and
replaces the target only when the write is closed, so reads of the original
stay valid for the whole save. Cancel, or any read error, aborts the writable
and leaves the target untouched. After every save through a file handle, each
photo is rebound to the newly saved file (the saved archive's directory gives
each entry's offset and length), so later exports and saves read from it.

Without a save dialog the zip is assembled in a Blob from readable sources
first, and only a complete Blob is downloaded; the browser writes it to a
temporary file and renames it, so the source is never the output.

## If the project file goes away

If the zip is moved, deleted or replaced while you work, any read of a photo
from it (export, save) fails with one message and stops, with no partial
download: "The project file can no longer be read; it may have been moved or
deleted. Open it again from its new location." The editor keeps working: its
previews and thumbnails are in memory.
