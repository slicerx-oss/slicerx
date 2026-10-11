# Format corpus

Model files that every reader in the repository opens, so their answers can be compared: sx-core's loader (`threemf.rs`, `mesh.rs`), sx-geom's import, the app's 3MF and STL readers (`packages/app/src/export`) and the sx3mf crate. `corpus.json` lists the files and which app wrote each one; most live next to the tests that already use them.

```sh
node scripts/format-corpus/run.mjs                      # report in target/format-corpus/report.md
node scripts/format-corpus/run.mjs --private <dir>      # also every model file in a folder outside the repository
node scripts/format-corpus/run.mjs --check              # fail when the disagreements differ from known-differences.json
node scripts/format-corpus/run.mjs --write-known        # record them after a reader changed on purpose
```

It builds the Rust reader in release (`packages/core/examples/format_read.rs`) and runs the app's through tsx (`packages/app/scripts/format-read.ts`), so run it on a build machine. Times are the first read and the fastest of `--repeats` (default 3). Peak memory is the reader process's maximum resident set less that of the same process reading nothing. The app's project reader parses its settings files with jsdom's DOMParser in Node, which is slower than a browser's.

The files made here:

- `make.py` writes `subtypes.3mf` (one object with a part of each subtype), `two-colors.obj`, `two-materials.amf` and `box-ascii.stl`: `python3 make.py <dir>`.
- `bambu-*.3mf`, `orca-*.3mf` and `prusa-*.3mf` are SlicerX's own models (`subtypes.3mf`, `packages/core/cli/tests/fixtures/painted.3mf`, `packages/core/bench/models/x-mark-2color.3mf`, `two-colors.obj`) saved again by the Bambu Studio 2.8, OrcaSlicer 2.4 and PrusaSlicer 2.9 command lines (`--export-3mf`). The settings in them come from those apps' profiles (REUSE.toml).

Designs we may not commit (customer files, Vault designs) stay in a private folder and come in with `--private`; they are left out of `--check`.
