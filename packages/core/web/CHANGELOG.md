# Changelog: @slicerx/slicer

Keep a Changelog format; semver.

## [Unreleased]

### Added

- `meshParts(id)` and `projectMetadata(data, fileName)` on the pool host, and `decodeParts`.
- `createWebSlicer` with the WASM worker pool (default) or the synthetic stub (`fake`).
- Re-exports `readPreview`, the SXPV constants, `FEATURE` and the slice and `PrintConfig` types from the contracts.
- `createWasmSlicer` (options `shardsPerWorker`, default 8, and `warmUp`, default true), `createFakeSlicer`, `stitchPreview`, `encodeParts`, `syntheticPreview`.

### Changed

- The worker pool starts one worker and adds the rest (up to `workers`) when a slice has shards for them. A new worker loads the meshes already in the pool before it takes a shard, and the slice starts on the workers already running, so page load no longer starts about ten WASM instances. G-code is identical at every shard count.

### Fixed

- `slice` now forwards `options.flavor`, `layerTopsMm`, `resumeFromLayer` and `heightRanges` to the workers; before, only the plate and config were sent.
