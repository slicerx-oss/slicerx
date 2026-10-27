#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Installs the system libraries the desktop shell (slicerx-desktop) links on a hosted Linux runner.
#
#   scripts/ci/apt-desktop-libs.sh
#
# A hosted runner sometimes stalls on the package mirror for ten minutes or more (the same step took 27 s on one runner
# and 1254 s on another started at the same moment). One apt-get update, then up to three tries of apt-get install, each
# cut off after 150 s, so a hung connection is dropped and retried on a new one instead of waiting out the job's limit.
# apt itself also retries a failed download three times and gives up on a silent connection after 30 s. The time
# before and after each command is printed, so a stall shows which one hung. The workflow gives the step 10 minutes.
set -uo pipefail

sudo=""
[ "$(id -u)" = 0 ] || sudo=sudo
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30)
packages=(libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev)

stamp() { echo "$(date -u +%H:%M:%S) $*"; }

stamp "apt-get update"
timeout 120 $sudo apt-get "${opts[@]}" update || stamp "apt-get update did not finish (status $?), trying the install anyway"
stamp "apt-get update done"

for try in 1 2 3; do
  stamp "apt-get install, try $try of 3"
  timeout 150 $sudo apt-get "${opts[@]}" install -y --no-install-recommends "${packages[@]}"
  status=$?
  if [ "$status" = 0 ]; then
    stamp "apt-get install done"
    exit 0
  fi
  stamp "apt-get install try $try ended with status $status"
  [ "$try" = 3 ] || sleep 5
done
echo "apt-desktop-libs: the desktop shell libraries did not install in three tries" >&2
exit 1
