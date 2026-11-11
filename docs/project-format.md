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

- Every entry uses the zip "store" method: no compression. Photos are
  already compressed, and storing keeps saving and opening fast and light on
  memory. Saved photos are byte for byte the originals.
- Excluded photos are saved too, so the tray comes back whole.
- Opening checks the CRC-32 of `project.json` and of every photo, streaming
  (nothing is held in memory twice), before the current project is replaced. A
  mismatch is refused with "this project file is damaged".
- Photos must be stored. A zip re-zipped by a system tool (compressed, or
  reordered) still works if the photos stay stored, and `project.json` may be
  deflated; a deflated photo is refused with a clear message (co-larger does
  not unpack photos, to keep memory flat). A comment in the end record,
  data descriptors and bytes after the end record are accepted. ZIP64 and
  encrypted entries are refused.
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
    "crops": {}
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
  This build writes version 1 and reads version 1; a higher version is refused
  with "this project was saved by a newer version". A change that an older
  build could not read must bump the version.
- `state` is the editor snapshot (see `EditorState` in `src/editor/state.ts`):
  canvas size (and physical size), border, background, the dial value, the
  seed, the layout `plan` itself, the `assignment` (which photo is in which
  tile, swaps included) and the per-photo `crops`. Opening restores it as it
  is: nothing is laid out or assigned again, so the collage is identical, even
  in another browser or at another screen size. It is checked with
  `validateEditorState` before anything is used.
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

The opened photos are slices of the zip file you chose, not copies, so keep
that file where it is while you work on the project.

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
