# Changelog

## Unreleased

- An IGES file of loose trimmed surfaces and no solids is sewn into closed solids before it is meshed, so it comes out watertight instead of as open surfaces a mesh repair has to close. The sewing runs in the OpenCASCADE build (`patches/0002-sew-iges-faces.patch`) with a tolerance scaled to the model, a ten thousandth of its box diagonal, from 0.001 mm to 0.1 mm. Each group of surfaces that closes becomes a solid, with the note "The file has surfaces and no solids, so they were sewn into one solid." Surfaces that do not close stay open bodies as before, with the note they had. The wasm is rebuilt with the patch (SOURCE.md); STEP files read exactly as before.
- Reads IGES files (`.igs`, `.iges`) with the same OpenCASCADE build, into the same output as a STEP file: objects of touching bodies, names, body colors, millimeters whatever unit the file declares, and notes. `loadStepReader().read`, `readStepInWorker` and `readStepFileInWorker` take either format, told apart by the bytes, else by the name. New exports: `readIges`, `readCad`, `cadFormat` and `igesUnit`. An IGES file of loose trimmed surfaces and no solids, which many CAD programs write, becomes a body per group of touching surfaces with a note, where a STEP file of loose faces only is still refused. Two new `StepError` codes: `not_iges`, and `iges_compressed` for the compressed IGES form.
- `loadOcct` keeps OpenCASCADE's standard output quiet with or without a memory cap. Its IGES reader prints a line for every file.
- `loadOcct` with `maxMemoryMb` and a `file:` URL in `wasm` reads the wasm from disk in Node. Before, it fetched the URL, and Node's `fetch` does not read `file:` URLs, so the load failed with `fetch failed`. Without a cap the Emscripten glue already read the file itself. Browsers and workers still fetch every URL.

## 0.2.7

- The integrator kit ships the reader as its own optional tarball, `slicerx-step-reader.tgz`, listed in `kit-manifest.json` (with `optional: true`) and `SHA256SUMS.txt`, with the license texts, NOTICE, SOURCE.md and the wasm. The version moves to the kit's line, 0.2.7, so `@slicerx/mcp` 0.2.7 takes it as its optional peer.
- `STEP_MAX_MEMORY_MB` (2048) is now exported from the package root as well as `@slicerx/step-reader/node`, so a browser worker can pass the same wasm memory cap the Node path uses: `loadOcct({ maxMemoryMb: STEP_MAX_MEMORY_MB })`. The app's STEP worker does, so a file that needs more than that fails with `out_of_memory` instead of growing the tab toward the 4 GB wasm limit.
- A STEP file saved with a UTF-8 byte order mark (the bytes EF BB BF in front of `ISO-10303-21;`, which some editors and Windows tools write) reads like the same file without one. Before, it was refused with `not_step`. The mark comes off before the file reaches OpenCASCADE, which also refuses a file that starts with one; output for files without a mark is unchanged.

## 0.1.0

- First release: STEP AP203, AP214 and AP242 files to meshes in millimeters, in browsers, workers and Node. Objects and bodies with their names, touching bodies grouped, units converted, body colors as data. OBJ and binary STL output. `@slicerx/step-reader/node` reads each file in a worker thread with a deadline, an input size cap and a memory cap. Errors are `StepError` with a stable `code`.
