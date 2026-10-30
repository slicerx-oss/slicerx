occt-import-js 0.0.23 (Viktor Kovacs, LGPL-2.1) built with Open CASCADE Technology 7.6.1 (Open CASCADE
SAS, LGPL-2.1 with the Open CASCADE exception 1.0) and Emscripten 3.1.69. This package uses it to read STEP
files (src/read.ts). It is loaded only when a STEP file is read, and in the SlicerX app only in a worker of
its own, never in the app shell or the geometry engine.

Sources, pinned:

- occt-import-js: https://github.com/kovacsv/occt-import-js, commit c2148e54b456b571238d35cac037d304053d64b2 (tag 0.0.23)
- OCCT: https://github.com/Open-Cascade-SAS/OCCT, commit d2abb6d844231cb8f29be6894440874a4700e4a5 (7.6.1, the submodule of that tag)
- Emscripten 3.1.69 through https://github.com/emscripten-core/emsdk (the version upstream builds with)

`build.sh` builds `src/occt-import-js.mjs` and `src/occt-import-js.wasm` from those sources. It differs from
the upstream build in two ways:

1. `patches/0001-mesh-kind.patch` adds a `kind` field to each mesh (`solid`, `shell` or `faces`) so the reader
   can keep solids and leave out reference surfaces. Three files, twelve lines.
2. The module is linked as an ES module for browsers, workers and Node (`-sEXPORT_ES6=1
   -sENVIRONMENT=web,worker,node`) with a 4 GB memory limit, so a worker can import it without
   evaluating script text.

The upstream npm package (occt-import-js@0.0.23, sha512-RFfYQXYFX5C1mB1Aywm0ShcUKzXOr/VzTnlzhBSDJOR6YCAPt1HYCzeXWg1vwwjn/cUxwqRNhhtf1dlewoZYCQ==)
was used only to compare candidates before this build and is not in the repo.

Outputs (SHA-256), the files in `src/` and, once packed, in `dist/`:

- `occt-import-js.mjs` (98,887 bytes): 1e9df053d943ee2917fff18a7d2bcf0a691ab249a418c92107ef10e7e20ba911
- `occt-import-js.wasm` (7,604,102 bytes, 3,084,242 gzip): 327fac9309088f7907fdbba97b274f4b8991a51f6d22c06df62ad2ac5f83db7f

`test/package.test.ts` checks both against these lines.

## Licenses

- Our TypeScript (`src/*.ts`), the build scripts and the docs: Apache-2.0 (LICENSE-APACHE).
- `occt-import-js.wasm`: occt-import-js under the LGPL-2.1 (LICENSE-occt-import-js.txt) and OCCT under the
  LGPL-2.1 with the Open CASCADE exception 1.0 (LICENSE-occt.txt, OCCT_LGPL_EXCEPTION.txt). This package
  makes use of facilities provided by the Open CASCADE Technology software. The wasm also holds parts of
  Emscripten's C library (musl, LICENSE-musl.txt) and C++ library (libc++ and libc++abi, LICENSE-libcxx.txt).
- `occt-import-js.mjs`: the JavaScript glue Emscripten generated, MIT (LICENSE-emscripten.txt).

The wasm file is a separate, replaceable file loaded at run time. Building it again from the sources above
with `build.sh` and putting it in `src/` (or next to `dist/index.js` in an installed package) is all a
replacement needs; `loadStepReader({ wasm })` also takes another file's URL.

## Source offer (LGPL-2.1, sections 4 and 6)

Everything that ships this reader in object code (the npm package, the SlicerX desktop app, whose one
copy sits in the `mcp/step-reader` folder beside its bundled MCP server and also serves its window, and the
hosted web app) offers its complete corresponding source from the same place:

- `occt-import-js-source-0.0.23.tar.gz`: occt-import-js and OCCT at the commits above, the patch in
  `patches/`, `build.sh`, `source-archive.sh`, this file and the license texts, without git metadata.
  `sh source-archive.sh <work-dir> <out-dir>` makes it. `build.sh` in it fetches the same pinned commits
  with git; the unpacked trees are the same source.
- Each SlicerX release attaches that archive. Each npm version of this package has a GitHub release
  tagged `step-reader-v<version>` in https://github.com/slicerx-oss/slicerx with the archive attached;
  publishing refuses to run until it is there (`scripts/check-source-release.mjs`, run before publishing).
- The hosted web app links the source of the exact build in its About dialog; the same archive sits
  next to that release.
- For three years after the last release that ships a given version, anyone can ask for that archive in
  the project's issue tracker, and it is sent at no more than the cost of sending it.

The About dialog of every SlicerX build names the library, its license and the Open CASCADE
acknowledgment, and points here.
