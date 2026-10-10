#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Runs a CI tier on a remote machine over ssh and reports its summary from here, so the remote needs no Discord or
# board access. The commit travels as a git bundle on stdin (only what the remote lacks after the first hand-over);
# the remote keeps its own bare repo, checkout, logs and green sha under its CI home and runs that commit's scripts/ci.
#
#   remote.sh <name> per-merge|nightly <sha>
#
# ci.env names the remote's shell and CI home, for example for WSL behind a Windows ssh login:
#   SX_CI_REMOTE_pc_wsl="ssh user@host wsl -d Ubuntu-24.04 -- bash -lc"
#   SX_CI_REMOTE_HOME_pc_wsl=/root/builds/ci
# The shell gets one double-quoted bash string, the form a Windows login shell passes to wsl intact.
set -uo pipefail
name=$1 tier=$2 sha=$3
CI_HOME=${SX_CI_HOME:-$HOME/ci}
[ -f "$CI_HOME/ci.env" ] && . "$CI_HOME/ci.env"
REPO=${SX_CI_REPO:-$CI_HOME/slicerx.git}
STATE=$CI_HOME/state; mkdir -p "$STATE"
shell_var="SX_CI_REMOTE_${name//-/_}"; home_var="SX_CI_REMOTE_HOME_${name//-/_}"
shell=${!shell_var:-}; rhome=${!home_var:-/root/builds/ci}
[ -n "$shell" ] || { echo "remote.sh: no $shell_var in ci.env" >&2; exit 2; }

# One remote run at a time per remote; a newer sha waits for the lock rather than running on top.
lock=$STATE/remote-$name.lock
for _ in $(seq 720); do mkdir "$lock" 2>/dev/null && break; sleep 10; done
bundle=$(mktemp -t sxci)
trap 'rm -rf "$lock" "$bundle"' EXIT

# The bundle: the commit as refs/heads/ci-tip, minus what the remote got at the last hand-over.
git -C "$REPO" update-ref refs/heads/ci-tip "$sha" || { echo "remote.sh: unknown sha $sha" >&2; exit 1; }
sent=$(cat "$STATE/remote-$name.sent" 2>/dev/null || true)
excl=()
if [ -n "$sent" ] && [ "$sent" != "$sha" ] && git -C "$REPO" merge-base --is-ancestor "$sent" "$sha" 2>/dev/null; then
  excl=("^$sent")
fi
git -C "$REPO" bundle create -q "$bundle" refs/heads/ci-tip ${excl[@]+"${excl[@]}"} || { echo "remote.sh: bundle failed" >&2; exit 1; }

# The remote half: take the bundle from stdin, update its repo, install that commit's runner and run it. It goes
# over first as base64, since a multi-line script does not survive a Windows login shell and wsl intact.
read -r -d '' step <<EOS
set -u
H=$rhome
mkdir -p "\$H/bin" "\$H/state"
cat > "\$H/incoming.bundle"
[ -d "\$H/slicerx.git" ] || git init -q --bare "\$H/slicerx.git"
git -C "\$H/slicerx.git" fetch -q "\$H/incoming.bundle" +refs/heads/ci-tip:refs/heads/ci-tip || exit 3
for f in run.sh worker.sh; do git -C "\$H/slicerx.git" show $sha:scripts/ci/\$f > "\$H/bin/\$f" 2>/dev/null && chmod +x "\$H/bin/\$f"; done
# heavy.sh is the machine's own lock, shared with everything else that runs there, and its owner deploys it: never
# replace it with the copy in the commit under test (an old commit put back an old lock without slots). Only a remote
# without one gets it.
[ -s "\$H/bin/heavy.sh" ] || { git -C "\$H/slicerx.git" show $sha:scripts/ci/heavy.sh > "\$H/bin/heavy.sh" 2>/dev/null && chmod +x "\$H/bin/heavy.sh"; }
if [ -s "\$H/bin/heavy.sh" ] && [ -x "\$H/bin/heavy.sh" ]; then SX_CI_HOME="\$H" SX_CI_NOTIFY= "\$H/bin/heavy.sh" "\$H/bin/run.sh" $tier $sha
else SX_CI_HOME="\$H" SX_CI_NOTIFY= "\$H/bin/run.sh" $tier $sha; fi
EOS
b64=$(printf '%s\n' "$step" | base64 | tr -d '\n')
$shell "\"mkdir -p $rhome/bin && echo $b64 | base64 -d > $rhome/bin/remote-step.sh\"" \
  || { echo "remote.sh: cannot reach $name" >&2; exit 1; }
out=$($shell "\"bash $rhome/bin/remote-step.sh\"" < "$bundle" 2>&1); rc=$?

# Exit 3: the bundle never landed. Anything that produced a summary means the remote has the commit now.
summary=$(sed -n '/^SlicerX CI /,$p' <<< "$out")
if [ $rc -ne 3 ] && [ -n "$summary" ]; then echo "$sha" > "$STATE/remote-$name.sent"; fi
[ -n "$summary" ] || summary="SlicerX CI ERROR: $name $tier ${sha:0:8}: the remote run did not finish (rc $rc). $(tail -n 2 <<< "$out" | tr '\n' ' ' | cut -c1-200)"
echo "$summary"
if [ -n "${SX_CI_NOTIFY:-}" ]; then
  # shellcheck disable=SC2086
  $SX_CI_NOTIFY "[$name] $summary" || echo "remote.sh: notify failed" >&2
fi
