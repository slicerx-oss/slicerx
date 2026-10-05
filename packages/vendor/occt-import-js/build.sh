#!/bin/sh
# SPDX-License-Identifier: MIT OR Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Builds lib/occt-import-js.mjs and lib/occt-import-js.wasm from source: occt-import-js and
# OpenCASCADE at the pinned commits below, the patches in patches/, Emscripten 3.1.69 (the version
# upstream builds with). Takes a work directory with room for about 3 GB.
#   sh build.sh <work-dir>
# Needs git, cmake, make and python3. Writes the SHA-256 of both outputs at the end; they go in
# SOURCE.md.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=${1:?usage: build.sh <work-dir>}
OIJ_URL=https://github.com/kovacsv/occt-import-js.git
OIJ_COMMIT=c2148e54b456b571238d35cac037d304053d64b2 # tag 0.0.23
OCCT_URL=https://github.com/Open-Cascade-SAS/OCCT.git
OCCT_COMMIT=d2abb6d844231cb8f29be6894440874a4700e4a5 # OCCT 7.6.1, the submodule of 0.0.23
EMSDK_URL=https://github.com/emscripten-core/emsdk.git
EMSDK_VERSION=3.1.69
jobs=${JOBS:-4}

mkdir -p "$work"
cd "$work"
[ -d emsdk ] || git clone -q --depth 1 "$EMSDK_URL" emsdk
(cd emsdk && ./emsdk install "$EMSDK_VERSION" >/dev/null && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
# shellcheck disable=SC1091
. ./emsdk/emsdk_env.sh >/dev/null 2>&1

if [ ! -d src ]; then
  git clone -q "$OIJ_URL" src
fi
cd src
git checkout -q -f "$OIJ_COMMIT"
git clean -q -fdx -e occt -e build
git config submodule.occt.url "$OCCT_URL"
git submodule update -q --init occt
(cd occt && git checkout -q -f "$OCCT_COMMIT")
for p in "$here"/patches/*.patch; do git apply "$p"; done

# An ES module that runs in a browser worker and in Node (tests).
emcmake cmake -B build/wasm -G "Unix Makefiles" -DEMSCRIPTEN=1 -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  "-DCMAKE_EXE_LINKER_FLAGS=-sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sMAXIMUM_MEMORY=4GB" . >/dev/null
emmake make -s -j"$jobs" -C build/wasm >/dev/null

mkdir -p "$here/lib"
cp build/wasm/Release/occt-import-js.js "$here/lib/occt-import-js.mjs"
cp build/wasm/Release/occt-import-js.wasm "$here/lib/occt-import-js.wasm"
cd "$here/lib"
shasum -a 256 occt-import-js.mjs occt-import-js.wasm
