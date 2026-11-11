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
