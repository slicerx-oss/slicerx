#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Builds an Android APK on the build machine. Usage: scripts/android-build.sh [debug|release]
# debug is the development build (needs Metro). release bundles the JavaScript and is what the
# end-to-end tests and screenshots use. Both are signed with the debug keystore Expo generates.
# Each build first removes the previous APKs and the Gradle build cache entries older than 14 days on the build machine.
set -eu
host="${BUILD_HOST:?Set BUILD_HOST to the ssh host of the build Mac, for example BUILD_HOST=build-mac}"
variant="${1:-release}"
task=assemble$(printf %s "$variant" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')
ssh "$host" ". slicerx-build/editions/slicerx/apps/mobile/scripts/remote-env.sh
  find \"\$HOME\"/.gradle/caches/build-cache-* -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf {} + 2>/dev/null || true
  cd \"\$APP_DIR/android\" && echo \"sdk.dir=\$ANDROID_HOME\" > local.properties &&
  rm -rf app/build/outputs/apk &&
  ./gradlew $task -PreactNativeArchitectures=arm64-v8a --no-daemon &&
  ls -l app/build/outputs/apk/$variant/"
