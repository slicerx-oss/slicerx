#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Queues the nightly run of the CI branch's tip and starts the worker. Run it at 02:00 local from the scheduler
# (scripts/ci/launchd.plist.example on macOS); with SX_CI_REMOTES set it starts the remote runners' nightly too.
CI_HOME=${SX_CI_HOME:-$HOME/ci}
[ -f "$CI_HOME/ci.env" ] && . "$CI_HOME/ci.env"
BRANCH=${SX_CI_BRANCH:-refs/heads/main}
STATE=$CI_HOME/state; mkdir -p "$STATE"
REPO=${SX_CI_REPO:-$CI_HOME/slicerx.git}
# The nightly tests the newest main: when the CI repo mirrors the public one (it has an origin), bring it up to date
# first. A failed fetch tests the last main fetched, and says so.
if git -C "$REPO" remote get-url origin > /dev/null 2>&1; then
  git -C "$REPO" fetch -q origin 2>> "$STATE/nightly.log" || echo "nightly: fetch failed, testing the last $BRANCH fetched" >&2
fi
sha=$(git -C "$REPO" rev-parse --verify -q "$BRANCH") || { echo "nightly: no $BRANCH" >&2; exit 1; }
echo "$sha" > "$STATE/queued-nightly.tmp" && mv "$STATE/queued-nightly.tmp" "$STATE/queued-nightly"
"$CI_HOME/bin/worker.sh" &
for r in ${SX_CI_REMOTES:-}; do "$CI_HOME/bin/remote.sh" "$r" nightly "$sha" >> "$STATE/remote-$r.log" 2>&1 & done
wait
