#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Builds libslicerx (the C ABI) and compiles farm_slice.c against its header and static library.
# Usage: examples/farm/c/build.sh   (writes target/release/farm_slice and prints its path)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
cd "$root"
cargo build -q --release -p sx-ffi
out="$root/target/release"
inc="$root/packages/core/ffi/include"
# Linux needs the system libraries named; macOS links them by default.
cc -std=c11 -Wall -Wextra -O2 -I "$inc" "$here/farm_slice.c" "$out/libslicerx.a" -lm -lpthread -ldl \
  -o "$out/farm_slice" 2>/dev/null \
  || cc -std=c11 -Wall -Wextra -O2 -I "$inc" "$here/farm_slice.c" "$out/libslicerx.a" -o "$out/farm_slice"
echo "$out/farm_slice"
