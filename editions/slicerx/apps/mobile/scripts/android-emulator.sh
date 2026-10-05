#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Boots the headless emulator on the build machine and waits for it. Usage: scripts/android-emulator.sh [start|stop]
set -eu
host="${BUILD_HOST:?Set BUILD_HOST to the ssh host of the build Mac, for example BUILD_HOST=build-mac}"
ssh "$host" ". slicerx-build/editions/slicerx/apps/mobile/scripts/remote-env.sh
  case '${1:-start}' in
    stop) adb emu kill || true ;;
    *)
      if [ \"\$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')\" != 1 ]; then
        nohup emulator -avd \"\$AVD\" -no-window -no-audio -no-snapshot -gpu swiftshader_indirect >/tmp/emulator.log 2>&1 &
        i=0; until [ \"\$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')\" = 1 ]; do
          i=\$((i+1)); [ \$i -gt 90 ] && { echo 'emulator did not boot' >&2; exit 1; }; sleep 5
        done
      fi
      echo emulator ready ;;
  esac"
