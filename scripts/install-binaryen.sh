#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Downloads binaryen at the version the engine's WASM module is sized with, checks the archive's
# SHA-256 and unpacks it into <dir>. Prints the directory that holds wasm-opt, for PATH:
#
#   sh scripts/install-binaryen.sh "$RUNNER_TEMP/binaryen" >> "$GITHUB_PATH"
set -eu
version=133
dir=${1:?usage: install-binaryen.sh <dir>}
command -v cygpath >/dev/null && dir=$(cygpath -u "$dir")
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset=x86_64-linux sum=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489 ;;
  Linux-aarch64) asset=aarch64-linux sum=89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8 ;;
  Darwin-arm64) asset=arm64-macos sum=ad66da82ac13f163e424b1643f16c6dfcccc98b5966296b43e52d3cab04f84a8 ;;
  Darwin-x86_64) asset=x86_64-macos sum=13a9b90be775c6389ce3d1f879cb8627bea56708ba8c122983941d53a8199b95 ;;
  MINGW*-x86_64 | MSYS*-x86_64) asset=x86_64-windows sum=17a2cbeac6b5693c5fbafab3838d3c65fd9c1eb38b05f5baec6c657e8c84995b ;;
  *)
    echo "install-binaryen: no binaryen $version build for $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac
file=binaryen-version_$version-$asset.tar.gz
mkdir -p "$dir"
curl -fsSL -o "$dir/$file" "https://github.com/WebAssembly/binaryen/releases/download/version_$version/$file"
got=$( (sha256sum "$dir/$file" 2>/dev/null || shasum -a 256 "$dir/$file") | cut -d ' ' -f 1)
if [ "$got" != "$sum" ]; then
  echo "install-binaryen: $file has SHA-256 $got, expected $sum" >&2
  exit 1
fi
tar xzf "$dir/$file" -C "$dir"
rm "$dir/$file"
bin="$dir/binaryen-version_$version/bin"
if command -v cygpath >/dev/null; then cygpath -w "$bin"; else (cd "$bin" && pwd); fi
