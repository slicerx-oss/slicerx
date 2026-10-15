#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
script=${1:-$here/scripts/wasm-stamp.sh}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p "$work/wrapper/cpp/tbb" "$work/kernel/source/SMLib/inc" "$work/kernel/source/SM_API/inc"
printf '%s\n' one > "$work/wrapper/cpp/json.h"
printf '%s\n' two > "$work/wrapper/cpp/tbb/parallel_for.h"
printf '%s\n' three > "$work/kernel/source/SMLib/inc/solid.h"
printf '%s\n' four > "$work/kernel/source/SM_API/inc/api.h"
stamp() { sh "$script" "$work/wrapper" "$work/kernel" "${1:--Oz}" "${2:-compiler-1}"; }
base=$(stamp)
[ "$base" = "$(stamp)" ] || { echo 'unchanged inputs did not reuse the stamp' >&2; exit 1; }
for file in wrapper/cpp/json.h wrapper/cpp/tbb/parallel_for.h kernel/source/SMLib/inc/solid.h kernel/source/SM_API/inc/api.h; do
  cp "$work/$file" "$work/original"
  printf '%s\n' changed >> "$work/$file"
  [ "$base" != "$(stamp)" ] || { echo "header did not invalidate: $file" >&2; exit 1; }
  mv "$work/original" "$work/$file"
done
[ "$base" != "$(stamp -O2)" ] || { echo 'flags did not invalidate' >&2; exit 1; }
[ "$base" != "$(stamp -Oz compiler-2)" ] || { echo 'compiler did not invalidate' >&2; exit 1; }
mv "$work/wrapper/cpp/tbb/parallel_for.h" "$work/wrapper/cpp/tbb/renamed.h"
[ "$base" != "$(stamp)" ] || { echo 'header rename did not invalidate' >&2; exit 1; }
echo 'wasm cache inputs passed'
