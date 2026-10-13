#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Runs examples/fuzz_smb.rs under a memory and time cap: the run is killed (by its PID) once it holds more than
# SX_FUZZ_MB of memory or runs past SX_FUZZ_SECONDS. A crash or a kill keeps the case that caused it.
# usage: fuzz-smb.sh <cases> <seed> <out dir>
set -u
cases=${1:-2000}
seed=${2:-1}
out=${3:-fuzz-smb}
cap_mb=${SX_FUZZ_MB:-2048}
limit=${SX_FUZZ_SECONDS:-1800}
mkdir -p "$out"
cargo build -p sx-brep --release --example fuzz_smb || exit 1
bin=${CARGO_TARGET_DIR:-target}/release/examples/fuzz_smb
"$bin" "$cases" "$seed" "$out/case.smb" > "$out/result.txt" 2> "$out/progress.txt" &
pid=$!
start=$(date +%s)
why=""
while kill -0 "$pid" 2>/dev/null; do
  rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$rss" ] && [ "$rss" -gt $((cap_mb * 1024)) ]; then why="memory over ${cap_mb} MB"; kill -9 "$pid"; break; fi
  if [ $(( $(date +%s) - start )) -gt "$limit" ]; then why="over ${limit} s"; kill -9 "$pid"; break; fi
  sleep 1
done
wait "$pid"
rc=$?
if [ -n "$why" ] || [ "$rc" -ne 0 ]; then
  cp "$out/case.smb" "$out/crash-seed$seed.smb"
  echo "seed $seed: stopped ($why, exit $rc); the case is $out/crash-seed$seed.smb" | tee -a "$out/result.txt"
  exit 1
fi
cat "$out/result.txt"
