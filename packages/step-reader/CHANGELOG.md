# Changelog

## Unreleased

- `loadOcct` with `maxMemoryMb` and a `file:` URL in `wasm` reads the wasm from disk in Node. Before, it fetched the URL, and Node's `fetch` does not read `file:` URLs, so the load failed with `fetch failed`. Without a cap the Emscripten glue already read the file itself. Browsers and workers still fetch every URL.
- `STEP_MAX_MEMORY_MB` (2048) is now exported from the package root as well as `@slicerx/step-reader/node`, so a browser worker can pass the same wasm memory cap the Node path uses: `loadOcct({ maxMemoryMb: STEP_MAX_MEMORY_MB })`. The app's STEP worker does, so a file that needs more than that fails with `out_of_memory` instead of growing the tab toward the 4 GB wasm limit.
- A STEP file saved with a UTF-8 byte order mark (the bytes EF BB BF in front of `ISO-10303-21;`, which some editors and Windows tools write) reads like the same file without one. Before, it was refused with `not_step`. The mark comes off before the file reaches OpenCASCADE, which also refuses a file that starts with one; output for files without a mark is unchanged.

## 0.1.0

- First release: STEP AP203, AP214 and AP242 files to meshes in millimeters, in browsers, workers and Node. Objects and bodies with their names, touching bodies grouped, units converted, body colors as data. OBJ and binary STL output. `@slicerx/step-reader/node` reads each file in a worker thread with a deadline, an input size cap and a memory cap. Errors are `StepError` with a stable `code`.
