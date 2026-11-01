#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Fetches the static ONNX Runtime library that the ort-sys build script would download, in its own CI step with
# retries, so a network blip no longer fails the Rust build ("could not find native static library onnxruntime"), and
# a cache hit needs no network at all. The archive is checked against a pinned sha256 every time it is used, on a cache
# hit too, and only then extracted.
#
#   scripts/ci/ort-fetch.sh key             prints the cache key (ort-sys version and archive sha256)
#   scripts/ci/ort-fetch.sh fetch <dir>     leaves the checked archive and the extracted library under <dir>, and sets
#                                           ORT_LIB_LOCATION for the later steps when GITHUB_ENV is set
#
# The version, URL and sha256 below are the x86_64-unknown-linux-gnu entry (no extra features) of
# build/download/dist.tsv in ort-sys 2.0.0-rc.13. With ORT_LIB_LOCATION set the build script links the library in that
# directory and makes no request. When Cargo.lock moves ort-sys to another version, this script fails until the three
# values are read from the new crate's dist.tsv, which keeps the pinned library and the locked crate in step.
set -euo pipefail

ort_sys_version=2.0.0-rc.13
ort_url='https://cdn.pyke.io/0/pyke:ort-rs/ms@1.28.0/x86_64-unknown-linux-gnu.tar.lzma2'
ort_sha256=e454f710f8a49f53aa5b4ff51e3454ae1835777e431c6c35c5255ce6f205fd68

lock=${SX_ORT_CARGO_LOCK:-Cargo.lock}
locked=$(awk '$0 == "name = \"ort-sys\"" { f = 1; next } f && /^version = / { gsub(/"/, "", $3); print $3; exit }' "$lock")
if [ "$locked" != "$ort_sys_version" ]; then
  echo "::error::$lock locks ort-sys ${locked:-nothing}, but scripts/ci/ort-fetch.sh pins the library of $ort_sys_version. Copy the x86_64-unknown-linux-gnu entry without features from build/download/dist.tsv in the new ort-sys into the script." >&2
  exit 1
fi

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

case ${1:-} in
  key)
    echo "ort-$ort_sys_version-$ort_sha256"
    ;;
  fetch)
    dir=${2:?usage: ort-fetch.sh fetch <dir>}
    mkdir -p "$dir"
    archive=$dir/onnxruntime.tar.lzma2
    lib=$dir/lib
    if [ -f "$archive" ] && [ "$(sha_of "$archive")" = "$ort_sha256" ]; then
      echo "using the archive already in $dir (sha256 checked)"
    else
      [ ! -e "$archive" ] || echo "the archive in $dir does not match the pinned sha256, downloading it again"
      rm -rf "$archive" "$lib"
      curl --fail --silent --show-error --location --proto '=https' --retry 5 --retry-all-errors --retry-delay 3 \
        --connect-timeout 30 --max-time 600 --output "$archive.part" "$ort_url"
      got=$(sha_of "$archive.part")
      if [ "$got" != "$ort_sha256" ]; then
        rm -f "$archive.part"
        echo "::error::The ONNX Runtime archive from $ort_url has sha256 $got, but scripts/ci/ort-fetch.sh pins $ort_sha256. Nothing was extracted." >&2
        exit 1
      fi
      mv "$archive.part" "$archive"
      echo "downloaded the archive, sha256 $got"
    fi
    # Extracted again unless an earlier run left the library from this same archive.
    if [ "$(cat "$lib/.sha256" 2>/dev/null || true)" != "$ort_sha256" ]; then
      rm -rf "$lib"
      mkdir -p "$lib"
      # A raw LZMA2 stream (no xz container) holding a tar; ort-sys reads it with a 64 MiB dictionary.
      xz --decompress --stdout --format=raw --lzma2=dict=64MiB < "$archive" | tar -x -C "$lib"
      echo "$ort_sha256" > "$lib/.sha256"
    fi
    [ -f "$lib/libonnxruntime.a" ] || { echo "::error::$lib has no libonnxruntime.a after extraction" >&2; exit 1; }
    echo "ORT_LIB_LOCATION=$lib"
    if [ -n "${GITHUB_ENV:-}" ]; then
      echo "ORT_LIB_LOCATION=$lib" >> "$GITHUB_ENV"
    fi
    ;;
  *)
    echo "usage: ort-fetch.sh key | fetch <dir>" >&2
    exit 2
    ;;
esac
