#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Downloads the SMLib kernel (NVIDIA usd-brep, Apache-2.0) at the pinned commit, checks its SHA-256 and unpacks the
# kernel (source/SMLib), its C API (source/SM_API) and the license into a cache outside the repository, then swaps
# in our versions of the routines swap-routines.sh names. Prints the directory, which the native build (build.rs) and
# scripts/build-wasm.sh read from SX_SMLIB_DIR. The marker's number goes up with each change to swap-routines.sh.
# Each run checks that the copy it prints has every inventoried routine swapped out.
set -eu
commit=c9c5979f04cea8c38213004d4f04df0dcfb40d05
sha256=211feb33612aac2641151bbb47d904488e547bcbcff814095a8676f9d3f85182
cache="${SX_SMLIB_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/slicerx/smlib}"
# On Windows the cache may be named the Windows way (C:\...). tar reads a colon in a name as another machine and
# sha256sum marks the line of a name with a backslash, so the path is put in the shell's own form first.
if command -v cygpath > /dev/null; then cache=$(cygpath -u "$cache"); fi
dir="$cache/$commit"
ready="$dir/.ready-4"
if [ -f "$ready" ]; then
  sh "$(dirname "$0")/swap-routines.sh" --check "$dir"
  echo "$dir"
  exit 0
fi
mkdir -p "$cache"
tmp="$cache/$commit.tar.gz.part"
curl -fsSL -o "$tmp" "https://github.com/NVIDIA-Omniverse/usd-brep/archive/$commit.tar.gz"
# Hashed from standard input, so the answer never depends on how the file is named.
if command -v sha256sum > /dev/null; then got=$(sha256sum < "$tmp" | cut -d' ' -f1); else got=$(shasum -a 256 < "$tmp" | cut -d' ' -f1); fi
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
sh "$(dirname "$0")/swap-routines.sh" "$dir"
sh "$(dirname "$0")/swap-routines.sh" --check "$dir"
touch "$ready"
echo "$dir"
