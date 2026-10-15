#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# common inputs for every object; source contents are added by the caller
set -eu
here=${1:?wrapper directory}
kernel=${2:?kernel directory}
flags=${3:?compiler flags}
compiler=${4:?compiler identity}
for dir in "$here/cpp" "$kernel/source/SMLib/inc" "$kernel/source/SM_API/inc"; do
  [ -d "$dir" ] || { echo "missing header directory: $dir" >&2; exit 1; }
done
if command -v sha256sum > /dev/null; then sum=sha256sum; else sum='shasum -a 256'; fi
headers() {
  (cd "$1" && find . -type f ! -name '*.cpp' -print | LC_ALL=C sort | while IFS= read -r file; do
    printf '%s\n' "$file"
    $sum < "$file"
  done)
}
{
  printf '%s\n' "$flags" "$compiler" wrapper
  headers "$here/cpp"
  printf '%s\n' smlib
  headers "$kernel/source/SMLib/inc"
  printf '%s\n' smapi
  headers "$kernel/source/SM_API/inc"
} | $sum | cut -c1-64
