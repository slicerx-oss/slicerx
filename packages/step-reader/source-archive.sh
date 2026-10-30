#!/bin/sh
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Makes the source archive each release attaches for the STEP reader (LGPL-2.1 source offer, see
# SOURCE.md): occt-import-js and OpenCASCADE at the commits build.sh pins, the patches, build.sh,
# SOURCE.md and the license texts, without git metadata. Needs git and about 1 GB of room.
#   sh source-archive.sh <work-dir> <out-dir>
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=${1:?usage: source-archive.sh <work-dir> <out-dir>}
out=${2:?usage: source-archive.sh <work-dir> <out-dir>}
pin() { sed -n "s/^$1=\([^ ]*\).*/\1/p" "$here/build.sh"; }
OIJ_URL=$(pin OIJ_URL)
OIJ_COMMIT=$(pin OIJ_COMMIT)
OCCT_URL=$(pin OCCT_URL)
OCCT_COMMIT=$(pin OCCT_COMMIT)
name=occt-import-js-source-0.0.23

mkdir -p "$work" "$out"
out=$(cd "$out" && pwd)
cd "$work"
rm -rf "$name" && mkdir -p "$name/slicerx"
fetch() { # url commit dir
  git init -q "$3"
  git -C "$3" fetch -q --depth 1 "$1" "$2"
  git -C "$3" checkout -q FETCH_HEAD
  rm -rf "$3/.git"
}
fetch "$OIJ_URL" "$OIJ_COMMIT" "$name/occt-import-js"
rm -rf "$name/occt-import-js/occt"
fetch "$OCCT_URL" "$OCCT_COMMIT" "$name/occt-import-js/occt"
cp -R "$here/patches" "$here/build.sh" "$here/source-archive.sh" "$here/SOURCE.md" "$here"/LICENSE-*.txt "$here/OCCT_LGPL_EXCEPTION.txt" "$name/slicerx/"
tar -czf "$out/$name.tar.gz" "$name"
rm -rf "$name"
cd "$out"
shasum -a 256 "$name.tar.gz"
