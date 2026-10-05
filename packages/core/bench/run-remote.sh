#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Syncs the Rust sources to the reference machine, builds sx with the
# bench-release profile there and runs a command in the synced tree.
#
#   SX_BENCH_HOST=<ssh host> packages/core/bench/run-remote.sh build
#   SX_BENCH_HOST=<ssh host> packages/core/bench/run-remote.sh bench [sx bench args]
#   SX_BENCH_HOST=<ssh host> packages/core/bench/run-remote.sh snapshot <name>
#       copies the built sx to ../slicerx-bench-bin/sx-<name> on the remote (A/B baselines)
#   SX_BENCH_HOST=<ssh host> packages/core/bench/run-remote.sh ab <baseline name> [--threads N]
#       interleaved A/B of that snapshot against the current build
set -eu
host=${SX_BENCH_HOST:?set SX_BENCH_HOST to the ssh host of the reference machine}
dir=${SX_BENCH_DIR:-slicerx-bench}
root=$(cd "$(dirname "$0")/../../.." && pwd)
cmd=${1:-bench}
[ $# -gt 0 ] && shift

rsync -a --delete \
  --exclude target/ --exclude node_modules/ --exclude .git/ \
  --exclude examples/ --exclude docs/ --exclude supabase/ --exclude .tools-venv/ --exclude .locks/ \
  --exclude packages/core/bench/out/ --exclude 'packages/core/bench/results.jsonl' \
  "$root/" "$host:$dir/"

remote() {
  ssh "$host" "export PATH=\"\$HOME/.cargo/bin:/opt/homebrew/bin:\$PATH\"; cd $dir && $*"
}

remote cargo build -q -p sx-cli --profile bench-release
case "$cmd" in
  build) ;;
  bench) remote ./target/bench-release/sx bench --config packages/core/bench/configs/reference-0.20.json "$@" ;;
  snapshot) remote "mkdir -p ../slicerx-bench-bin && cp target/bench-release/sx ../slicerx-bench-bin/sx-$1" ;;
  ab) base=$1; shift; remote ./target/bench-release/sx bench --config packages/core/bench/configs/reference-0.20.json --ab "../slicerx-bench-bin/sx-$base" "$@" ;;
  *) echo "unknown command $cmd" >&2; exit 2 ;;
esac
