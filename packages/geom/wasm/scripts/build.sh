#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Builds sx-geom-wasm and copies it to pkg/ (generated, git-ignored), with every optional part unless
# SX_GEOM_FEATURES lists the ones to keep.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
cd "$root"
# SX_GEOM_FEATURES picks the engine's optional parts (a comma list, empty for none: see packages/geom/Cargo.toml);
# unset builds them all.
if [ "${SX_GEOM_FEATURES+set}" = set ]; then
  set -- --no-default-features --features "$SX_GEOM_FEATURES"
else
  set --
fi
# Without the name section: about 330 KB smaller, nothing else changes.
CARGO_PROFILE_WASM_RELEASE_STRIP=symbols cargo build -q -p sx-geom-wasm --target wasm32-unknown-unknown --profile wasm-release "$@"
mkdir -p "$here/pkg"
cp "${CARGO_TARGET_DIR:-target}"/wasm32-unknown-unknown/wasm-release/sx_geom_wasm.wasm "$here/pkg/sx_geom_wasm.wasm"
echo "pkg/sx_geom_wasm.wasm: $(wc -c < "$here/pkg/sx_geom_wasm.wasm") bytes, $(gzip -9c "$here/pkg/sx_geom_wasm.wasm" | wc -c) gzip"
