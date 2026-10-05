#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Runs a command while holding this machine's heavy-work lock, so a CI run never shares the CPU with a release build,
# a kit build or another CI run, and timing tests do not flake under load. Machine-wide, not per repo:
#
#   scripts/ci/heavy.sh <command...>          waits for the lock, runs, releases
#   SX_HEAVY_LOCK=<dir>                        the lock (default ~/.slicerx-heavy.lock)
#   SX_HEAVY_WAIT=<seconds>                    give up after this long (default 0: wait as long as it takes)
#
# The lock is a directory holding the holder's pid and command (mkdir is atomic; macOS has no flock command). A lock
# whose holder has died is taken over, so a crashed job never wedges the machine.
set -uo pipefail
lock=${SX_HEAVY_LOCK:-$HOME/.slicerx-heavy.lock}
max=${SX_HEAVY_WAIT:-0}
[ $# -gt 0 ] || { echo "usage: heavy.sh <command...>" >&2; exit 2; }

waited=0
while ! mkdir "$lock" 2>/dev/null; do
  pid=$(sed -n 's/^pid \([0-9]*\).*/\1/p' "$lock/owner" 2>/dev/null)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    echo "heavy.sh: taking over a lock left by pid $pid" >&2
    rm -rf "$lock"; continue
  fi
  [ $((waited % 300)) -eq 0 ] && echo "heavy.sh: waiting for $lock ($(cat "$lock/owner" 2>/dev/null || echo 'holder starting'))" >&2
  if [ "$max" -gt 0 ] && [ "$waited" -ge "$max" ]; then echo "heavy.sh: gave up after $max s" >&2; exit 75; fi
  sleep 5; waited=$((waited + 5))
done
echo "pid $$ since $(date '+%F %T'): $*" > "$lock/owner"
trap 'rm -rf "$lock"' EXIT INT TERM
"$@"
