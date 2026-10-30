# @slicerx/step-reader

```sh
npm install @slicerx/step-reader
```

The integrator kit has it as its own tarball, beside the server's: `npm install ./kit/slicerx-step-reader.tgz`. `@slicerx/mcp` loads it for `slicerx_step_read` when it is installed beside it.

Reads STEP files (AP203, AP214 and AP242) into triangle meshes in millimeters, in a browser, a worker or Node. It is the reader the SlicerX app uses, on Open CASCADE Technology 7.6.1 compiled to WebAssembly. The package is opt-in because of its size: about 3.2 MB to download and 7.9 MB installed, almost all of it the wasm.

What a read gives you:

- Objects, each with its bodies (one per solid). Bodies whose boxes touch stay together as one object (a bolt in its bracket); bodies apart from the rest become objects of their own. Names come from the file, with the file name standing in for generic ones.
- Positions in millimeters whatever unit the file declares, centered on the origin in double precision.
- A body's color as `#rrggbb` when the file colors its solid (face colors are not read).
- Open shells and loose faces left out when the file has solids, with a note saying so.
- Notes for the person ("Converted from inches to millimeters.").

## Use

```ts
import { loadStepReader, toObj, toStl, stepInfo, StepError } from '@slicerx/step-reader'

const reader = await loadStepReader()
try {
  const read = reader.read(bytes, { name: 'bracket.step', quality: 'normal' })
  const obj = toObj(read) // `o` per object, `g` per body; colored bodies get vertex colors
  const stl = toStl(read) // binary STL; colored bodies get facet colors (bit 15 set, 5 bits a channel)
  console.log(stepInfo(read)) // objects, bodies, colors, triangle counts and boxes in mm
} catch (e) {
  if (e instanceof StepError) console.log(e.code, `bracket.step ${e.message}`)
  reader.close() // OpenCASCADE may be in any state after a failure: load a new reader
}
```

`quality` is the chord tolerance: `coarser` 0.05 mm, `normal` 0.01 mm, `finer` 0.003 mm, with 0.5 rad on angles. A model over 2,000,000 triangles is meshed again at 0.05 mm, and refused if it is still over. Messages are meant to follow the file name. Pass `appName` to `read` to name your app in them.

`StepError.code` is one of `empty`, `not_step`, `step_xml`, `too_large` (over 100 MB), `no_solids`, `too_detailed`, `unreadable`, `out_of_memory` and `timeout`.

### Servers and untrusted files

`@slicerx/step-reader/node` reads each file in a worker thread of its own, so a damaged or hostile file costs that thread and never the calling process:

```ts
import { readStepFileInWorker } from '@slicerx/step-reader/node'

const read = await readStepFileInWorker('/models/bracket.step', { name: 'bracket.step', timeoutMs: 60_000, maxMemoryMb: 1024 })
```

The deadline defaults to a minute plus 2 s per megabyte, the memory OpenCASCADE may grow to defaults to 2048 MB, and files over 100 MB are refused before they are read. Each read loads the wasm afresh.

### Bundlers

The code finds the wasm with `new URL('./occt-import-js.wasm', import.meta.url)`, which Vite, webpack 5, Rollup and esbuild with a copy step all handle: the wasm is emitted as an asset and fetched the first time a reader loads. In Vite's dev server, add the package to `optimizeDeps.exclude` so the URL keeps pointing next to the module. `loadStepReader({ wasm })` takes another URL, for a CDN or a rebuilt wasm. The wasm is also exported as `@slicerx/step-reader/occt-import-js.wasm`.

## Licenses

`Apache-2.0 AND LGPL-2.1-only AND LGPL-2.1-only WITH OCCT-exception-1.0 AND MIT AND Apache-2.0 WITH LLVM-exception`:

- The TypeScript (`dist/*.js`), the build scripts and these docs: Apache-2.0.
- `dist/occt-import-js.wasm`: occt-import-js (LGPL-2.1) and Open CASCADE Technology (LGPL-2.1 with the Open CASCADE exception 1.0), with Emscripten's musl (MIT) and libc++ (Apache-2.0 with LLVM exceptions). This package makes use of facilities provided by the Open CASCADE Technology software.
- `dist/occt-import-js.mjs`: the glue Emscripten generated, MIT.

The license texts and NOTICE ship in the package. The wasm is a separate file loaded at run time, so you can rebuild it with `build.sh` and replace it.

To get the source of the wasm in your copy, download `occt-import-js-source-0.0.23.tar.gz` from the GitHub release `step-reader-v<version>` of https://github.com/slicerx-oss/slicerx (the same version as your package). It holds occt-import-js at commit c2148e54 (tag 0.0.23) and OCCT at commit d2abb6d8 (7.6.1, the submodule of that tag), without git metadata, plus a `slicerx/` folder with the patch, `build.sh`, `source-archive.sh`, SOURCE.md and the license texts. `build.sh` rebuilds the wasm from those commits with Emscripten 3.1.69; it fetches them with git rather than reading the unpacked trees. Publishing refuses to run until that archive is on the release. SOURCE.md has the full source offer.

## Development

`pnpm --filter @slicerx/step-reader test` runs the tests: the output held to the app reader's from before this package, colors, the worker with its caps and hostile files, the packed tarball's size budget and contents, and the wasm found by Vite (web and desktop builds) and Node. `pnpm pack` builds `dist/` (`scripts/build.mjs`); inside the workspace the package resolves to `src/`.
