#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Sets up the CI home on this machine (default ~/ci): the bare repo that takes pushes, its post-receive hook, the
# runner scripts in bin/, and a ci.env to fill in. Run it again after scripts/ci changes to update bin/ and the hook.
# It schedules nothing: the nightly job is a separate, explicit step (scripts/ci/launchd.plist.example).
set -euo pipefail
src=$(cd "$(dirname "$0")" && pwd)
CI_HOME=${SX_CI_HOME:-$HOME/ci}
mkdir -p "$CI_HOME/bin" "$CI_HOME/logs" "$CI_HOME/state"
[ -d "$CI_HOME/slicerx.git" ] || git init -q --bare "$CI_HOME/slicerx.git"
git -C "$CI_HOME/slicerx.git" symbolic-ref HEAD "${SX_CI_BRANCH:-refs/heads/wip/2026-10-01-checkpoint}"
for f in run.sh worker.sh nightly.sh remote.sh heavy.sh; do install -m 755 "$src/$f" "$CI_HOME/bin/$f"; done
install -m 755 "$src/post-receive" "$CI_HOME/slicerx.git/hooks/post-receive"
if [ ! -f "$CI_HOME/ci.env" ]; then
  cat > "$CI_HOME/ci.env" <<'EOF'
# CI settings for this machine. Not in the repo: paths, hosts and the notify command are local.
# SX_CI_BRANCH=refs/heads/wip/2026-10-01-checkpoint
# SX_CI_NODE_BIN=/opt/homebrew/opt/node@24/bin
# SX_CI_NOTIFY=$HOME/ci/bin/notify.sh        # gets the summary text as its one argument
# SX_CI_BENCH=1                               # only on the speed benchmark's reference machine
# SX_CI_REMOTES="pc-wsl"
# SX_CI_REMOTE_pc_wsl="ssh user@host wsl -d Ubuntu-24.04 -- bash -lc"
# SX_CI_REMOTE_HOME_pc_wsl=/root/builds/ci
# SX_HEAVY_LOCK=/mnt/c/Users/<user>/.slicerx-heavy.lock   # WSL on Windows: share the Windows side's heavy lock
EOF
fi
echo "CI home: $CI_HOME"
echo "push to: $(hostname -s):$CI_HOME/slicerx.git (branch ${SX_CI_BRANCH:-wip/2026-10-01-checkpoint})"
