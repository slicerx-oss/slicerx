#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Generates ios/ and android/ on the build machine. Usage: scripts/prebuild.sh [ios|android]
# With no argument both platforms are generated. Runs on the laptop, executes on the build machine.
set -eu
host="${BUILD_HOST:?Set BUILD_HOST to the ssh host of the build Mac, for example BUILD_HOST=build-mac}"
ssh "$host" ". slicerx-build/editions/slicerx/apps/mobile/scripts/remote-env.sh
  cd \"\$APP_DIR\" && pnpm exec expo prebuild --clean ${1:+--platform $1}"
