#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# The desktop releases' step for the full engine with exact solids (pkg/sx_geom_exact.mjs and .wasm): builds it with
# build-exact.sh from the release's own commit and fails unless both files are there. The app's geometry worker loads
# them by URL, so a page build without them still passes and only the app fails when exact solids load; this step is
# what stops such a release.
#   sh packages/geom/wasm/scripts/release-exact.sh [--work <dir>] [--archive <tar> --into <dir>]
# --work      the kernel's objects, the link's output and the engine's cargo target, kept and reused between
#             releases (default $SX_EXACT_WORK, else ~/.cache/slicerx/exact-release)
# --archive   a tar of the release's commit (git archive), unpacked fresh into <work>/src and built there. For a
#             checkout this system cannot build in, such as a Windows one built through WSL (windows-sign.ps1).
#             Without it, the checkout this script is in is built.
# --into      also copies the two files into this folder (the other checkout's packages/geom/wasm/pkg)
# Emscripten 6.0.10 comes from EMSDK, else from ~/builds/emsdk-6.0.10, and its em++ must report that version.
# Nothing is downloaded for it here: a release never installs a compiler on its own (build-exact.sh would put one in
# the work directory when EMSDK is unset).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=${SX_EXACT_WORK:-$HOME/.cache/slicerx/exact-release}
archive=
into=
while [ $# -gt 0 ]; do
  case $1 in
    --work) work=${2:?--work needs a folder}; shift 2 ;;
    --archive) archive=${2:?--archive needs a tar}; shift 2 ;;
    --into) into=${2:?--into needs a folder}; shift 2 ;;
    *) echo "release-exact: unknown argument $1" >&2; exit 2 ;;
  esac
done
version=6.0.10
fail() { echo "release-exact: $*" >&2; exit 1; }
# EMSDK when it is set, else ~/builds/emsdk-$version (the SDK itself, or the emsdk folder inside it), so a release
# started with a bare environment (launchd, wsl.exe -e) finds it too
if [ -z "${EMSDK:-}" ]; then
  looked=
  for d in "$HOME/builds/emsdk-$version/emsdk" "$HOME/builds/emsdk-$version"; do
    looked="$looked $d"
    if [ -x "$d/upstream/emscripten/em++" ]; then EMSDK=$d; break; fi
  done
  [ -n "${EMSDK:-}" ] || fail "no Emscripten $version: EMSDK is unset and none is in$looked. Set EMSDK to an installed one (emsdk install $version && emsdk activate $version); nothing is downloaded here"
fi
emxx="$EMSDK/upstream/emscripten/em++"
[ -x "$emxx" ] || fail "EMSDK=$EMSDK has no upstream/emscripten/em++"
got=$(EM_CONFIG="$EMSDK/.emscripten" "$emxx" --version 2>&1 | head -n 1) || true
case $got in
  *" $version "*) ;;
  *) fail "EMSDK=$EMSDK is not Emscripten $version: em++ --version says: $got" ;;
esac
echo "release-exact: Emscripten $version from $EMSDK"
export EMSDK
mkdir -p "$work"
work=$(cd "$work" && pwd)
root=$(cd "$here/../../.." && pwd)
if [ -n "$archive" ]; then
  [ -f "$archive" ] || fail "no archive at $archive"
  root="$work/src"
  rm -rf "$root"
  mkdir -p "$root"
  tar -xf "$archive" -C "$root"
fi
# the engine's cargo output stays in the work directory too, so the next release builds only what changed
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$work/target}"
sh "$root/packages/geom/wasm/scripts/build-exact.sh" "$work/kernel"
pkg="$root/packages/geom/wasm/pkg"
# A wasm file starts with \0asm; a glue file names the wasm it loads.
check() {
  [ -s "$1/sx_geom_exact.mjs" ] && [ -s "$1/sx_geom_exact.wasm" ] || fail "$1 lacks sx_geom_exact.mjs or sx_geom_exact.wasm"
  [ "$(head -c 4 "$1/sx_geom_exact.wasm" | od -An -c | tr -d ' ')" = '\0asm' ] || fail "$1/sx_geom_exact.wasm is not a wasm module"
  grep -q sx_geom_exact.wasm "$1/sx_geom_exact.mjs" || fail "$1/sx_geom_exact.mjs does not load sx_geom_exact.wasm"
}
check "$pkg"
if [ -n "$into" ]; then
  mkdir -p "$into"
  cp "$pkg/sx_geom_exact.mjs" "$pkg/sx_geom_exact.wasm" "$into/"
  cmp -s "$pkg/sx_geom_exact.wasm" "$into/sx_geom_exact.wasm" && cmp -s "$pkg/sx_geom_exact.mjs" "$into/sx_geom_exact.mjs" ||
    fail "the copies in $into differ from the build"
  check "$into"
  pkg=$into
fi
for f in sx_geom_exact.mjs sx_geom_exact.wasm; do echo "release-exact: $pkg/$f $(wc -c < "$pkg/$f" | tr -d ' ') bytes"; done
