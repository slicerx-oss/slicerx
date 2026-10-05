#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Builds libslicerx, compiles the C test program against the generated header
# and the static library, and slices the reference plate through it.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
cd "$root"
cargo build -q -p sx-ffi --release
out="$root/target/release"
cc -std=c11 -D_GNU_SOURCE -Wall -Wextra -O2 -I "$here/include" "$here/tests/c/slice_reference.c" \
  "$out/libslicerx.a" -lm -lpthread -ldl -o "$out/slice_reference" 2>/dev/null \
  || cc -std=c11 -D_GNU_SOURCE -Wall -Wextra -O2 -I "$here/include" "$here/tests/c/slice_reference.c" \
    "$out/libslicerx.a" -o "$out/slice_reference"
"$out/slice_reference" "$root/packages/core/bench/models/x-mark.stl" 427 "${1:-/dev/null}"
