#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Copies the repo to the build machine and installs the phone app's dependencies there.
# The generated ios/ and android/ folders live only on the build machine and are left alone (scripts/prebuild.sh recreates them).
# Runs on the laptop at low priority. Usage: scripts/sync-to-remote.sh [--no-install]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../../.." && pwd)
host="${BUILD_HOST:?Set BUILD_HOST to the ssh host of the build Mac, for example BUILD_HOST=build-mac}"
m=editions/slicerx/apps/mobile
nice -n 19 rsync -a --delete \
  --exclude node_modules --exclude target --exclude .git --exclude .tools-venv \
  --exclude film --exclude examples --exclude .locks --exclude .expo \
  --exclude "$m/ios" --exclude "$m/android" \
  "$root/" "$host:slicerx-build/"
[ "${1:-}" = "--no-install" ] && exit 0
ssh "$host" '. slicerx-build/editions/slicerx/apps/mobile/scripts/remote-env.sh
  cd "$REMOTE_ROOT" && sh scripts/with-lock.sh pnpm install --filter "@slicerx/mobile..." --frozen-lockfile'
