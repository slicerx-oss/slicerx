<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright (C) 2026 The SlicerX contributors -->
# The .sx3mf format

An `.sx3mf` file is a 3MF project. It holds the full project exactly as a 3MF would: geometry, plates, per-object settings, color assignments and thumbnails, in the layout Bambu Studio and OrcaSlicer use. The only addition is a few `sx:` metadata entries in the root model part that name the library model, its creator and the account that exported the file. The geometry is never changed, so any 3MF reader opens an `.sx3mf` once its extension is `.3mf`.

SlicerX saves and exports projects and models as `.sx3mf`. G-code and `.gcode.3mf` exist only as print output. Import reads 3MF, STL, OBJ, AMF, STEP (`.step`, `.stp`) and `.sx3mf`.

A locked project (`.sxlock`, `SPEC-sxlock.md`) is an `.sx3mf` encrypted for one SlicerX account.

Namespace: `https://slicerx.app/schemas/sx3mf/2026`, bound to the prefix `sx`.

## Package

The package follows the 3MF core specification and Open Packaging Conventions. `/_rels/.rels` has a relationship of type `http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel` to the root model part, usually `/3D/3dmodel.model`. Readers find the model through that relationship. A package thumbnail, when present, is the target of the relationship type `http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail`. The library writes it to `/Metadata/thumbnail.png`.

There is no manifest, payload part or license record. Earlier drafts had them; readers ignore any such parts.

## The model part

The root `model` element binds `xmlns:sx` to the namespace. The `sx:` entries are `metadata` children of `model`, written after the standard entries (`Title`, `Designer`, `Application` and so on) and before `resources`:

```xml
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
       xmlns:sx="https://slicerx.app/schemas/sx3mf/2026">
  <metadata name="Title">Desk owl</metadata>
  <metadata name="sx:Listing">lst_01J...</metadata>
  <metadata name="sx:Version">1.2.0</metadata>
  <metadata name="sx:VersionId">ver_01J...</metadata>
  <metadata name="sx:Creator">8c1f...</metadata>
  <metadata name="sx:ExportedBy">3b9a...</metadata>
  <resources>...</resources>
  <build>...</build>
</model>
```

| Entry | Meaning | Written by |
| --- | --- | --- |
| `sx:Listing` | Library model id | App (when the project came from the library), library |
| `sx:Version` | Listing version number | Library |
| `sx:VersionId` | Listing version id | Library |
| `sx:Creator` | Creator id | App (when known), library |
| `sx:ExportedBy` | Id of the signed-in account that exported the file, empty when signed out | App |

Every entry is optional. Values are plain text with no control characters. A file is an `.sx3mf` when its model binds `sx` to the namespace or carries any `sx:` entry; otherwise it is a plain 3MF. Unknown `sx:` entries are ignored.

Bambu Studio and OrcaSlicer projects may also carry `sx:Listing` and `sx:Creator` per object in `Metadata/model_settings.config` (`<metadata key="sx:Listing" value="..."/>`), so a project that mixes models from several listings keeps each object's source.

## Library files

The upload scan (`sx-upload-scan`) sanitizes every upload, converts an STL to a 3MF, and stamps the result with the listing's `sx:Listing`, `sx:Version`, `sx:VersionId` and `sx:Creator`. Any `sx:` entries the upload carried are replaced, so the uploader's `sx:ExportedBy` never reaches the library. The 256 px preview becomes the package thumbnail. All other parts are copied byte for byte.

## Reader rules

- Entry names must be relative, use `/` only, and contain no empty, `.` or `..` segments, backslashes, colons or control characters.
- XML parts with a DOCTYPE or an entity other than the five predefined ones are refused.
- `sx3mf::inspect` reads at most the first 1 MiB of the model part: the `sx:` entries come before `resources`, so the size of the geometry does not matter. It accepts up to 10,000 entries, 4 MiB for the relationships and content types parts, and an 8 MiB thumbnail. A thumbnail relationship that points at a missing part is ignored.
