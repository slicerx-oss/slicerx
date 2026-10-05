#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Drains the CI queue one run at a time. The post-receive hook and the nightly job write the queue and start this;
# a second copy that finds the lock held exits at once, and the running one picks up whatever was queued meanwhile.
#
#   $SX_CI_HOME/state/queued-per-merge   "<sha>"  newest push only: a later push overwrites a queued one
#   $SX_CI_HOME/state/queued-nightly     "<sha>"  one nightly run, after any queued per-merge run
#
# A run in progress is never interrupted or run on top of. The lock is a directory (mkdir is atomic everywhere; macOS
# has no flock command) holding the worker's pid, so a lock left by a crashed worker is taken over.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX
CI_HOME=${SX_CI_HOME:-$HOME/ci}
[ -f "$CI_HOME/ci.env" ] && . "$CI_HOME/ci.env"
STATE=$CI_HOME/state; mkdir -p "$STATE"
LOCK=$STATE/worker.lock
RUN=${SX_CI_RUN:-$CI_HOME/bin/run.sh}

take_lock() {
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; return 0; fi
  local pid; pid=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 1; fi
  rm -rf "$LOCK" && mkdir "$LOCK" 2>/dev/null && echo $$ > "$LOCK/pid"
}
take_lock || exit 0
trap 'rm -rf "$LOCK"' EXIT

# Take one queued item atomically: rename it, then read it.
next() {
  local tier f
  for tier in per-merge nightly; do
    f=$STATE/queued-$tier
    if [ -f "$f" ] && mv "$f" "$f.taken" 2>/dev/null; then
      echo "$tier $(cat "$f.taken")"; rm -f "$f.taken"; return 0
    fi
  done
  return 1
}

while item=$(next); do
  set -- $item
  echo "$(date '+%F %T') worker: $1 $2" >> "$STATE/worker.log"
  # One heavy job at a time on this machine: CI runs wait for builds and kit jobs, and the reverse.
  "$CI_HOME/bin/heavy.sh" "$RUN" "$1" "$2" >> "$STATE/worker.log" 2>&1 || true
done
