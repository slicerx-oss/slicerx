# @slicerx/slicer

```sh
npm install @slicerx/slicer
```

Browser slicing: a pool of Web Workers, each with its own `sx-wasm` instance. A slice is split into one layer range per worker, the G-code chunks are concatenated and the SXPV chunks stitched (`stitchPreview`). The core guarantees the result is byte-identical to a single run. The pool implements `SlicerHost` from `@slicerx/contracts`. No SharedArrayBuffer or cross-origin isolation is needed.

## Public API

```ts
createWebSlicer(opts?: { workers?: number; wasmUrl?: string | URL; fake?: boolean | FakeSlicerOptions }): Promise<SlicerHost>
createWasmSlicer(opts: { wasm: string | URL | WebAssembly.Module; workers?: number; createWorker?: () => Worker }): Promise<SlicerHost>
createFakeSlicer(opts?: { delayMs?: number; layers?: number }): SlicerHost
stitchPreview(chunks: ArrayBuffer[]): ArrayBuffer
encodeParts(parts: MeshPart[]): Uint8Array
decodeParts(raw: Uint8Array): MeshPart[]
syntheticPreview(spec?): ArrayBuffer
// also re-exported: readPreview, the SXPV constants, FEATURE, and the slice and PrintConfig types
```

`createWebSlicer()` loads `pkg/sx_wasm.wasm` by default. That file is generated and git-ignored: build it with `pnpm --filter @slicerx/slicer build:wasm`. `{ fake: true }` returns a stub that answers after 150 ms with a synthetic SXPV (a stack of rings), for hosts that run without the module.

Plate objects need a 4x4 column-major transform in mm (Z up, origin at the bed's front left corner). `loadModel` takes 3MF (first plate), STL or the quantized JSON model format (OBJ and AMF go through the separate `sx-geom` module in the browser); `loadParts` takes raw geometry buffers. `meshParts(id)` returns a loaded model's geometry (any format, in the file's build space) for drawing, and `projectMetadata(data, fileName)` reads a 3MF project's settings entries without loading geometry. `slice` forwards `options.flavor`, `layerTopsMm`, `resumeFromLayer` and `heightRanges` to the engine.

`reviewScripts(inputs)` reviews printer scripts in a worker with the same Rust parser and versioned stock catalog as native `sx review-script --batch`. Each input supplies `selected: { model, firmware } | null`, optional `declared` identities, a setting `key`, and original `text`. Results contain the decision, reason, identity, stock source/version, fingerprint and ignored cosmetic differences. This read-only operation does not apply scripts or grant permission to print. Older engines without script-review exports return a review-required result.

Run `node scripts/check-script-review.mjs <sx-binary> <wasm-file> [port]` from this package to compare complete native and browser-worker review records. Use real native and WASM builds from the same revision and an installed Playwright Chromium. The check covers cosmetic changes, changed arguments, added commands, missing or conflicting identity, unknown firmware, malformed templates and a template embedded in a comment. The default local port is 5304.

## Packing

`pnpm --filter @slicerx/slicer build` builds the module, bundles `dist/index.js` and the worker chunk with Vite (`vite.lib.config.mjs`), copies `sx_wasm.wasm` next to them and writes self-contained type declarations (`scripts/emit-types.mjs`). `@slicerx/contracts` is bundled into both, so the package has no runtime dependencies. `pnpm pack` (or `pnpm publish --access public`, which runs the build first) produces a tarball whose `exports` point at `dist` (`publishConfig`); inside the workspace the package still resolves to `src`. `prepublishOnly` stops a plain `npm publish` from the folder, which would ship the workspace manifest.

## Dependencies

- `@slicerx/contracts` (workspace, bundled when packed): the host and preview types.
- `vite` 8.3.1 and `playwright` 1.63.0 (dev only, MIT and Apache-2.0): the browser bench page in `bench/` and `../bench/web-slice.mjs`.

## Status

Measured browser numbers are in `../bench/README.md`. The G-code SHA-256 matches the native build, and 1-range and 64-range outputs are identical.

Two pool settings came out of the browser hill-climb (`../bench/WEB-LOG.md`): each worker takes up to 8 layer ranges from a shared queue (at most 64 ranges), so workers that draw heavy solid layers do not hold up the rest, and each worker slices a 20 mm cube at start-up so the first real slice runs tiered-up code. The pool starts with one worker and grows to `workers` when a slice has shards for more; a new worker loads the pool's meshes and then takes shards from the same queue. Pool start (compiling the module, one worker, the warm-up) takes 40 to 70 ms and mesh load about 10 ms; neither is part of the slice time. Between the fifth and sixth rows of that log the module was rebuilt with the faster native core, which is why the baseline drops there.
