#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Runs a command while holding the repo's install lock, so parallel jobs never
# write pnpm-lock.yaml, Cargo.lock or node_modules at the same time.
# Usage: scripts/with-lock.sh pnpm install
#        scripts/with-lock.sh cargo fetch
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
lock="$root/.locks/install"
mkdir -p "$root/.locks"
waited=0
until mkdir "$lock" 2>/dev/null; do
  if [ "$waited" -ge 900 ]; then
    echo "with-lock: waited 15 min for $lock (held by: $(cat "$lock/owner" 2>/dev/null || echo unknown)). Check that holder and remove the lock dir once it has stopped." >&2
    exit 1
  fi
  [ "$waited" -eq 0 ] && echo "with-lock: waiting for $lock" >&2
  sleep 2
  waited=$((waited + 2))
done
echo "pid $$, $(date -u +%Y-%m-%dT%H:%M:%SZ), $*" > "$lock/owner"
trap 'rm -rf "$lock"' EXIT INT TERM
cd "$root"
"$@"
