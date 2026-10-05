# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Sourced by the other scripts. Runs on the build machine, never on the laptop.
# Override any value from the environment.
export PATH="/opt/homebrew/opt/openjdk@17/bin:/opt/homebrew/bin:$HOME/.maestro/bin:$PATH"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
export LANG=en_US.UTF-8 CI=1 EXPO_NO_TELEMETRY=1 MAESTRO_CLI_NO_ANALYTICS=1
REMOTE_ROOT="${REMOTE_ROOT:-$HOME/slicerx-build}"
APP_DIR="$REMOTE_ROOT/editions/slicerx/apps/mobile"
IOS_DEVICE="${IOS_DEVICE:-slicerx-iphone}"
AVD="${AVD:-slicerx-pixel}"
APP_ID="${APP_ID:-app.slicerx.mobile}"
SHOTS="${SHOTS:-$HOME/slicerx-shots}"
