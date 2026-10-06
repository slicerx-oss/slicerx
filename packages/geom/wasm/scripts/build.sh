#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Builds sx-geom-wasm twice and copies both to pkg/ (generated, git-ignored): sx_geom_wasm.wasm, the full engine
# with every optional part unless SX_GEOM_FEATURES lists the ones to keep, and sx_geom_core.wasm, the small core the
# app's worker loads first (packages/app/src/geom/modules.ts). The core leaves out the modeling tools and the heavier
# modules (SX_GEOM_CORE_FEATURES, default below); with SX_GEOM_FEATURES set, both names get the one build.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
cd "$root"
mkdir -p "$here/pkg"
out="${CARGO_TARGET_DIR:-target}"/wasm32-unknown-unknown/wasm-release/sx_geom_wasm.wasm
build() {
  # Without the name section: about 330 KB smaller, nothing else changes.
  CARGO_PROFILE_WASM_RELEASE_STRIP=symbols cargo build -q -p sx-geom-wasm --target wasm32-unknown-unknown --profile wasm-release "$@"
}
report() {
  echo "pkg/$1: $(wc -c < "$here/pkg/$1") bytes, $(gzip -9c "$here/pkg/$1" | wc -c) gzip"
}
# SX_GEOM_FEATURES picks the engine's optional parts (a comma list, empty for none: see packages/geom/Cargo.toml);
# unset builds them all.
if [ "${SX_GEOM_FEATURES+set}" = set ]; then
  build --no-default-features --features "$SX_GEOM_FEATURES"
  cp "$out" "$here/pkg/sx_geom_wasm.wasm"
  cp "$out" "$here/pkg/sx_geom_core.wasm"
else
  build --no-default-features --features "${SX_GEOM_CORE_FEATURES-text,svg,nest,calib,hollow}"
  cp "$out" "$here/pkg/sx_geom_core.wasm"
  build
  cp "$out" "$here/pkg/sx_geom_wasm.wasm"
fi
report sx_geom_core.wasm
report sx_geom_wasm.wasm
