#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Builds sx-wasm and copies it to pkg/ (generated, git-ignored), where
# createWebSlicer() looks for it by default. Fails when the module is over its
# download budget, 1024 KB gzip.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
cd "$root"
# functions marked #[inline], the small generic helpers of std and the polygon crates among them, are
# inlined up to a cost of 150 instead of 325: 21 KB gzip smaller for under 1 percent more instructions.
# a panic in the module traps with no message either way (wasm32 has no stderr), so std is built from
# source with the immediate-abort panic strategy: no panic formatting or source locations, 39 KB gzip
# smaller and a little faster. std, core, alloc and the allocator stay at opt-level 3, as rustup ships
# them. both need nightly options, unlocked for the pinned compiler with RUSTC_BOOTSTRAP, and rust-src.
flags='target.wasm32-unknown-unknown.rustflags=["-Cllvm-args=-inlinehint-threshold=150", "-Zunstable-options", "-Cpanic=immediate-abort"]'
build() {
  RUSTC_BOOTSTRAP=1 cargo build -q -Zbuild-std=std,panic_abort -p sx-wasm --target wasm32-unknown-unknown \
    --profile wasm-release --config "$flags" \
    --config 'profile.wasm-release.package.std.opt-level=3' \
    --config 'profile.wasm-release.package.core.opt-level=3' \
    --config 'profile.wasm-release.package.alloc.opt-level=3' \
    --config 'profile.wasm-release.package.dlmalloc.opt-level=3' \
    --config 'profile.wasm-release.package.compiler_builtins.opt-level=3'
}
out="${CARGO_TARGET_DIR:-target}"/wasm32-unknown-unknown/wasm-release/sx_wasm.wasm
mkdir -p "$here/pkg"
if [ "${SX_WASM_OPT:-1}" = 0 ]; then
  build
  cp "$out" "$here/pkg/sx_wasm.wasm"
else
  command -v wasm-opt >/dev/null || {
    echo "build-wasm: wasm-opt not found; install binaryen 133, or set SX_WASM_OPT=0 for a larger module" >&2
    exit 1
  }
  # keep the name section for wasm-opt, which strips it
  CARGO_PROFILE_WASM_RELEASE_STRIP=debuginfo build
  # binaryen's inlining makes the module compress worse, so it is skipped. ordering functions by their
  # mangled names puts the copies of each generic side by side, about 40 KB less gzip.
  wasm-opt "$out" --strip-debug --strip-producers -O2 --skip-pass=inlining-optimizing --converge \
    --reorder-functions-by-name -o "$here/pkg/sx_wasm.wasm"
fi
# gzip level 9 in node's zlib, as apps/web/scripts/bundle-size.mjs measures it
gz=$(node -e 'console.log(require("node:zlib").gzipSync(require("node:fs").readFileSync(process.argv[1]), { level: 9 }).length)' "$here/pkg/sx_wasm.wasm")
echo "pkg/sx_wasm.wasm: $(wc -c < "$here/pkg/sx_wasm.wasm") bytes, $gz gzip"
if [ "$gz" -gt $((1024 * 1024)) ]; then
  echo "build-wasm: $gz bytes gzip is over the 1024 KB budget" >&2
  exit 1
fi
