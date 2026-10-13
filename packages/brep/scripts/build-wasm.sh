#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Builds lib/sx_brep.mjs and lib/sx_brep.wasm: the SMLib kernel (fetched by fetch-smlib.sh at its pinned commit) and
# our wrapper (cpp/), with Emscripten 6.0.10. The app's geometry worker loads them the first time a call needs exact
# solids (packages/app/src/geom/brep.ts). Takes a work directory (about 1.5 GB with Emscripten).
#   sh packages/brep/scripts/build-wasm.sh <work-dir>
# Needs git, python3 and curl. Prints the size and SHA-256 of both outputs at the end; they go in README.md.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=${1:?usage: build-wasm.sh <work-dir>}
EMSDK_URL=https://github.com/emscripten-core/emsdk.git
EMSDK_VERSION=6.0.10
jobs=${JOBS:-$(nproc 2> /dev/null || sysctl -n hw.ncpu)}

kernel=$(sh "$here/scripts/fetch-smlib.sh")
mkdir -p "$work"
work=$(cd "$work" && pwd)
[ -d "$work/emsdk" ] || git clone -q --depth 1 "$EMSDK_URL" "$work/emsdk"
(cd "$work/emsdk" && ./emsdk install "$EMSDK_VERSION" > /dev/null && ./emsdk activate "$EMSDK_VERSION" > /dev/null)
emxx="$work/emsdk/upstream/emscripten/em++"
export EM_CONFIG="$work/emsdk/.emscripten"

# the paths of the sources stay out of the output, so a build elsewhere gives the same bytes
flags="-Oz -flto -std=c++17 -w -fwasm-exceptions -DNDEBUG -DNOMINMAX -DSM_NO_DEBUG_CODE -DSM_NO_GFX_OUTPUT_CODE \
  -ffile-prefix-map=$kernel=smlib -ffile-prefix-map=$here=brep -I$here/cpp"
obj="$work/obj"
mkdir -p "$obj/smlib" "$obj/smapi"
# the kernel and its C API each have a StdAfx.h that must come first on the include path; integrator.cpp stands in
# for the SmIntegrator.cpp swap-routines.sh removed
list="$work/sources"
{
  for f in "$kernel"/source/SMLib/src/*.cpp "$here/cpp/routines.cpp" "$here/cpp/integrator.cpp"; do
    b=$(basename "$f" .cpp)
    [ "$b" = StdAfx ] || echo "$f $obj/smlib/$b.o $kernel/source/SMLib/inc $kernel/source/SM_API/inc"
  done
  for f in "$kernel"/source/SM_API/src/*.cpp "$here/cpp/sx_brep.cpp"; do
    b=$(basename "$f" .cpp)
    [ "$b" = StdAfx ] || echo "$f $obj/smapi/$b.o $kernel/source/SM_API/inc $kernel/source/SMLib/inc"
  done
} > "$list"
# an object is kept only while its source, our headers and the flags are the ones it was built from (a stamp of
# their hashes beside it); file times are no guide when a tree is copied in
if command -v sha256sum > /dev/null; then sum=sha256sum; else sum="shasum -a 256"; fi
export SX_SUM="$sum"
SX_COMMON=$( (cat "$here"/cpp/*.h; echo "$flags") | $sum | cut -c1-64)
export SX_COMMON
xargs -P "$jobs" -L 1 sh -c 'f=$1 o=$2; s=$( (cat "$f"; echo "$SX_COMMON") | $SX_SUM | cut -c1-64)
  [ -f "$o" ] && [ "$(cat "$o.stamp" 2> /dev/null)" = "$s" ] && exit 0
  '"$emxx $flags"' -I"$3" -I"$4" -c "$f" -o "$o" && echo "$s" > "$o.stamp"' sh < "$list"

# Link-time optimization makes the code at the link, so the link takes the exception model too: without it a
# failed call throws past its catch and the reply loses its message.
# An ES module that runs in a browser worker and in Node (tests). The kernel recurses deeply, so it gets an 8 MB stack.
mkdir -p "$here/lib"
# only this build's objects, so one left from an earlier kernel copy is not linked in
"$emxx" $flags $(awk '$2 ~ /\/obj\/smapi\// {print $2}' "$list") $(awk '$2 ~ /\/obj\/smlib\// {print $2}' "$list") -o "$here/lib/sx_brep.mjs" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=8MB -Wl,-mllvm,-wasm-enable-eh -Wl,-mllvm,-exception-model=wasm -sEXPORTED_FUNCTIONS=_sx_brep_call,_sx_brep_free,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToNewUTF8
cd "$here/lib"
for f in sx_brep.mjs sx_brep.wasm; do
  echo "$f: $(wc -c < "$f") bytes, $(gzip -9c "$f" | wc -c) gzip"
done
if command -v sha256sum > /dev/null; then sha256sum sx_brep.mjs sx_brep.wasm; else shasum -a 256 sx_brep.mjs sx_brep.wasm; fi
