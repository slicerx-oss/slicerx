#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Puts the ONNX Runtime build that sx-watch links (ort-sys with download-binaries) into ort-sys's own cache before
# cargo runs, so a CDN blip during the build can't fail a job:
#
#   scripts/ci/ort-prefetch.sh [<target triple>...]        fetch for these targets (default: rustc's host)
#   scripts/ci/ort-prefetch.sh --key [<target triple>...]  print key=<cache key> for $GITHUB_OUTPUT, fetch nothing
#
# ort-sys downloads the archive in its build script with one request and no retry, and a failed download or
# extraction fails the build. A folder <cache>/dfbin/<target>/<sha256> that already exists is used as it is, with no
# download (ort-sys build/main.rs), so this script fills that folder first: it downloads with retries, checks the
# archive against the sha256 ort-sys pins for it (build/download/dist.tsv in the crate, copied below), extracts it
# next to the folder and renames it into place, as ort-sys does. <cache> is ORT_CACHE_DIR when set, or ort-sys's
# default: $XDG_CACHE_HOME or ~/.cache/ort.pyke.io on Linux, ~/Library/Caches/ort.pyke.io on macOS and
# %LOCALAPPDATA%\ort.pyke.io on Windows (src/internal/dirs.rs in the crate).
#
# With SX_ORT_ARCHIVES set, a checked archive is kept in that folder and used again without a download (the workflow
# caches the folder). An archive there that fails the check is deleted and downloaded again.
#
# It never fails the job. On any problem it prints a warning and exits 0, and ort-sys downloads as it always has.
# When ort-sys in Cargo.lock is not the version pinned here, it does nothing: update the table from the new crate's
# dist.tsv.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

key=0
[ "${1:-}" = --key ] && { key=1; shift; }

pinned=2.0.0-rc.13
base=https://cdn.pyke.io/0/pyke:ort-rs/ms@1.28.0
# <target> <archive> <sha256>, the rows ort-sys picks with sx-watch's features (no execution provider asked for, so
# the first row for the target, or its plain one).
dist() {
  case $1 in
    x86_64-unknown-linux-gnu) echo "x86_64-unknown-linux-gnu.tar.lzma2 e454f710f8a49f53aa5b4ff51e3454ae1835777e431c6c35c5255ce6f205fd68" ;;
    aarch64-unknown-linux-gnu) echo "aarch64-unknown-linux-gnu.tar.lzma2 06a050ab9137ccb32421d0cb49e9ccf72d9e18ab0aeb8f8d038d1b5cc844b35a" ;;
    x86_64-pc-windows-msvc) echo "x86_64-pc-windows-msvc+directml.tar.lzma2 f7c654b3729cb9e5ad2a36a0c38e5b48e63bf4eed22968931aed33a0ad0b527d" ;;
    aarch64-apple-darwin) echo "aarch64-apple-darwin+coreml.tar.lzma2 6934874e2e953576d9c1db47ff1af39c62c4f4220dbe6f988e131f72879674c7" ;;
    *) return 1 ;;
  esac
}

note() { echo "ort-prefetch: $*" >&2; }
# --key's output goes to $GITHUB_OUTPUT, so there a warning is a plain note
warn() { if [ "$key" = 1 ]; then note "$*"; else echo "::warning title=ONNX Runtime prefetch::$*"; fi; }
# Git's bash on Windows: work on the unix form of a Windows path
unixpath() { if command -v cygpath > /dev/null 2>&1; then cygpath -u "$1"; else printf '%s\n' "$1"; fi; }


locked=$(awk '$0 == "name = \"ort-sys\"" { f = 1; next } f && /^version = / { gsub(/"/, "", $3); print $3; exit }' "$repo/Cargo.lock" 2> /dev/null)
if [ -z "$locked" ]; then note "no ort-sys in Cargo.lock, nothing to fetch"; exit 0; fi
if [ "$locked" != "$pinned" ]; then
  warn "Cargo.lock has ort-sys $locked but scripts/ci/ort-prefetch.sh pins $pinned, so ort-sys downloads on its own. Copy the new rows from its build/download/dist.tsv."
  exit 0
fi

targets=("$@")
if [ "${#targets[@]}" -eq 0 ]; then
  host=$(rustc -vV 2> /dev/null | sed -n 's/^host: //p' | tr -d '\r')
  [ -n "$host" ] || { warn "no rustc to name the host target; ort-sys downloads on its own"; exit 0; }
  targets=("$host")
fi

