#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Builds pkg/sx_geom_exact.mjs and pkg/sx_geom_exact.wasm (generated, git-ignored): the full engine with exact solids,
# one Emscripten module holding sx-geom and the SMLib kernel. The app's worker loads it in place of the full engine
# when exact solids are on (packages/app/src/geom/modules.ts), never beside it. Takes a work directory for the kernel's
# objects and Emscripten (packages/brep/scripts/wasm-objects.sh; CI caches it):
#   sh packages/geom/wasm/scripts/build-exact.sh <work-dir>
# No compiler for wasm32-unknown-emscripten comes with the pinned toolchain, so std is built from rust-src, an option
# unlocked for the pinned compiler with RUSTC_BOOTSTRAP, as packages/core/web/scripts/build-wasm.sh does.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../../.." && pwd)
work=${1:?usage: build-exact.sh <work-dir>}
start=$(date +%s)
sh "$root/packages/brep/scripts/wasm-objects.sh" "$work"
echo "build-exact: kernel objects in $(($(date +%s) - start)) s"
work=$(cd "$work" && pwd)
EMSDK=${EMSDK:-$work/emsdk}
export EMSDK EM_CONFIG="$EMSDK/.emscripten" EM_CACHE="$work/em-cache"
export PATH="$HOME/.cargo/bin:$EMSDK/upstream/emscripten:$PATH"
emxx="$EMSDK/upstream/emscripten/em++"
cd "$root"
# the engine as a static library; the kernel's objects come in at the link below. cc builds the cxx bridge with em++,
# with the kernel's exception model. A panic aborts, as in the other engine builds. To fit the module's budget, a
# panic's message names no source place (39 KB gzip of file names and line numbers); the build paths are cut to their
# own short names, so the module holds none of this machine's.
sysroot=$(rustc --print sysroot)
remap="--remap-path-prefix=$sysroot/lib/rustlib/src/rust=rust --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}/registry/src=crates --remap-path-prefix=$root=."
start=$(date +%s)
SX_SMLIB_DIR=$(sh packages/brep/scripts/fetch-smlib.sh) SX_BREP_REQUIRE=1 SX_BREP_WASM_OBJECTS=1 RUSTC_BOOTSTRAP=1 \
  CXXFLAGS_wasm32_unknown_emscripten="-Oz -fwasm-exceptions" CFLAGS_wasm32_unknown_emscripten=-Oz \
  CARGO_PROFILE_WASM_RELEASE_PANIC=abort CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_RUSTFLAGS="-Zlocation-detail=none $remap" \
  cargo rustc -q --locked -p sx-geom-wasm --features brep --target wasm32-unknown-emscripten --profile wasm-release \
  --config 'profile.wasm-release.package.zlib-rs.opt-level=3' -Zbuild-std=std,panic_abort --crate-type staticlib
echo "build-exact: engine in $(($(date +%s) - start)) s"
lib="${CARGO_TARGET_DIR:-target}"/wasm32-unknown-emscripten/wasm-release/libsx_geom_wasm.a
exports=$(for f in input file call ops out_ptr out_len out_files out_file_ptr out_file_len error_ptr error_len panic_ptr panic_len; do
  printf '_geom_%s,' "$f"
done)
mkdir -p "$here/pkg"
# An ES module that runs in a browser worker and in Node (tests). The kernel recurses deeply, so it gets an 8 MB stack.
# Link-time optimization makes the code at the link, so the link takes the exception model too: without it a failed
# kernel call throws past its catch and the reply loses its message. binaryen runs its size passes until they find
# nothing more.
start=$(date +%s)
"$emxx" -Oz -flto -fwasm-exceptions -Wl,--start-group "$lib" "$work/libsx_brep.a" "$work/libsmlib.a" -Wl,--end-group \
  -o "$here/pkg/sx_geom_exact.mjs" -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 \
  -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -Wl,-mllvm,-wasm-enable-eh -Wl,-mllvm,-exception-model=wasm \
  -sEXPORTED_FUNCTIONS="${exports%,}" -sEXPORTED_RUNTIME_METHODS=HEAPU8 -sBINARYEN_EXTRA_PASSES=--converge
echo "build-exact: link in $(($(date +%s) - start)) s"
for f in sx_geom_exact.mjs sx_geom_exact.wasm; do
  echo "pkg/$f: $(wc -c < "$here/pkg/$f") bytes, $(gzip -9c "$here/pkg/$f" | wc -c) gzip"
done
