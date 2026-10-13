#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Downloads the SMLib kernel (NVIDIA usd-brep, Apache-2.0) at the pinned commit, checks its SHA-256 and unpacks the
# kernel (source/SMLib), its C API (source/SM_API) and the license into a cache outside the repository. Prints the
# directory, which the native build (build.rs) and scripts/build-wasm.sh read from SX_SMLIB_DIR.
set -eu
commit=c9c5979f04cea8c38213004d4f04df0dcfb40d05
sha256=211feb33612aac2641151bbb47d904488e547bcbcff814095a8676f9d3f85182
cache="${SX_SMLIB_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/slicerx/smlib}"
dir="$cache/$commit"
if [ -f "$dir/.complete" ]; then
  echo "$dir"
  exit 0
fi
mkdir -p "$cache"
tmp="$cache/$commit.tar.gz.part"
curl -fsSL -o "$tmp" "https://github.com/NVIDIA-Omniverse/usd-brep/archive/$commit.tar.gz"
if command -v sha256sum > /dev/null; then got=$(sha256sum "$tmp" | cut -d' ' -f1); else got=$(shasum -a 256 "$tmp" | cut -d' ' -f1); fi
if [ "$got" != "$sha256" ]; then
  rm -f "$tmp"
  echo "fetch-smlib: checksum mismatch: expected $sha256, got $got" >&2
  exit 1
fi
rm -rf "$dir"
mkdir -p "$dir"
tar -xzf "$tmp" -C "$dir" --strip-components=1 \
  "usd-brep-$commit/source/SMLib" "usd-brep-$commit/source/SM_API" "usd-brep-$commit/LICENSE"
rm -f "$tmp"
touch "$dir/.complete"
echo "$dir"
