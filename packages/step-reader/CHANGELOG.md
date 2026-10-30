# Changelog

## Unreleased

- The integrator kit ships the reader as its own optional tarball, `slicerx-step-reader.tgz`, listed in `kit-manifest.json` (with `optional: true`) and `SHA256SUMS.txt`, with the license texts, NOTICE, SOURCE.md and the wasm. The version moves to the kit's line, 0.2.6, so `@slicerx/mcp` 0.2.6 takes it as its optional peer.
- `STEP_MAX_MEMORY_MB` (2048) is now exported from the package root as well as `@slicerx/step-reader/node`, so a browser worker can pass the same wasm memory cap the Node path uses: `loadOcct({ maxMemoryMb: STEP_MAX_MEMORY_MB })`. The app's STEP worker does, so a file that needs more than that fails with `out_of_memory` instead of growing the tab toward the 4 GB wasm limit.
- A STEP file saved with a UTF-8 byte order mark (the bytes EF BB BF in front of `ISO-10303-21;`, which some editors and Windows tools write) reads like the same file without one. Before, it was refused with `not_step`. The mark comes off before the file reaches OpenCASCADE, which also refuses a file that starts with one; output for files without a mark is unchanged.

## 0.1.0

- First release: STEP AP203, AP214 and AP242 files to meshes in millimeters, in browsers, workers and Node. Objects and bodies with their names, touching bodies grouped, units converted, body colors as data. OBJ and binary STL output. `@slicerx/step-reader/node` reads each file in a worker thread with a deadline, an input size cap and a memory cap. Errors are `StepError` with a stable `code`.
