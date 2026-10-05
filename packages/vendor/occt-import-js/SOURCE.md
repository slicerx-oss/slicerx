occt-import-js 0.0.23 (Viktor Kovacs, LGPL-2.1) built with Open CASCADE Technology 7.6.1 (Open CASCADE
SAS, LGPL-2.1 with the Open CASCADE exception 1.0). SlicerX uses it to read STEP files
(packages/app/src/state/step-read.ts). It is loaded only when a STEP file is opened, in a worker of its
own, and is never part of the app shell or the geometry engine.

Sources, pinned:

- occt-import-js: https://github.com/kovacsv/occt-import-js, commit c2148e54b456b571238d35cac037d304053d64b2 (tag 0.0.23)
- OCCT: https://github.com/Open-Cascade-SAS/OCCT, commit d2abb6d844231cb8f29be6894440874a4700e4a5 (7.6.1, the submodule of that tag)
- Emscripten 3.1.69 through https://github.com/emscripten-core/emsdk (the version upstream builds with)

`build.sh` builds `lib/` from those sources. It differs from the upstream build in two ways:

1. `patches/0001-mesh-kind.patch` adds a `kind` field to each mesh (`solid`, `shell` or `faces`) so SlicerX
   can keep solids and leave out reference surfaces. Three files, twelve lines.
2. The module is linked as an ES module for browsers, workers and Node (`-sEXPORT_ES6=1
   -sENVIRONMENT=web,worker,node`) with a 4 GB memory limit, so the worker can import it without
   evaluating script text.

The upstream npm package (occt-import-js@0.0.23, sha512-RFfYQXYFX5C1mB1Aywm0ShcUKzXOr/VzTnlzhBSDJOR6YCAPt1HYCzeXWg1vwwjn/cUxwqRNhhtf1dlewoZYCQ==)
was used only to compare candidates before this build and is not in the repo.

Outputs (SHA-256):

- `lib/occt-import-js.mjs` (98,887 bytes): 1e9df053d943ee2917fff18a7d2bcf0a691ab249a418c92107ef10e7e20ba911
- `lib/occt-import-js.wasm` (7,604,102 bytes, 3,084,242 gzip): 327fac9309088f7907fdbba97b274f4b8991a51f6d22c06df62ad2ac5f83db7f

License texts: LICENSE-occt-import-js.txt (LGPL-2.1), LICENSE-occt.txt (LGPL-2.1) and
OCCT_LGPL_EXCEPTION.txt. SlicerX makes use of facilities provided by the Open CASCADE Technology
software. The wasm file is a separate, replaceable file loaded at run time: building it again from the
sources above with `build.sh` and putting it in `lib/` is all a replacement needs.

## Source offer (LGPL-2.1, sections 4 and 6)

Every SlicerX build that ships the STEP reader (the desktop app and the hosted web app) carries this
library in object code. Its complete corresponding source is offered from the same place as the build:

- Each release attaches `occt-import-js-source-0.0.23.tar.gz`: occt-import-js and OCCT at the commits
  above, the patch in `patches/`, `build.sh` and these license texts. `source-archive.sh` makes it.
- The hosted web app links the source of the exact build in its About dialog; the same archive sits
  next to that release.
- For three years after the last build that ships a given version, anyone can ask for that archive in
  the project's issue tracker, and it is sent at no more than the cost of sending it.

The About dialog of every build names the library, its license and the Open CASCADE acknowledgment,
and points here.