if [ "$key" = 1 ]; then
  k="ort-sys-$pinned"
  for t in "${targets[@]}"; do
    row=$(dist "$t") || continue
    s=${row##* }
    k="$k-$t-${s:0:12}"
  done
  [ "$k" = "ort-sys-$pinned" ] || echo "key=$k"
  exit 0
fi

if [ -n "${ORT_CACHE_DIR:-}" ]; then cache=$(unixpath "$ORT_CACHE_DIR")
else
  case $(uname -s) in
    Linux) case ${XDG_CACHE_HOME:-} in /*) cache=$XDG_CACHE_HOME ;; *) cache=$HOME/.cache/ort.pyke.io ;; esac ;;
    Darwin) cache=$HOME/Library/Caches/ort.pyke.io ;;
    MINGW* | MSYS* | CYGWIN*) [ -n "${LOCALAPPDATA:-}" ] && cache=$(unixpath "$LOCALAPPDATA")/ort.pyke.io ;;
  esac
fi
[ -n "${cache:-}" ] || { warn "no cache folder for $(uname -s); ort-sys downloads on its own"; exit 0; }

if command -v sha256sum > /dev/null 2>&1; then sha() { sha256sum "$1" | cut -d' ' -f1; }
else sha() { shasum -a 256 "$1" | cut -d' ' -f1; }; fi

tries=${SX_ORT_TRIES:-4}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archives=$work
if [ -n "${SX_ORT_ARCHIVES:-}" ]; then archives=$(unixpath "$SX_ORT_ARCHIVES"); mkdir -p "$archives" || archives=$work; fi

# A downloaded archive, checked: tries times, waiting SX_ORT_RETRY_DELAY seconds (default 10), then three times as long.
fetch() {
  local url=$1 out=$2 want=$3 i=1 delay=${SX_ORT_RETRY_DELAY:-10} got
  while :; do
    if curl -fsSL --connect-timeout 20 --max-time 600 -o "$out.part" "$url"; then
      got=$(sha "$out.part")
      if [ "$got" = "$want" ]; then mv -f "$out.part" "$out"; return 0; fi
      note "the download's sha256 is $got, not $want"
    fi
    rm -f "$out.part"
    [ "$i" -lt "$tries" ] || return 1
    note "download try $i of $tries failed, trying again in ${delay}s"
    sleep "$delay"
    delay=$((delay * 3)) i=$((i + 1))
  done
}

# The archive is a tar in a raw LZMA2 stream with a 64 MiB dictionary (ort-sys build/download/extract.rs).
extract() {
  if [ "${SX_ORT_EXTRACT:-}" != python ] && command -v xz > /dev/null 2>&1; then
    xz --format=raw --lzma2=dict=64MiB -dc "$1" | tar -xf - -C "$2"
    return
  fi
  local py
  py=$(command -v python3 || command -v python) || { note "neither xz nor python to extract with"; return 1; }
  "$py" -I -c '
import io, lzma, sys, tarfile
with open(sys.argv[1], "rb") as f:
    data = lzma.LZMADecompressor(lzma.FORMAT_RAW, filters=[{"id": lzma.FILTER_LZMA2, "dict_size": 1 << 26}]).decompress(f.read())
with tarfile.open(fileobj=io.BytesIO(data)) as t:
    if hasattr(tarfile, "data_filter"): t.extractall(sys.argv[2], filter="data")
    else: t.extractall(sys.argv[2])
' "$1" "$(unixpath "$2")"
}

# The static library ort-sys links, which every one of these archives has at its top level.
has_lib() { find "$1" -maxdepth 1 -type f \( -name libonnxruntime.a -o -name onnxruntime.lib \) -size +0 2> /dev/null | grep -q .; }

for t in "${targets[@]}"; do
  row=$(dist "$t") || { note "no prebuilt ONNX Runtime for $t in ort-sys $pinned, nothing to fetch"; continue; }
  name=${row% *} want=${row##* }
  dest=$cache/dfbin/$t/$want
  if [ -d "$dest" ]; then
    if has_lib "$dest"; then note "$t: already in $dest"; continue; fi
    # ort-sys would use this folder as it is and fail to link, so set it aside and fill it again
    warn "$dest has no ONNX Runtime library; replacing it"
    mv "$dest" "$cache/dfbin/$t/broken.$$_$want" && rm -rf "$cache/dfbin/$t/broken.$$_$want"
  fi
  archive=$archives/$name
  if [ -f "$archive" ] && [ "$(sha "$archive")" = "$want" ]; then note "$t: using the cached archive"
  else
    [ -f "$archive" ] && { note "$t: the cached archive fails its sha256 check, downloading again"; rm -f "$archive"; }
    if ! fetch "$base/$name" "$archive" "$want"; then
      warn "could not download $base/$name after $tries tries; ort-sys downloads on its own"
      continue
    fi
    note "$t: downloaded $name, sha256 checked"
  fi
  mkdir -p "$cache/dfbin/$t" || { warn "could not create $cache/dfbin/$t"; continue; }
  tmp=$cache/dfbin/$t/tmp.sx$$_$want
  rm -rf "$tmp" && mkdir -p "$tmp"
  if ! extract "$archive" "$tmp" || ! has_lib "$tmp"; then
    rm -rf "$tmp"
    warn "could not extract $name; ort-sys downloads on its own"
    continue
  fi
  # another job may have filled it meanwhile; theirs stays
  if [ -e "$dest" ]; then rm -rf "$tmp"; else mv "$tmp" "$dest"; fi
  [ -d "$dest/tmp.sx$$_$want" ] && rm -rf "$dest/tmp.sx$$_$want"
  note "$t: ready in $dest"
done
exit 0
