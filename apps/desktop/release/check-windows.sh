#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Type-checks the desktop app for x86_64-pc-windows-msvc from macOS or Linux.
# Only `cargo check`: nothing is linked and no Windows binary is produced.
# One-time setup:  brew install llvm nasm && cargo install xwin --locked
#                  rustup target add x86_64-pc-windows-msvc
# Usage: apps/desktop/release/check-windows.sh [extra cargo args]
set -eu
root=$(cd "$(dirname "$0")/../../.." && pwd)
xwin="${XWIN_DIR:-$HOME/.cache/xwin}"
export PATH="$(brew --prefix llvm 2>/dev/null || echo /usr)/bin:$HOME/.cargo/bin:$PATH"
[ -d "$xwin/crt" ] || xwin --accept-license --arch x86_64 --variant desktop splat --output "$xwin"
export CC_x86_64_pc_windows_msvc=clang-cl AR_x86_64_pc_windows_msvc=llvm-lib RC_x86_64_pc_windows_msvc=llvm-rc
export CFLAGS_x86_64_pc_windows_msvc="-Wno-everything /imsvc $xwin/crt/include /imsvc $xwin/sdk/include/ucrt /imsvc $xwin/sdk/include/um /imsvc $xwin/sdk/include/shared"
cd "$root"
exec nice -n 19 cargo check --locked -p slicerx-desktop --target x86_64-pc-windows-msvc "$@"
