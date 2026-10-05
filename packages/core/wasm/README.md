# sx-wasm

`sx-core` for one browser Web Worker, built for `wasm32-unknown-unknown` without the `parallel` feature. It exports a plain C ABI instead of wasm-bindgen, so the build needs only cargo and binaryen's `wasm-opt`, and the module needs no imports. The JS side is `../web/src/wasm.ts`. The only unsafe item is the `no_mangle` attribute, which is why the crate sets its own lints.

## Public API

Byte buffers cross through an input buffer the module owns: `sx_input(len)` returns its address, JS writes into linear memory, then calls one of:

- `sx_load_mesh() -> id`: input is the file name, a zero byte, the file bytes. Output 2 is mesh info JSON.
- `sx_release_mesh(id)`
- `sx_slice_shard(shard, shards) -> status`: input is a request JSON whose object `mesh` values are mesh ids. Output 0 is the G-code chunk, 1 the SXPV chunk, 2 info JSON (layer range, z and times, stats, stage timings, warnings). The prepared session is reused while the request bytes stay the same.
- `sx_out_ptr(which)`, `sx_out_len(which)`, `sx_error_ptr()`, `sx_error_len()`.

Build: `pnpm --filter @slicerx/slicer build:wasm` (profile `wasm-release`, then `wasm-opt`), which writes the module to `../web/pkg/`. It needs binaryen 133 on the PATH (`brew install binaryen`, or `sh scripts/install-binaryen.sh <dir>`, which prints the directory to add); `SX_WASM_OPT=0` skips the pass and gives a larger module.

## Status

2714 KB, 994 KB gzip (budget 1024 KB gzip, which the build checks), including the 3MF reader. One worker slices the reference plate in about 157 ms in Chrome. Output is byte-identical to the native build.
