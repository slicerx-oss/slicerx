# Changelog: @slicerx/slicer

Keep a Changelog format; semver.

## [Unreleased]

### Added

- `projectMetadata` returns a PrusaSlicer project's print and filament settings as `projectSettings`, with `settingsFrom: "prusaslicer"`.
- The slice result carries `chamberCooling` (the chamber cooling mode the printer's G-code reads, and where it came from), from the shards; `chamberCoolingOf` and `plateFacts` read it.
- `meshParts(id)` and `projectMetadata(data, fileName)` on the pool host, and `decodeParts`.
- `createWebSlicer` with the WASM worker pool (default) or the synthetic stub (`fake`).
- Re-exports `readPreview`, the SXPV constants, `FEATURE` and the slice and `PrintConfig` types from the contracts.
- `createWasmSlicer` (options `shardsPerWorker`, default 8, and `warmUp`, default true), `createFakeSlicer`, `stitchPreview`, `encodeParts`, `syntheticPreview`.

### Changed

- A color change layer mark writes the printer's pause G-code (`M400 U1` on a Bambu Lab printer) instead of `M600`, so the print stops for a filament swap by hand, and on a plate printed by object a pause or color change by height stops each object.
- The worker pool starts one worker and adds the rest (up to `workers`) when a slice has shards for them. A new worker loads the meshes already in the pool before it takes a shard, and the slice starts on the workers already running, so page load no longer starts about ten WASM instances. G-code is identical at every shard count.

### Fixed

- `slice` now forwards `options.flavor`, `layerTopsMm`, `resumeFromLayer` and `heightRanges` to the workers; before, only the plate and config were sent.
